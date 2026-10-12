// 마우스 테스트: 더블클릭(채터링), 버튼, 휠 검사와 보고율 측정.
// 브라우저가 받는 입력만 쓰므로 기기 연결 없이 어떤 마우스에서도 동작한다.
(function (OMM) {
  'use strict';

  const h = OMM.h;
  const BUTTON_NAMES = ['왼쪽', '휠 클릭', '오른쪽', '뒤로', '앞으로']; // MouseEvent.button 순서
  const DEFAULT_THRESHOLD_MS = 30;
  const MIN_PRESSES_FOR_VERDICT = 30;
  const WHEEL_BURST_MS = 300; // 이 간격 안에 이어지는 휠 입력을 한 번의 굴림으로 본다
  const LOG_LIMIT = 30;
  const RATE_WINDOW_MS = 1000; // 보고율은 최근 1초 동안 들어온 이동 입력 수로 잰다
  const RATE_MIN_SPAN_MS = 500; // 이보다 짧게 움직인 구간은 값이 튀므로 재지 않는다
  const RATE_IDLE_MS = 200; // 이 시간 동안 이동이 없으면 멈춘 것으로 본다
  const STANDARD_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

  // ---------- 판정 로직 (DOM과 무관) ----------

  function createButtonStats() {
    return { presses: 0, suspects: 0, minGap: null, minHold: null, lastDown: null, lastUp: null, down: false };
  }

  // 눌림을 기록한다. 직전에 뗀 뒤 threshold(ms) 이내에 다시 눌렸으면 그 간격을, 아니면 null을 돌려준다.
  // 스위치 접점이 튀면 한 번의 클릭이나 누르고 있는 도중에 "뗌 → 눌림"이 몇 ms 간격으로 끼어든다.
  function recordDown(s, t, threshold) {
    const gap = s.lastUp === null ? null : t - s.lastUp;
    s.presses += 1;
    s.down = true;
    s.lastDown = t;
    if (gap === null) return null;
    s.minGap = s.minGap === null ? gap : Math.min(s.minGap, gap);
    if (gap > threshold) return null;
    s.suspects += 1;
    return gap;
  }

  function recordUp(s, t) {
    if (s.down && s.lastDown !== null) {
      const hold = t - s.lastDown;
      s.minHold = s.minHold === null ? hold : Math.min(s.minHold, hold);
    }
    s.down = false;
    s.lastUp = t;
  }

  function createWheelStats() {
    return { up: 0, down: 0, left: 0, right: 0, reversals: 0, recent: [] };
  }

  // 세로 휠 입력을 기록한다. 같은 방향으로 굴리는 도중 반대 방향이 한 번 끼어든 경우(A, B, A)를 튐으로 센다.
  // dir: -1 위, +1 아래. 튐이 감지되면 true.
  function recordWheel(w, dir, t) {
    w[dir < 0 ? 'up' : 'down'] += 1;
    const [a, b] = w.recent; // 최근 두 입력 (오래된 것, 직전 것)
    const jumped = w.recent.length === 2 && t - b.t <= WHEEL_BURST_MS && b.t - a.t <= WHEEL_BURST_MS && a.dir === dir && b.dir !== dir;
    if (jumped) w.reversals += 1;
    w.recent = [...w.recent, { dir, t }].slice(-2);
    return jumped;
  }

  function createRateStats() {
    return { times: [], start: 0, current: null, peak: 0, total: 0 };
  }

  // 이동 입력 하나를 기록하고 최근 구간의 보고율(Hz)을 갱신한다. 마우스는 움직일 때만 보고하므로
  // 끊김 없이 움직인 구간에서만 값이 의미가 있고, 그중 가장 높게 나온 값이 실제 보고율에 가깝다.
  function recordMove(r, t) {
    const times = r.times;
    if (times.length && t - times[times.length - 1] > RATE_IDLE_MS) {
      times.length = 0;
      r.start = 0;
    }
    times.push(t);
    // 8000Hz에서도 부담이 없도록 앞에서 지우지 않고 시작 위치만 옮기다가 가끔 한꺼번에 정리한다.
    while (t - times[r.start] > RATE_WINDOW_MS) r.start += 1;
    if (r.start > 4096) {
      times.splice(0, r.start);
      r.start = 0;
    }
    r.total += 1;
    const span = t - times[r.start];
    r.current = span >= RATE_MIN_SPAN_MS ? ((times.length - 1 - r.start) / span) * 1000 : null;
    if (r.current !== null) r.peak = Math.max(r.peak, r.current);
    return r.current;
  }

  // 측정값에 가장 가까운 표준 보고율. 너무 낮으면(천천히 움직였으면) null.
  function nearestStandardRate(hz) {
    if (hz < STANDARD_RATES[0] * 0.7) return null;
    return STANDARD_RATES.reduce((best, s) => (Math.abs(Math.log(hz / s)) < Math.abs(Math.log(hz / best)) ? s : best));
  }

  // ---------- 화면 ----------

  const state = { threshold: DEFAULT_THRESHOLD_MS, buttons: [], wheel: null, rate: null, log: [] };
  const els = { tiles: [], stats: [] };
  const ms = (v) => (v === null ? '–' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

  function reset() {
    state.buttons = BUTTON_NAMES.map(createButtonStats);
    state.wheel = createWheelStats();
    state.rate = createRateStats();
    state.log = [];
    update();
  }

  function addLog(kind, text) {
    state.log.unshift({ kind, text, time: new Date().toLocaleTimeString() });
    state.log.length = Math.min(state.log.length, LOG_LIMIT);
  }

  function verdict() {
    const presses = state.buttons.reduce((n, s) => n + s.presses, 0);
    const suspects = state.buttons.reduce((n, s) => n + s.suspects, 0);
    if (suspects) return ['bad', `의심되는 재입력 ${suspects}회`, '한 번 누른 클릭이 여러 번 입력됐을 수 있습니다. 같은 버튼에서 반복되면 스위치 채터링(더블클릭 고장)을 의심해 볼 만합니다.'];
    if (state.wheel.reversals) return ['bad', `휠 역방향 튐 ${state.wheel.reversals}회`, '한 방향으로 굴렸는데 반대 방향 입력이 섞였습니다. 휠 엔코더 불량의 대표적인 증상입니다.'];
    if (presses < MIN_PRESSES_FOR_VERDICT) return ['idle', '검사 중', `판단하려면 클릭이 더 필요합니다. 검사할 버튼을 ${MIN_PRESSES_FOR_VERDICT}회 이상 눌러 보세요.`];
    return ['good', '이상 없음', `${presses}회 클릭하는 동안 의심되는 재입력이 없었습니다.`];
  }

  function update() {
    state.buttons.forEach((s, i) => {
      els.tiles[i].className = 'test-tile' + (s.down ? ' down' : '') + (s.suspects ? ' bad' : s.presses ? ' seen' : '');
      const [presses, suspects, gap, hold] = els.stats[i];
      presses.textContent = s.presses;
      suspects.textContent = s.suspects;
      suspects.className = s.suspects ? 'bad' : '';
      gap.textContent = ms(s.minGap);
      hold.textContent = ms(s.minHold);
    });
    const w = state.wheel;
    els.wheelUp.textContent = w.up;
    els.wheelDown.textContent = w.down;
    els.wheelTilt.textContent = `${w.left} / ${w.right}`;
    els.wheelRev.textContent = w.reversals;
    els.wheelRev.className = w.reversals ? 'bad' : '';
    updateRate();
    const [kind, title, detail] = verdict();
    els.verdict.className = 'test-verdict ' + kind;
    els.verdict.replaceChildren(h('strong', null, title), h('span', null, detail));
    els.log.replaceChildren(...(state.log.length
      ? state.log.map((e) => h('li', { class: e.kind }, h('time', null, e.time), e.text))
      : [h('li', { class: 'empty' }, '의심되는 입력이 생기면 여기에 기록됩니다.')]));
  }

  function updateRate() {
    const r = state.rate;
    const hz = (v) => (v ? `${Math.round(v)} Hz` : '–');
    const guess = nearestStandardRate(r.peak);
    els.rateNow.textContent = hz(r.current);
    els.ratePeak.textContent = hz(r.peak);
    els.rateGuess.textContent = guess ? `${guess} Hz` : '–';
  }

  // 이동 입력은 초당 수천 번 올 수 있으므로 화면은 프레임마다 한 번만 고친다.
  let rateFrame = 0;
  function onMove(e) {
    if (!inTestView()) return;
    const r = state.rate;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) recordMove(r, ev.timeStamp);
    if (!rateFrame) rateFrame = requestAnimationFrame(() => { rateFrame = 0; updateRate(); });
  }

  function onMouseDown(e) {
    e.preventDefault(); // 휠 클릭 자동 스크롤, 텍스트 선택 방지
    const s = state.buttons[e.button];
    if (!s) return;
    const gap = recordDown(s, e.timeStamp, state.threshold);
    if (gap !== null) addLog('bad', `${BUTTON_NAMES[e.button]} 버튼: 뗀 지 ${ms(gap)} 만에 다시 눌림`);
    update();
  }

  function onMouseUp(e) {
    const s = state.buttons[e.button];
    if (!s || !s.down) return;
    e.preventDefault();
    recordUp(s, e.timeStamp);
    update();
  }

  function onWheel(e) {
    e.preventDefault();
    const w = state.wheel;
    if (e.deltaY) {
      const dir = e.deltaY < 0 ? -1 : 1;
      if (recordWheel(w, dir, e.timeStamp)) addLog('bad', `휠: ${dir < 0 ? '위' : '아래'}로 굴리는 중 반대 방향 입력`);
      els.wheelMark.textContent = dir < 0 ? '▲' : '▼';
    }
    if (e.deltaX) w[e.deltaX < 0 ? 'left' : 'right'] += 1;
    update();
  }

  function build(root) {
    const statCells = () => [h('td', null), h('td', null), h('td', null), h('td', null)];
    els.stats = BUTTON_NAMES.map(statCells);
    els.tiles = BUTTON_NAMES.map((name) => h('div', { class: 'test-tile' }, name));
    els.wheelMark = h('span', { class: 'wheel-mark' }, '•');
    els.verdict = h('div', { class: 'test-verdict' });
    els.log = h('ul', { class: 'test-log' });
    const cell = (key) => (els[key] = h('td', null));

    const pad = h('div', {
      class: 'test-pad', tabindex: 0,
      onmousedown: onMouseDown,
      oncontextmenu: (e) => e.preventDefault(),
      onauxclick: (e) => e.preventDefault(),
      ondblclick: (e) => e.preventDefault(),
    },
      h('p', { class: 'test-pad-title' }, '이 영역 위에서 클릭하고 휠을 굴리세요'),
      h('div', { class: 'test-tiles' }, els.tiles),
      h('div', { class: 'test-wheel' }, '휠 ', els.wheelMark));
    pad.addEventListener('wheel', onWheel, { passive: false });

    const threshold = h('input', {
      type: 'number', min: 5, max: 150, step: 5, value: state.threshold, id: 'test-threshold',
      onchange: (e) => {
        state.threshold = Math.min(150, Math.max(5, Number(e.target.value) || DEFAULT_THRESHOLD_MS));
        e.target.value = state.threshold;
      },
    });

    root.replaceChildren(
      h('div', { class: 'test-head' },
        h('div', null,
          h('h2', null, '마우스 테스트'),
          h('p', { class: 'hint' }, '더블클릭(채터링), 버튼, 휠 이상을 검사하고 보고율을 측정합니다. 기기 연결 없이 어떤 마우스에서도 쓸 수 있습니다.')),
        h('button', { onclick: reset }, '기록 지우기')),
      h('div', { class: 'test-layout' },
        h('div', null, pad, els.verdict),
        h('div', null,
          h('h3', null, '버튼'),
          h('table', { class: 'test-table' },
            h('thead', null, h('tr', null, ['버튼', '클릭', '의심', '최소 재입력 간격', '최단 누름'].map((t) => h('th', null, t)))),
            h('tbody', null, BUTTON_NAMES.map((name, i) => h('tr', null, h('th', null, name), els.stats[i])))),
          h('h3', null, '휠'),
          h('table', { class: 'test-table' },
            h('thead', null, h('tr', null, ['위로', '아래로', '틸트 좌 / 우', '역방향 튐'].map((t) => h('th', null, t)))),
            h('tbody', null, h('tr', null, cell('wheelUp'), cell('wheelDown'), cell('wheelTilt'), cell('wheelRev')))),
          h('h3', null, '보고율'),
          h('table', { class: 'test-table' },
            h('thead', null, h('tr', null, ['현재', '최고', '추정 설정값'].map((t) => h('th', null, t)))),
            h('tbody', null, h('tr', null, cell('rateNow'), cell('ratePeak'), cell('rateGuess')))),
          h('div', { class: 'field test-threshold' },
            h('label', { for: 'test-threshold' }, '판정 기준'),
            threshold,
            h('span', { class: 'hint' }, 'ms 이내에 다시 눌리면 의심으로 기록')),
          h('h3', null, '의심 기록'),
          els.log)),
      h('ul', { class: 'hint' },
        h('li', null, '더블클릭 검사: 각 버튼을 평소처럼 한 번씩 30회 이상 누릅니다. 일부러 빠르게 연타하면 정상 마우스도 의심으로 잡힐 수 있으니, 그럴 때는 판정 기준을 낮추세요.'),
        h('li', null, '드래그 끊김 검사: 버튼을 몇 초간 누르고 있습니다. 누르는 도중 입력이 끊겼다 이어지면 의심으로 기록됩니다.'),
        h('li', null, '휠 검사: 한 방향으로만 천천히 20칸 이상 굴립니다. 반대 방향 입력이 끼어들면 역방향 튐으로 기록됩니다.'),
        h('li', null, '보고율 측정: 이 화면 어디에서든 마우스를 멈추지 않고 빠르게 원을 그리며 2~3초 움직입니다. 마우스는 움직일 때만 신호를 보내므로 「최고」 값이 실제 보고율에 가깝습니다. 2000Hz 이상은 브라우저와 PC 성능에 따라 실제보다 낮게 나올 수 있습니다.'),
        h('li', null, '브라우저는 입력을 운영체제를 거쳐 받으므로 시간에 1~8ms 정도의 오차가 있습니다.')));
  }

  // ---------- 화면 전환 ----------

  const inTestView = () => document.body.classList.contains('view-test');

  function setView(view) {
    document.body.classList.toggle('view-test', view === 'test');
    for (const btn of document.querySelectorAll('#views button')) btn.classList.toggle('active', btn.dataset.view === view);
  }

  function init() {
    build(document.querySelector('#tester'));
    reset();
    for (const btn of document.querySelectorAll('#views button')) btn.addEventListener('click', () => setView(btn.dataset.view));
    // 뗌은 영역 밖에서 일어나도 받아야 눌림 상태가 남지 않는다. 테스트 화면에서는 뒤로/앞으로 버튼의 페이지 이동도 막는다.
    // 보고율은 테스트 화면 전체에서 잰다. pointerrawupdate는 화면 갱신 주기와 무관하게 입력이 들어오는 대로
    // 전달된다 (Chrome 계열). 창 밖으로 나가면 입력이 끊겨 RATE_IDLE_MS 뒤에 구간이 저절로 초기화된다.
    window.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', onMove);
    window.addEventListener('mouseup', (e) => {
      if (!inTestView()) return;
      if (e.button === 3 || e.button === 4) e.preventDefault();
      onMouseUp(e);
    });
  }

  OMM.tester = {
    createButtonStats, recordDown, recordUp, createWheelStats, recordWheel,
    createRateStats, recordMove, nearestStandardRate, state, setView,
  };
  init();
})(window.OMM);
