// 마우스 테스트: 더블클릭(채터링), 버튼, 휠 검사와 보고율 측정, DPI·센서 기울기 측정.
// 브라우저가 받는 입력만 쓰므로 기기 연결 없이 어떤 마우스에서도 동작한다.
import { t, num } from './i18n.js';
import { h, $ } from './ui.js';

const BUTTON_NAMES = ['왼쪽', '휠 클릭', '오른쪽', '뒤로', '앞으로']; // MouseEvent.button 순서
const DEFAULT_THRESHOLD_MS = 30;
const MIN_PRESSES_FOR_VERDICT = 30;
const WHEEL_BURST_MS = 300; // 이 간격 안에 이어지는 휠 입력을 한 번의 굴림으로 본다
const LOG_LIMIT = 30;
const RATE_WINDOW_MS = 1000; // 보고율은 최근 1초 동안 들어온 이동 입력 수로 잰다
const RATE_MIN_SPAN_MS = 500; // 이보다 짧게 움직인 구간은 값이 튀므로 재지 않는다
const RATE_IDLE_MS = 200; // 이 시간 동안 이동이 없으면 멈춘 것으로 본다
const STANDARD_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
const DEFAULT_MEASURE_CM = 10;
const MIN_MEASURE_COUNTS = 200; // 이보다 적게 움직이면 결과를 내지 않는다

// ---------- 판정 로직 (DOM과 무관) ----------

export function createButtonStats() {
  return { presses: 0, suspects: 0, minGap: null, minHold: null, lastDown: null, lastUp: null, down: false };
}

// 눌림을 기록한다. 직전에 뗀 뒤 threshold(ms) 이내에 다시 눌렸으면 그 간격을, 아니면 null을 돌려준다.
// 스위치 접점이 튀면 한 번의 클릭이나 누르고 있는 도중에 "뗌 → 눌림"이 몇 ms 간격으로 끼어든다.
export function recordDown(s, time, threshold) {
  const gap = s.lastUp === null ? null : time - s.lastUp;
  s.presses += 1;
  s.down = true;
  s.lastDown = time;
  if (gap === null) return null;
  s.minGap = s.minGap === null ? gap : Math.min(s.minGap, gap);
  if (gap > threshold) return null;
  s.suspects += 1;
  return gap;
}

export function recordUp(s, time) {
  if (s.down && s.lastDown !== null) {
    const hold = time - s.lastDown;
    s.minHold = s.minHold === null ? hold : Math.min(s.minHold, hold);
  }
  s.down = false;
  s.lastUp = time;
}

export function createWheelStats() {
  return { up: 0, down: 0, left: 0, right: 0, reversals: 0, recent: [] };
}

// 세로 휠 입력을 기록한다. 같은 방향으로 굴리는 도중 반대 방향이 한 번 끼어든 경우(A, B, A)를 튐으로 센다.
// dir: -1 위, +1 아래. 튐이 감지되면 true.
export function recordWheel(w, dir, time) {
  w[dir < 0 ? 'up' : 'down'] += 1;
  const [a, b] = w.recent; // 최근 두 입력 (오래된 것, 직전 것)
  const jumped = w.recent.length === 2 && time - b.t <= WHEEL_BURST_MS && b.t - a.t <= WHEEL_BURST_MS && a.dir === dir && b.dir !== dir;
  if (jumped) w.reversals += 1;
  w.recent = [...w.recent, { dir, t: time }].slice(-2);
  return jumped;
}

export function createRateStats() {
  return { times: [], start: 0, current: null, peak: 0, total: 0 };
}

// 이동 입력 하나를 기록하고 최근 구간의 보고율(Hz)을 갱신한다. 마우스는 움직일 때만 보고하므로
// 끊김 없이 움직인 구간에서만 값이 의미가 있고, 그중 가장 높게 나온 값이 실제 보고율에 가깝다.
export function recordMove(r, time) {
  const times = r.times;
  if (times.length && time - times[times.length - 1] > RATE_IDLE_MS) {
    times.length = 0;
    r.start = 0;
  }
  times.push(time);
  // 8000Hz에서도 부담이 없도록 앞에서 지우지 않고 시작 위치만 옮기다가 가끔 한꺼번에 정리한다.
  while (time - times[r.start] > RATE_WINDOW_MS) r.start += 1;
  if (r.start > 4096) {
    times.splice(0, r.start);
    r.start = 0;
  }
  r.total += 1;
  const span = time - times[r.start];
  r.current = span >= RATE_MIN_SPAN_MS ? ((times.length - 1 - r.start) / span) * 1000 : null;
  if (r.current !== null) r.peak = Math.max(r.peak, r.current);
  return r.current;
}

// 측정값에 가장 가까운 표준 보고율. 너무 낮으면(천천히 움직였으면) null.
export function nearestStandardRate(hz) {
  if (hz < STANDARD_RATES[0] * 0.7) return null;
  return STANDARD_RATES.reduce((best, s) => (Math.abs(Math.log(hz / s)) < Math.abs(Math.log(hz / best)) ? s : best));
}

// 자를 대고 정해진 거리(cm)만큼 가로로 곧게 움직인 이동량(카운트)으로 실제 DPI와 센서 기울기를 계산한다.
// 방향과 상관없이 오른쪽으로 그은 선으로 바꿔 보고, 오른쪽이 위로 올라가면 + 각도다 (화면 좌표는 아래가 +y).
export function measureResult(dx, dy, cm) {
  const counts = Math.hypot(dx, dy);
  if (!counts || !(cm > 0)) return null;
  const [x, y] = dx < 0 ? [-dx, -dy] : [dx, dy];
  return { counts, dpi: counts / (cm / 2.54), angle: (Math.atan2(-y, x) * 180) / Math.PI };
}

// ---------- 화면 ----------

export const state = {
  threshold: DEFAULT_THRESHOLD_MS, buttons: [], wheel: null, rate: null, log: [],
  measure: { cm: DEFAULT_MEASURE_CM, active: false, raw: false, dx: 0, dy: 0, result: null, error: null },
};
const els = { parts: [], stats: [] };
const ms = (v) => (v === null ? '–' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

function reset() {
  state.buttons = BUTTON_NAMES.map(createButtonStats);
  state.wheel = createWheelStats();
  state.rate = createRateStats();
  state.log = [];
  update();
}

// 기록은 원문과 값으로 남겨 두고 그릴 때 번역한다 (언어를 바꿔도 그대로 보이도록).
function addLog(kind, text, vars) {
  state.log.unshift({ kind, text, vars, time: new Date() });
  state.log.length = Math.min(state.log.length, LOG_LIMIT);
}

function verdict() {
  const presses = state.buttons.reduce((n, s) => n + s.presses, 0);
  const suspects = state.buttons.reduce((n, s) => n + s.suspects, 0);
  if (suspects) return ['bad', t('의심되는 재입력 {n}회', { n: suspects }), t('한 번 누른 클릭이 여러 번 입력됐을 수 있습니다. 같은 버튼에서 반복되면 스위치 채터링(더블클릭 고장)을 의심해 볼 만합니다.')];
  if (state.wheel.reversals) return ['bad', t('휠 역방향 튐 {n}회', { n: state.wheel.reversals }), t('한 방향으로 굴렸는데 반대 방향 입력이 섞였습니다. 휠 엔코더 불량의 대표적인 증상입니다.')];
  if (presses < MIN_PRESSES_FOR_VERDICT) return ['idle', t('검사 중'), t('판단하려면 클릭이 더 필요합니다. 검사할 버튼을 {n}회 이상 눌러 보세요.', { n: MIN_PRESSES_FOR_VERDICT })];
  return ['good', t('이상 없음'), t('{n}회 클릭하는 동안 의심되는 재입력이 없었습니다.', { n: presses })];
}

function update() {
  state.buttons.forEach((s, i) => {
    // SVG 요소는 className에 문자열을 대입할 수 없다.
    els.parts[i].setAttribute('class', 'part' + (s.down ? ' down' : '') + (s.suspects ? ' bad' : s.presses ? ' seen' : ''));
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
    ? state.log.map((e) => h('li', { class: e.kind }, h('time', null, e.time.toLocaleTimeString()), t(e.text, e.vars && translateVars(e.vars))))
    : [h('li', { class: 'empty' }, t('의심되는 입력이 생기면 여기에 기록됩니다.'))]));
}

// 기록에 남긴 값 중 버튼·방향 이름은 원문이라 그릴 때 번역한다.
const translateVars = (vars) => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? t(v) : v]));

function updateRate() {
  const r = state.rate;
  const hz = (v) => (v ? `${num(Math.round(v))} Hz` : '–');
  const guess = nearestStandardRate(r.peak);
  els.rateNow.textContent = hz(r.current);
  els.ratePeak.textContent = hz(r.peak);
  els.rateGuess.textContent = guess ? `${num(guess)} Hz` : '–';
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
  if (gap !== null) addLog('bad', '{button} 버튼: 뗀 지 {gap} 만에 다시 눌림', { button: BUTTON_NAMES[e.button], gap: ms(gap) });
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
    if (recordWheel(w, dir, e.timeStamp)) addLog('bad', '휠: {dir}로 굴리는 중 반대 방향 입력', { dir: dir < 0 ? '위' : '아래' });
    els.wheelMark.textContent = dir < 0 ? '▲' : '▼';
  }
  if (e.deltaX) w[e.deltaX < 0 ? 'left' : 'right'] += 1;
  update();
}

// ---------- DPI·각도 측정 ----------
// 포인터를 잠가 화면 가장자리에 막히지 않은 이동량을 받는다. 가능하면 운영체제의 포인터 속도·가속을
// 거치지 않은 값(unadjustedMovement)을 쓴다. 클릭하거나 Esc를 누르면 측정이 끝난다.

async function startMeasure() {
  const m = state.measure;
  Object.assign(m, { active: false, dx: 0, dy: 0, result: null, error: null });
  try {
    await els.measureArea.requestPointerLock({ unadjustedMovement: true });
    m.raw = true;
  } catch {
    try {
      await els.measureArea.requestPointerLock();
      m.raw = false;
    } catch {
      m.error = '이 브라우저에서는 포인터 잠금을 쓸 수 없어 측정할 수 없습니다.';
    }
  }
  updateMeasure();
}

function onPointerLockChange() {
  const m = state.measure;
  if (document.pointerLockElement === els.measureArea) {
    m.active = true;
  } else if (m.active) {
    m.active = false;
    const r = measureResult(m.dx, m.dy, m.cm);
    m.result = r && r.counts >= MIN_MEASURE_COUNTS ? r : null;
    m.error = m.result ? null : '움직인 거리가 너무 짧습니다. 정한 거리만큼 움직인 뒤 클릭하세요.';
  }
  updateMeasure();
}

let measureFrame = 0;
function onMeasureMove(e) {
  const m = state.measure;
  if (!m.active) return;
  m.dx += e.movementX;
  m.dy += e.movementY;
  if (!measureFrame) measureFrame = requestAnimationFrame(() => { measureFrame = 0; updateMeasure(); });
}

function updateMeasure() {
  const m = state.measure;
  const r = m.result;
  const counts = Math.round(r ? r.counts : Math.hypot(m.dx, m.dy));
  els.measureArea.classList.toggle('active', m.active);
  els.measureArea.textContent = m.active
    ? t('측정 중 · 이동량 {counts} — {cm} cm를 움직였으면 클릭하세요 (Esc로도 끝납니다)', { counts: num(counts), cm: m.cm })
    : t(m.error || (r ? '측정을 마쳤습니다. 다시 재려면 「측정 시작」을 누르세요.' : '「측정 시작」을 누르고 자를 따라 마우스를 가로로 곧게 움직인 뒤 클릭하세요.'));
  els.measureArea.classList.toggle('bad', !m.active && !!m.error);
  els.measureDpi.textContent = r ? num(Math.round(r.dpi)) : '–';
  els.measureCounts.textContent = counts ? num(counts) : '–';
  els.measureAngle.textContent = r ? `${r.angle >= 0 ? '+' : ''}${r.angle.toFixed(1)}°` : '–';
  els.measureNote.hidden = !(r && !m.raw);
}

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

// 위에서 내려다본 마우스 그림. 버튼 다섯 개가 눌리면 색이 바뀐다. parts의 순서는 MouseEvent.button과 같다.
function buildMouse() {
  const part = (attrs) => svg('path', { class: 'part', ...attrs });
  els.parts = [
    part({ d: 'M96 14 C58 16 32 42 32 86 V128 H96 Z' }), // 왼쪽
    svg('rect', { class: 'part', x: 90, y: 44, width: 20, height: 52, rx: 10 }), // 휠 클릭
    part({ d: 'M104 14 C142 16 168 42 168 86 V128 H104 Z' }), // 오른쪽
    svg('rect', { class: 'part', x: 16, y: 178, width: 16, height: 40, rx: 7 }), // 뒤로
    svg('rect', { class: 'part', x: 16, y: 132, width: 16, height: 40, rx: 7 }), // 앞으로
  ];
  const [left, wheel, right, back, forward] = els.parts;
  return svg('svg', { class: 'mouse', viewBox: '0 0 200 300', role: 'img', 'aria-label': t('마우스 버튼 상태') },
    svg('rect', { class: 'body', x: 32, y: 14, width: 136, height: 272, rx: 68 }),
    left, right, back, forward, wheel,
    svg('text', { x: 64, y: 82 }, t('왼쪽')),
    svg('text', { x: 136, y: 82 }, t('오른쪽')),
    svg('text', { x: 100, y: 200 }, t('◀ 앞으로 / 뒤로')));
}

function build(root) {
  const statCells = () => [h('td', null), h('td', null), h('td', null), h('td', null)];
  els.stats = BUTTON_NAMES.map(statCells);
  els.wheelMark = h('span', { class: 'wheel-mark', 'aria-hidden': 'true' }, '•');
  els.verdict = h('div', { class: 'test-verdict', role: 'status', 'aria-live': 'polite' });
  els.log = h('ul', { class: 'test-log', 'aria-live': 'polite' });
  const cell = (key) => (els[key] = h('td', null));
  const rate = (key, label) => h('div', null, h('small', null, label), (els[key] = h('b', null, '–')));

  const pad = h('div', {
    class: 'test-pad', tabindex: 0, role: 'application', 'aria-label': t('이 영역 위에서 클릭하고 휠을 굴리세요'),
    onmousedown: onMouseDown,
    oncontextmenu: (e) => e.preventDefault(),
    onauxclick: (e) => e.preventDefault(),
    ondblclick: (e) => e.preventDefault(),
  },
    h('p', { class: 'test-pad-title' }, t('이 영역 위에서 클릭하고 휠을 굴리세요')),
    buildMouse(),
    h('div', { class: 'test-wheel' }, t('휠') + ' ', els.wheelMark));
  pad.addEventListener('wheel', onWheel, { passive: false });

  const threshold = h('input', {
    type: 'number', min: 5, max: 150, step: 5, value: state.threshold, id: 'test-threshold',
    onchange: (e) => {
      state.threshold = Math.min(150, Math.max(5, Number(e.target.value) || DEFAULT_THRESHOLD_MS));
      e.target.value = state.threshold;
    },
  });

  const distance = h('input', {
    type: 'number', min: 1, max: 50, step: 0.5, value: state.measure.cm, id: 'measure-cm',
    onchange: (e) => {
      state.measure.cm = Math.min(50, Math.max(1, Number(e.target.value) || DEFAULT_MEASURE_CM));
      e.target.value = state.measure.cm;
    },
  });
  els.measureArea = h('div', {
    class: 'measure-area', role: 'status', 'aria-live': 'polite',
    onmousedown: (e) => { if (state.measure.active) { e.preventDefault(); document.exitPointerLock(); } },
  });
  const measureCard = h('section', { class: 'test-card', 'aria-labelledby': 'measure-title' },
    h('h3', { id: 'measure-title' }, t('DPI·센서 각도 측정')),
    h('div', { class: 'field measure-controls' },
      h('label', { for: 'measure-cm' }, t('이동 거리')), distance, h('span', { class: 'hint' }, 'cm'),
      h('button', { onclick: startMeasure }, t('측정 시작'))),
    els.measureArea,
    h('div', { class: 'test-rate' }, rate('measureDpi', t('측정 DPI')), rate('measureCounts', t('이동량')), rate('measureAngle', t('센서 기울기'))),
    (els.measureNote = h('p', { class: 'hint', hidden: true },
      t('이 브라우저는 운영체제의 포인터 속도·가속을 거친 값만 줍니다. Windows 마우스 설정에서 포인터 속도를 가운데(10)로 두고 「포인터 정확도 향상」을 끄면 정확해집니다.'))));

  const th = (x) => h('th', { scope: 'col' }, x);
  root.replaceChildren(
    h('div', { class: 'test-head' },
      h('div', null,
        h('h2', null, t('입력 검사')),
        h('p', { class: 'hint' }, t('더블클릭(채터링), 버튼, 휠 이상을 검사하고 보고율을 측정합니다. 기기 연결 없이 어떤 마우스에서도 쓸 수 있습니다.'))),
      h('button', { onclick: reset }, t('기록 지우기'))),
    els.verdict,
    h('div', { class: 'test-layout' },
      h('div', null, pad, measureCard),
      h('div', null,
        h('section', { class: 'test-card' },
          h('h3', null, t('보고율')),
          h('div', { class: 'test-rate' }, rate('rateNow', t('현재')), rate('ratePeak', t('최고')), rate('rateGuess', t('추정 설정값')))),
        h('section', { class: 'test-card' },
          h('h3', null, t('버튼')),
          h('table', { class: 'test-table' },
            h('thead', null, h('tr', null, [t('버튼'), t('클릭'), t('의심'), t('최소 재입력 간격'), t('최단 누름')].map(th))),
            h('tbody', null, BUTTON_NAMES.map((name, i) => h('tr', null, h('th', { scope: 'row' }, t(name)), els.stats[i])))),
          h('div', { class: 'field test-threshold' },
            h('label', { for: 'test-threshold' }, t('판정 기준')),
            threshold,
            h('span', { class: 'hint' }, t('ms 이내에 다시 눌리면 의심으로 기록')))),
        h('section', { class: 'test-card' },
          h('h3', null, t('휠')),
          h('table', { class: 'test-table' },
            h('thead', null, h('tr', null, [t('위로'), t('아래로'), t('틸트 좌 / 우'), t('역방향 튐')].map(th))),
            h('tbody', null, h('tr', null, cell('wheelUp'), cell('wheelDown'), cell('wheelTilt'), cell('wheelRev'))))),
        h('section', { class: 'test-card' },
          h('h3', null, t('의심 기록')),
          els.log))),
    h('ul', { class: 'hint' },
      h('li', null, t('더블클릭 검사: 각 버튼을 평소처럼 한 번씩 30회 이상 누릅니다. 일부러 빠르게 연타하면 정상 마우스도 의심으로 잡힐 수 있으니, 그럴 때는 판정 기준을 낮추세요.')),
      h('li', null, t('드래그 끊김 검사: 버튼을 몇 초간 누르고 있습니다. 누르는 도중 입력이 끊겼다 이어지면 의심으로 기록됩니다.')),
      h('li', null, t('휠 검사: 한 방향으로만 천천히 20칸 이상 굴립니다. 반대 방향 입력이 끼어들면 역방향 튐으로 기록됩니다.')),
      h('li', null, t('보고율 측정: 이 화면 어디에서든 마우스를 멈추지 않고 빠르게 원을 그리며 2~3초 움직입니다. 마우스는 움직일 때만 신호를 보내므로 「최고」 값이 실제 보고율에 가깝습니다. 2000Hz 이상은 브라우저와 PC 성능에 따라 실제보다 낮게 나올 수 있습니다.')),
      h('li', null, t('DPI·각도 측정: 마우스 패드 위에 자를 놓고, 출발점에서 「측정 시작」을 누른 뒤 정한 거리만큼 자를 따라 가로로 움직이고 클릭합니다. 측정 DPI가 설정한 DPI와 크게 다르면 센서나 표면 문제일 수 있습니다. 센서 기울기는 곧게 그은 선이 화면에서 기운 각도이며, 손목 각도의 영향도 함께 들어갑니다.')),
      h('li', null, t('브라우저는 입력을 운영체제를 거쳐 받으므로 시간에 1~8ms 정도의 오차가 있습니다.'))));
}

// ---------- 화면 전환 ----------

const inTestView = () => document.body.dataset.view === 'test';

// 언어를 바꾸면 화면을 다시 만든다. 측정 기록은 state에 남아 있다.
export function relabel() {
  build($('#tester'));
  update();
  updateMeasure();
}

export function init() {
  build($('#tester'));
  reset();
  updateMeasure();
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMeasureMove);
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
