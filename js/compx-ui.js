// VGN 계열(compx.js) 기기의 설정 화면. 기기에서 읽은 플래시 이미지의 사본을 고치고,
// 「기기에 저장」을 누르면 바뀐 바이트만 기록한 뒤 다시 읽어 대조한다.
(function (OMM) {
  'use strict';

  const C = OMM.compx;
  const { h, choice, toast, busy, ask } = OMM.ui;

  const cx = { dev: null, info: null, extras: null, orig: null, work: null, tab: 'overview' };

  const connected = () => !!cx.work;
  const isDirty = () => connected() && C.diffRuns(cx.orig, cx.work).length > 0;

  async function connect(devices) {
    const dev = new C.CompxDevice(devices);
    if (!dev.dev) throw new Error('선택한 기기에서 설정용 인터페이스(리포트 8)를 찾지 못했습니다.');
    cx.dev = dev;
    await dev.open();
    cx.info = await dev.identify();
    const { image, extras } = await dev.withControl(async () => ({
      image: await dev.readFlash(0, C.IMAGE_LENGTH),
      extras: await dev.readExtras(),
    }));
    // 읽은 값이 이 구조로 말이 되는지 확인한다. 아니면 다른 구조의 기기이므로 건드리지 않는다.
    const m = C.parse(image);
    const sane = C.RATES.includes(m.rate) && m.stageCount >= 1 && m.stageCount <= m.maxStages && m.currentStage < m.stageCount
      && C.LOD.some(([v]) => v === m.lod) && image[C.FLASH.reportRate + 1] === C.check(image[C.FLASH.reportRate]);
    if (!sane) throw new Error(`${dev.name}: 설정 데이터가 알려진 구조와 맞지 않아 지원하지 않는 기기입니다.`);
    Object.assign(cx, { extras, orig: image, work: image.slice(), tab: 'overview' });
  }

  async function disconnect() {
    if (cx.dev) await cx.dev.close().catch(() => {});
    Object.assign(cx, { dev: null, info: null, extras: null, orig: null, work: null });
  }

  const ownsDevice = (device) => !!cx.dev && cx.dev.devices.includes(device);

  // 홈 카드와 상태 줄에 쓰는 요약 (기기에 저장된 값 기준)
  function summary() {
    const m = C.parse(cx.orig);
    return {
      name: cx.dev.name,
      modeText: cx.info.wired ? '유선 연결' : '무선 연결',
      dpi: m.stages[m.currentStage], rate: m.rate,
      profileLabel: cx.extras.profile !== null ? `프로필 ${cx.extras.profile + 1}` : null,
      battery: cx.extras.battery,
    };
  }

  function revert() {
    cx.work.set(cx.orig);
    OMM.ui.refresh();
  }

  async function save() {
    const runs = C.diffRuns(cx.orig, cx.work);
    if (!runs.length) return;
    const m = C.parse(cx.work);
    if (!m.keys.some((k) => k.cls === 1 && k.param === 0x0100)) {
      return toast('왼쪽 클릭이 어느 버튼에도 할당되어 있지 않습니다. 한 버튼에는 왼쪽 클릭을 남겨 두세요.', 'error');
    }
    const ok = await ask('기기에 저장', [
      `변경된 설정을 ${cx.dev.name}의 메모리에 씁니다.`,
      '쓰는 동안 기기를 분리하거나 전원을 끄지 마세요.',
    ], '저장');
    if (!ok) return;
    const done = await busy('저장 중…', () => cx.dev.withControl(async () => {
      for (const run of runs) await cx.dev.writeFlash(run.address, run.bytes);
      const back = await cx.dev.readFlash(0, C.IMAGE_LENGTH);
      // 실제로 기록된 상태를 기준으로 삼는다. 기기가 받아들이지 않은 값은 변경 사항으로 남는다.
      cx.orig = back;
      if (C.diffRuns(back, cx.work).length) throw new Error('일부 값이 기기에 반영되지 않았습니다. 화면에 남은 변경 사항을 확인하세요.');
    }));
    if (done) toast('저장했습니다.', 'ok');
    OMM.ui.refresh();
  }

  // ---------- 화면 ----------

  function edited(rerender = true) {
    OMM.ui.refreshActions();
    if (rerender) render(document.querySelector('#editor'));
  }

  const field = (label, unit, control) => h('div', { class: 'field' }, h('label', null, label, unit && h('small', null, unit)), control);
  const scalar = (address) => (v) => { C.setScalar(cx.work, address, v); edited(); };
  const toggle = (title, desc, checked, address) => h('label', { class: 'hits-toggle' },
    h('div', null, h('div', { class: 'hits-title' }, title), h('div', { class: 'hits-desc' }, desc)),
    h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => scalar(address)(e.target.checked ? 1 : 0) }));
  // 목록에 없는 값이 저장돼 있으면 그대로 보여 주는 선택지를 덧붙인다.
  const withCurrent = (options, current) => (options.some(([v]) => v === current) ? options : [...options, [current, `기타 (${current})`]]);

  function renderOverview(m) {
    const tile = (label, value, sub) => h('div', { class: 'stat' }, h('small', null, label), h('b', null, value), sub && h('span', null, sub));
    const b = cx.extras.battery;
    return h('div', null,
      h('div', { class: 'stat-grid' },
        tile('현재 DPI', m.stages[m.currentStage] ? m.stages[m.currentStage].toLocaleString() : '–', `${m.stageCount}단계 중 ${m.currentStage + 1}단계`),
        tile('보고율', m.rate ? `${m.rate.toLocaleString()} Hz` : '–', cx.info.wired ? '유선' : '무선'),
        tile('배터리', b ? `${b.percent}%` : '–', b && b.charging ? '충전 중' : null),
        tile('디바운스', `${m.debounce} ms`, null)),
      h('p', { class: 'hint' }, '값을 바꾸려면 위의 「성능」과 「버튼」 탭을 여세요. 변경 내용은 「기기에 저장」을 누르기 전까지 기기에 기록되지 않습니다.'));
  }

  function renderPerformance(m) {
    const rates = C.RATES.filter((r) => r <= cx.info.maxRate).map((r) => [C.encodeRate(r), r >= 1000 ? `${r / 1000}K` : String(r)]);
    const setStageCount = (n) => {
      C.setScalar(cx.work, C.FLASH.stageCount, n);
      if (m.currentStage >= n) C.setScalar(cx.work, C.FLASH.currentStage, n - 1);
      edited();
    };
    const rows = m.stages.slice(0, m.stageCount).map((dpi, i) => {
      const number = h('input', {
        type: 'number', min: C.DPI_MIN, max: C.DPI_MAX, step: C.DPI_STEP, value: dpi,
        onchange: (e) => { C.setDpi(cx.work, i, C.snapDpi(Number(e.target.value) || C.DPI_MIN)); edited(); },
      });
      return h('div', { class: 'dpi-row' },
        h('span', { class: 'dpi-idx' }, `${i + 1}단계`),
        h('input', {
          type: 'range', min: C.DPI_MIN, max: Math.max(C.DPI_MAX, dpi), step: C.DPI_STEP, value: dpi,
          oninput: (e) => { const v = C.snapDpi(Number(e.target.value)); C.setDpi(cx.work, i, v); number.value = v; edited(false); },
        }),
        number,
        h('label', null, h('input', { type: 'radio', name: 'cx-stage', checked: i === m.currentStage, onchange: () => scalar(C.FLASH.currentStage)(i) }), ' 현재'));
    });
    return h('div', null,
      field('보고율', 'Hz', choice('보고율', withCurrent(rates, cx.work[C.FLASH.reportRate]), cx.work[C.FLASH.reportRate], false, scalar(C.FLASH.reportRate))),
      field('리프트오프 거리', null, choice('리프트오프 거리', withCurrent(C.LOD, m.lod), m.lod, false, scalar(C.FLASH.lod))),
      h('p', { class: 'hint field-desc' }, '마우스를 들어 올렸을 때 추적이 멈추는 높이입니다.'),
      h('h3', null, `DPI 단계 (${C.DPI_MIN}~${C.DPI_MAX.toLocaleString()}, ${C.DPI_STEP} 단위)`),
      rows,
      h('div', { class: 'row-actions' },
        h('button', { disabled: m.stageCount >= m.maxStages, onclick: () => setStageCount(m.stageCount + 1) }, '+ 단계 추가'),
        h('button', { class: 'ghost', disabled: m.stageCount <= 1, onclick: () => setStageCount(m.stageCount - 1) }, '마지막 단계 빼기')),
      h('h3', null, '센서'),
      h('div', { class: 'toggle-list' },
        toggle('모션 싱크', '센서 판독을 보고 주기에 맞춥니다.', m.motionSync, C.FLASH.motionSync),
        toggle('각도 스냅', '직선에 가까운 움직임을 곧게 보정합니다.', m.angleSnap, C.FLASH.angleSnap),
        toggle('리플 컨트롤', '높은 DPI에서 생기는 미세한 떨림을 줄입니다.', m.ripple, C.FLASH.ripple)));
  }

  function renderButtons(m) {
    const debounce = [...Array(C.DEBOUNCE_MAX + 1).keys()].map((v) => [v, String(v)]);
    return h('div', null,
      field('디바운스', 'ms', choice('디바운스', withCurrent(debounce, m.debounce), m.debounce, false, scalar(C.FLASH.debounce))),
      h('p', { class: 'hint field-desc' }, '클릭 뒤 이 시간 동안은 같은 버튼의 추가 입력을 무시합니다. 더블클릭(채터링)이 생기면 값을 올리고, 반응을 빠르게 하려면 낮춥니다.'),
      h('table', { class: 'buttons' },
        h('thead', null, h('tr', null, ['버튼', '현재 동작', '바꿀 동작'].map((t) => h('th', null, t)))),
        h('tbody', null, m.keys.map((key, i) => {
          const known = C.KEY_ACTIONS.findIndex(([cls, param]) => cls === key.cls && param === key.param);
          return h('tr', null,
            h('td', { class: 'btn-idx' }, C.BUTTON_NAMES[i]),
            h('td', { class: 'btn-desc' }, C.keyLabel(key)),
            h('td', null, h('select', {
              onchange: (e) => { const [cls, param] = C.KEY_ACTIONS[Number(e.target.value)]; C.setKey(cx.work, i, cls, param); edited(); },
            },
              known < 0 && h('option', { value: -1, selected: true, disabled: true }, C.keyLabel(key)),
              C.KEY_ACTIONS.map(([, , label], idx) => h('option', { value: idx, selected: idx === known }, label)))));
        }))));
  }

  function renderAdvanced(m) {
    // 절전 시간은 두 주소(절전, 성능 모드 시간)에 같은 값으로 저장된다.
    const setSleep = (v) => { C.setScalar(cx.work, C.FLASH.sleep, v); C.setScalar(cx.work, C.FLASH.performanceTime, v); edited(); };
    const info = [
      ['기기', cx.dev.name],
      ['연결', cx.info.wired ? '유선' : '무선 (수신기)'],
      ['최대 보고율', `${cx.info.maxRate.toLocaleString()} Hz`],
      ['펌웨어', [cx.extras.firmware && `마우스 ${cx.extras.firmware}`, cx.extras.dongleFirmware && `수신기 ${cx.extras.dongleFirmware}`].filter(Boolean).join(', ') || '알 수 없음'],
      ['기기 식별값', `CID 0x${cx.info.cid.toString(16)} · MID 0x${cx.info.mid.toString(16)} · 종류 ${cx.info.type}`],
    ];
    return h('div', null,
      field('자동 절전', null, choice('자동 절전', withCurrent(C.SLEEP, m.sleep), m.sleep, false, setSleep)),
      h('p', { class: 'hint field-desc' }, '이 시간 동안 움직임이 없으면 마우스가 절전 상태로 들어갑니다.'),
      h('h3', null, '기기 정보'),
      h('table', { class: 'info' }, info.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))));
  }

  function render(root) {
    const m = C.parse(cx.work);
    const tabs = [['overview', '개요'], ['performance', '성능'], ['buttons', '버튼'], ['advanced', '고급']];
    const body = cx.tab === 'performance' ? renderPerformance(m) : cx.tab === 'buttons' ? renderButtons(m)
      : cx.tab === 'advanced' ? renderAdvanced(m) : renderOverview(m);
    root.replaceChildren(
      h('div', { class: 'editor-head' }, h('h2', null, cx.dev.name)),
      h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', {
        class: id === cx.tab ? 'active' : '', onclick: () => { cx.tab = id; render(root); },
      }, label))),
      h('div', { class: 'panel' }, body));
  }

  OMM.compxUi = { connected, isDirty, connect, disconnect, ownsDevice, summary, save, revert, render, state: cx };
})(window.OMM);
