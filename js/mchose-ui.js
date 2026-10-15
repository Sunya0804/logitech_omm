import { filters, catalog, createClient, changes, saveChanges, knownStatus } from './mchose.js';

const OMM = window.OMM;
const { h, choice, toast, busy, ask, download } = OMM.ui;
const state = { client: null, original: null, work: null, unlocked: false, stale: false, tab: 'overview' };
const connected = () => !!state.original;
const isDirty = () => connected() && changes(state.original, state.work).length > 0;
const canEdit = () => connected() && state.original.ui?.settingsReady && knownStatus(state.original) && state.unlocked && !state.stale;
const clone = value => structuredClone(value);
function accept(status) { state.original = clone(status); state.work = clone(status); state.stale = false; }

async function connect(devices) {
  state.client = createClient(devices);
  await state.client.open();
  accept(await state.client.readStatus());
  state.unlocked = false; state.tab = 'overview';
}
async function disconnect() {
  if (state.client) await state.client.close();
  Object.assign(state, { client: null, original: null, work: null, unlocked: false, stale: false });
}
function summary() {
  const s = state.original;
  return { name: s.name, modeText: s.connectionType === 'Wired' ? '유선 연결' : '무선 연결',
    dpi: s.dpi, rate: s.pollingRateHz, profileLabel: s.activeProfile ? profileName(s, s.activeProfile - 1) : null,
    battery: s.batteryPercent === null ? null : { percent: s.batteryPercent, charging: s.batteryState === 'Charging' } };
}
async function refresh() {
  if (isDirty() && !await ask('다시 읽기', ['저장하지 않은 편집 내용을 버리고 기기 설정을 다시 읽습니다.'], '다시 읽기')) return;
  await busy('MCHOSE 설정 읽는 중…', async () => accept(await state.client.readStatus()));
  OMM.ui.refresh();
}
async function save() {
  if (!canEdit() || !isDirty()) return;
  if (!await ask('기기에 저장', [
    `${state.original.name}에 변경한 설정을 기록하고 다시 읽어 확인합니다.`,
    '기록 중 기기를 분리하지 마세요. 중간에 실패하면 일부 설정만 반영될 수 있습니다.',
  ], '저장')) return;
  const done = await busy('MCHOSE 설정 저장·검증 중…', async () => {
    try { accept(await saveChanges(state.client, state.original, state.work)); }
    catch (error) { state.stale = true; throw error; }
  });
  if (done) toast('저장 후 기기에서 읽은 값이 일치합니다.', 'ok');
  OMM.ui.refresh();
}
function revert() { state.work = clone(state.original); OMM.ui.refresh(); }
async function exportDiagnostics() {
  const done = await busy('MCHOSE 진단 정보 읽는 중…', async () => {
    const status = await state.client.readStatus();
    const d = state.client.device;
    download({ type: 'omm-web-mchose-diagnostics', version: 1, exportedAt: new Date().toISOString(),
      vendorId: d.vendorId, productId: d.productId, productName: d.productName,
      collections: d.collections, family: state.client.family, status,
    }, 'diagnostics', status.name);
  });
  if (done) toast('읽기 전용 진단 정보를 저장했습니다.', 'ok');
}
async function switchProfile(index) {
  if (!canEdit() || OMM.state.busy || index === state.original.activeProfile) return;
  if (!await ask('프로필 전환', ['기기에 즉시 적용됩니다. 저장하지 않은 편집 내용은 버립니다.'], '전환')) return;
  await busy('프로필 전환 중…', async () => {
    try {
      await state.client.setProfile(index);
      const status = await state.client.readStatus();
      if (status.activeProfile !== index) throw new Error('기기가 프로필 전환을 확인하지 않았습니다.');
      accept(status);
    } catch (error) { state.stale = true; throw error; }
  });
  OMM.ui.refresh();
}
function profileName(status, index) {
  const name = status.profileNames?.[index]?.trim();
  return !name || /^(?:Profile|Config|默认板载|默认配置)\s*\d+$/i.test(name) || /[\u0000-\u001f\u007f\ufffd]/.test(name)
    ? `프로필 ${index + 1}` : name;
}
function renderProfiles(root) {
  const s = state.original;
  if (!s.profileCount || !s.activeProfile) { root.replaceChildren(); return false; }
  root.replaceChildren(...Array.from({ length: Math.min(s.profileCount, 8) }, (_, i) => h('button', {
    type: 'button', class: 'profile' + (s.activeProfile === i + 1 ? ' selected' : ''), disabled: !canEdit(),
    'aria-pressed': String(s.activeProfile === i + 1), onclick: () => switchProfile(i + 1),
  }, h('span', { class: 'profile-main' },
    h('span', { class: 'profile-name' }, profileName(s, i)),
    h('span', { class: 'profile-sub' }, s.activeProfile === i + 1 ? '사용 중' : `프로필 ${i + 1} · 눌러서 전환`)))));
  return true;
}
const field = (label, control) => h('div', { class: 'field' }, h('label', null, label), control);
function changed() { OMM.ui.refreshActions(); }
function select(key, label, options) {
  const current = state.work[key];
  if (current === null || current === undefined || !options?.length) return null;
  const display = { Low: '낮음', Medium: '중간', High: '높음', eSports: 'e스포츠', Office: '사무용', Gaming: '게임', 'High Performance': '고성능' };
  const values = options.map(value => Array.isArray(value) ? value : [value, display[value] || String(value)]);
  if (!values.some(([v]) => v === current)) values.push([current, `현재 값: ${current}`]);
  return field(label, h('select', { disabled: !canEdit(), onchange: e => {
    state.work[key] = values[Number(e.target.value)][0]; changed();
  } }, ...values.map(([v, text], i) => h('option', { value: i, selected: v === current }, text))));
}
function number(label, value, min, max, step, setter) {
  return field(label, h('input', { type: 'number', value, min, max, step, disabled: !canEdit(), onchange: e => {
    const n = Number(e.target.value);
    if (!e.target.value || !Number.isInteger(n) || n < min || n > max || (n - min) % step) {
      e.target.value = value; toast(`${min}~${max}, ${step} 단위로 입력하세요.`, 'error'); return;
    }
    setter(n); changed();
  } }));
}
const labels = { Left: '왼쪽 버튼', Right: '오른쪽 버튼', Middle: '휠 클릭', Forward: '앞으로', Back: '뒤로', Backward: '뒤로', 'DPI Loop': 'DPI 순환' };
function overview(s) {
  const tile = (label, value, sub = '') => h('div', { class: 'stat' }, h('small', null, label), h('b', null, value ?? '–'), h('span', null, sub));
  return h('div', null, h('div', { class: 'stat-grid' },
    tile('현재 DPI', s.dpiStages?.[s.activeDpiStage]?.toLocaleString() ?? s.dpi, `${s.dpiStages?.length || 0}단계`),
    tile('보고율', s.pollingRateHz ? `${s.pollingRateHz.toLocaleString()} Hz` : '–', summary().modeText),
    tile('배터리', s.batteryPercent == null ? '–' : `${s.batteryPercent}%`, s.batteryState === 'Charging' ? '충전 중' : ''),
    tile('현재 프로필', s.activeProfile ? profileName(s, s.activeProfile - 1) : '–')),
    h('p', { class: 'hint' }, '성능과 버튼 탭에서 설정을 편집하세요. 변경 내용은 「기기에 저장」을 누르면 적용됩니다. 프로필 전환은 즉시 적용됩니다.'));
}
function performance(s) {
  const nodes = [select('pollingRateHz', '보고율', s.supportedPollingRates?.map(v => [v, `${v.toLocaleString()} Hz`])),
    select('liftOffDistance', '리프트오프 거리', s.supportedLiftOffDistances), select('powerMode', '성능 모드', s.powerModes)];
  const dpi = s.ui?.dpiStageEditor;
  if (dpi && s.dpiStages?.length) {
    nodes.push(h('h3', null, `DPI 단계 (${dpi.minDpi}~${dpi.maxDpi.toLocaleString()})`));
    s.dpiStages.forEach((value, i) => {
      const numeric = number('', value, dpi.minDpi, dpi.maxDpi, dpi.stepDpi, n => {
        state.work.dpiStages[i] = n; slider.value = n;
      }).querySelector('input');
      numeric.setAttribute('aria-label', `단계 ${i + 1} DPI`);
      const slider = h('input', { type: 'range', min: dpi.minDpi, max: dpi.maxDpi, step: dpi.stepDpi, value,
        disabled: !canEdit(), 'aria-label': `단계 ${i + 1} DPI 슬라이더`, oninput: e => {
          state.work.dpiStages[i] = Number(e.target.value); numeric.value = e.target.value; changed();
        } });
      nodes.push(h('div', { class: 'dpi-row' }, h('span', { class: 'dpi-idx' }, `${i + 1}단계`), slider, numeric,
        h('label', null, h('input', { type: 'radio', name: 'mchose-stage', checked: i === s.activeDpiStage,
          disabled: !canEdit(), onchange: () => { state.work.activeDpiStage = i; changed(); } }), ' 현재')));
    });
  }
  nodes.push(h('h3', null, '센서'));
  const toggles = [['motionSync', '모션 싱크', '센서 판독을 보고 주기에 맞춥니다.'],
    ['angleSnapping', '각도 스냅', '직선에 가까운 움직임을 곧게 보정합니다.'],
    ['rippleControl', '리플 컨트롤', '높은 DPI에서 생기는 미세한 떨림을 줄입니다.']];
  nodes.push(h('div', { class: 'toggle-list' }, ...toggles.filter(([key]) => typeof s[key] === 'boolean').map(([key, label, desc]) =>
    h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', checked: s[key], disabled: !canEdit(),
      onchange: e => { state.work[key] = e.target.checked; changed(); } }), h('span', null, h('b', null, label), h('small', null, desc))))));
  return h('div', null, ...nodes.filter(Boolean));
}
function buttons(s) {
  const nodes = [];
  if (s.debounceMs != null) nodes.push(number('디바운스 (ms)', s.debounceMs, 0, state.client.getDebounceMaxMs(), 1,
    n => { state.work.debounceMs = n; }), h('p', { class: 'hint' }, '클릭 후 중복 입력을 무시하는 시간입니다. 채터링이 생기면 값을 높이세요.'));
  if (s.buttonMappings && s.buttonOptions?.length) nodes.push(h('table', { class: 'buttons' },
    h('thead', null, h('tr', null, ...['버튼', '현재 동작', '바꿀 동작'].map(t => h('th', null, t)))),
    h('tbody', null, ...Object.entries(s.buttonMappings).map(([button, action]) => h('tr', null,
      h('td', { class: 'btn-idx' }, labels[button] || button), h('td', { class: 'btn-desc' }, labels[action] || action),
      h('td', null, h('select', { 'aria-label': labels[button] || button, disabled: !canEdit() || button === 'Left', onchange: e => {
        state.work.buttonMappings[button] = e.target.value; changed();
      } }, ...[...new Set([action, ...s.buttonOptions.filter(o => !(s.family === 'V3' && button === 'DPI' && o === '기본값'))])].map(value => h('option', { value, selected: value === action }, labels[value] || value)))))))),
    h('p', { class: 'hint' }, '왼쪽 클릭은 유지됩니다. 기존 매크로는 다른 동작을 선택하지 않으면 유지됩니다.'));
  return h('div', null, ...nodes);
}
function advanced(s) {
  return h('div', null, ...[
    select('sleepTimeout', '자동 절전', state.client.getSleepOptions().map(v => [v, v ? `${v / 60}분` : '끔'])),
    Number.isInteger(s.angleTuning) ? number('센서 각도 (°)', s.angleTuning, -30, 30, 1, n => { state.work.angleTuning = n; }) : null,
    h('h3', null, '기기 정보'), h('table', { class: 'info' }, ...[
      ['기기', s.name], ['연결', summary().modeText], ['펌웨어', (s.firmware || []).join(' · ') || '알 수 없음'],
      ['프로필 수', s.profileCount || '알 수 없음'],
    ].map(([key, value]) => h('tr', null, h('th', null, key), h('td', null, value)))),
    h('button', { onclick: refresh }, '기기 설정 다시 읽기'),
  ].filter(Boolean));
}
function render(root) {
  const s = state.work;
  const ready = s.ui?.settingsReady && knownStatus(s);
  const tabs = [['overview', '개요'], ['performance', '성능'], ['buttons', '버튼'], ['advanced', '고급']];
  const body = ({ overview, performance, buttons, advanced })[state.tab](s);
  root.replaceChildren(...[
    !ready && h('p', { class: 'notice' }, '기기 설정을 확인하지 못해 읽기 전용입니다. 고급 탭에서 다시 읽거나 진단 정보를 내보내세요.'),
    state.stale && h('p', { class: 'notice' }, '일부 설정이 변경되었을 수 있습니다. 고급 탭에서 현재 설정을 다시 읽으세요.'),
    h('div', { class: 'editor-head' }, h('h2', null, s.name), h('span', { class: 'chip' }, canEdit() ? '편집 가능' : '읽기 전용')),
    ready && h('label', { class: 'notice mchose-unlock' }, h('input', { type: 'checkbox', checked: state.unlocked, onchange: e => {
      state.unlocked = e.target.checked; if (!state.unlocked) state.work = clone(state.original); OMM.ui.refresh();
    } }), ' M HUB와 표시 값이 일치함을 확인하고 편집합니다. (저장 실기기 검증 전)'),
    s.ui?.statusNote && h('p', { class: 'hint' }, s.ui.statusNote),
    h('nav', { class: 'tabs', 'aria-label': '기기 설정 항목' }, ...tabs.map(([id, label]) => h('button', {
      class: state.tab === id ? 'active' : '', onclick: () => { state.tab = id; render(root); },
    }, label))), h('div', { class: 'panel' }, body),
  ].filter(Boolean));
}
OMM.mchoseUi = { filters, catalog, connected, isDirty, canEdit, connect, disconnect, summary, save, revert, render,
  renderProfiles, exportDiagnostics, ownsDevice: d => state.client?.device === d, state };

document.querySelector('#home-hero').append(h('details', { class: 'mchose-catalog' },
  h('summary', null, `MCHOSE 지원 목록 (${catalog.length}개 기종·연결 변형)`),
  h('p', { class: 'hint' }, '목록에 있어도 기기 데이터를 확인한 뒤 편집합니다. K7 Ultra와 A7 V2 Ultra+는 설정 읽기를 확인했습니다.'),
  ...['A5 Gen1', 'V2', 'V3'].map(family => h('p', null,
    h('strong', null, family + ': '), catalog.filter(p => p.family === family).map(p => p.name + (p.readOnly ? ' (읽기 전용)' : '')).join(', '))),
  h('a', { href: 'docs/mchose-support.md', target: '_blank', rel: 'noopener' }, '지원 범위·검증 기록'),
));
