// MCHOSE(mchose.js) 기기의 설정 화면. 연결할 때는 읽기만 하고, 사용자가 M HUB와 값을 대조한 뒤 편집을 연다.
import { filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot } from './mchose.js';
import { t, num } from './i18n.js';
import { h, toast, busy, ask, download, tabs, tabPanel, tile, field, app, shell } from './ui.js';

export { filters, catalog };
export const state = { client: null, original: null, work: null, unlocked: false, stale: false, tab: 'overview' };
export const connected = () => !!state.original;
export const isDirty = () => connected() && changes(state.original, state.work).length > 0;
export const canEdit = () => connected() && !!state.original.ui?.settingsReady && knownStatus(state.original) && state.unlocked && !state.stale;
export const ownsDevice = (d) => state.client?.device === d;
const clone = (value) => structuredClone(value);
function accept(status) { state.original = clone(status); state.work = clone(status); state.stale = false; }

export async function connect(devices) {
  state.client = createClient(devices);
  await state.client.open();
  accept(await state.client.readStatus());
  state.unlocked = false; state.tab = 'overview';
}
export async function disconnect() {
  if (state.client) await state.client.close();
  Object.assign(state, { client: null, original: null, work: null, unlocked: false, stale: false });
}
export function summary() {
  const s = state.original;
  return { name: s.name, modeText: s.connectionType === 'Wired' ? t('유선 연결') : t('무선 연결'),
    dpi: s.dpi, rate: s.pollingRateHz, profileLabel: s.activeProfile ? profileName(s, s.activeProfile - 1) : null,
    battery: s.batteryPercent === null ? null : { percent: s.batteryPercent, charging: s.batteryState === 'Charging' } };
}
async function refresh() {
  if (isDirty() && !await ask(t('다시 읽기'), [t('저장하지 않은 편집 내용을 버리고 기기 설정을 다시 읽습니다.')], t('다시 읽기'))) return;
  await busy(t('MCHOSE 설정 읽는 중…'), async () => accept(await state.client.readStatus()));
  shell.refresh();
}
export async function save() {
  if (!canEdit() || !isDirty()) return;
  if (!await ask(t('기기에 저장'), [
    t('{name}에 변경한 설정을 기록하고 다시 읽어 확인합니다.', { name: state.original.name }),
    t('기록 중 기기를 분리하지 마세요. 중간에 실패하면 일부 설정만 반영될 수 있습니다.'),
  ], t('저장'))) return;
  const done = await busy(t('MCHOSE 설정 저장·검증 중…'), async () => {
    try { accept(await saveChanges(state.client, state.original, state.work)); }
    catch (error) { state.stale = true; throw error; }
  });
  if (done) toast(t('저장 후 기기에서 읽은 값이 일치합니다.'), 'ok');
  shell.refresh();
}
export function revert() { state.work = clone(state.original); shell.refresh(); }
export async function exportDiagnostics() {
  const done = await busy(t('MCHOSE 진단 정보 읽는 중…'), async () => {
    const status = await state.client.readStatus();
    const d = state.client.device;
    download({ type: 'omm-web-mchose-diagnostics', version: 1, exportedAt: new Date().toISOString(),
      vendorId: d.vendorId, productId: d.productId, productName: d.productName,
      collections: d.collections, family: state.client.family, status,
    }, 'diagnostics', status.name);
  });
  if (done) toast(t('읽기 전용 진단 정보를 저장했습니다.'), 'ok');
}

// 백업: 기기에 저장된 지금 프로필의 편집 가능한 값. 불러올 때는 이 기기의 선택지와 범위에 맞는 값만 화면의 편집본에 옮기고,
// 기록은 「기기에 저장」을 눌러야 한다. DPI 단계 수가 다르거나 왼쪽 버튼 값은 옮기지 않는다.
const BACKUP_TYPE = 'gomm-mchose-backup';
export function exportBackup() {
  const s = state.original;
  const { activeProfile, ...settings } = editableSnapshot(s);
  download({ type: BACKUP_TYPE, version: 1, device: s.name, family: state.client.family, exportedAt: new Date().toISOString(),
    activeProfile, settings }, 'settings', s.name);
  if (isDirty()) toast(t('기기에 저장된 설정을 내보냈습니다. 저장하지 않은 편집 내용은 들어 있지 않습니다.'), 'ok');
}
// 불러올 수 없어 뺀 항목을 화면에 보여 줄 때 쓰는 이름
const FIELD_NAMES = {
  pollingRateHz: '보고율', liftOffDistance: '리프트오프 거리', powerMode: '성능 모드', sleepTimeout: '자동 절전', debounceMs: '디바운스',
  angleTuning: '센서 각도', motionSync: '모션 싱크', angleSnapping: '각도 스냅', rippleControl: '리플 컨트롤', dpiStages: 'DPI 단계', activeDpiStage: '현재 DPI 단계',
};
function restore(b) {
  const s = state.work;
  if (b?.type !== BACKUP_TYPE || !b.settings) throw new Error(t('GOMM MCHOSE 설정 백업 파일이 아닙니다.'));
  if (b.device !== s.name || b.family !== state.client.family) {
    throw new Error(t('이 기종과 맞지 않는 백업입니다 ({device}).', { device: b.device || t('알 수 없는 기기') }));
  }
  const src = b.settings, next = clone(s), skipped = [];
  const take = (key, ok) => {
    if (src[key] == null || s[key] == null) return;
    if (ok(src[key])) next[key] = clone(src[key]);
    else skipped.push(t(FIELD_NAMES[key]));
  };
  const dpi = s.ui?.dpiStageEditor;
  take('pollingRateHz', (v) => !!s.supportedPollingRates?.includes(v));
  take('liftOffDistance', (v) => !!s.supportedLiftOffDistances?.includes(v));
  take('powerMode', (v) => !!s.powerModes?.includes(v));
  take('sleepTimeout', (v) => state.client.getSleepOptions().includes(v));
  take('debounceMs', (v) => Number.isInteger(v) && v >= 0 && v <= state.client.getDebounceMaxMs());
  take('angleTuning', (v) => Number.isInteger(v) && v >= -30 && v <= 30);
  for (const key of ['motionSync', 'angleSnapping', 'rippleControl']) take(key, (v) => typeof v === 'boolean');
  take('dpiStages', (v) => !!dpi && Array.isArray(v) && v.length === s.dpiStages.length
    && v.every((n) => Number.isInteger(n) && n >= dpi.minDpi && n <= dpi.maxDpi && (n - dpi.minDpi) % dpi.stepDpi === 0));
  take('activeDpiStage', (v) => Number.isInteger(v) && v >= 0 && v < next.dpiStages.length);
  for (const [button, action] of Object.entries(src.buttonMappings || {})) {
    if (button === 'Left' || !(button in (s.buttonMappings || {})) || action === s.buttonMappings[button]) continue;
    if (s.buttonOptions?.includes(action) && !(s.family === 'V3' && button === 'DPI' && action === '기본값')) next.buttonMappings[button] = action;
    else skipped.push(t('버튼 {button}', { button: buttonLabel(button) }));
  }
  changes(state.original, next); // 왼쪽 버튼 같은 금지된 변경이 섞이지 않았는지 확인한다
  return { next, skipped };
}
export async function importBackup(file) {
  try {
    if (!canEdit()) throw new Error(t('편집을 허용한 뒤에 불러올 수 있습니다.'));
    const { next, skipped } = restore(JSON.parse(await file.text()));
    state.work = next;
    toast(skipped.length
      ? t('설정을 불러왔습니다. 이 기기에 맞지 않아 뺀 항목: {items}. 「기기에 저장」을 눌러야 반영됩니다.', { items: skipped.join(', ') })
      : t('설정을 불러왔습니다. 「기기에 저장」을 눌러야 기기에 반영됩니다.'), 'ok');
  } catch (error) {
    toast(error instanceof SyntaxError ? t('백업 파일을 읽지 못했습니다.') : t(error.message), 'error');
  }
  shell.refresh();
}
async function switchProfile(index) {
  if (!canEdit() || app.busy || index === state.original.activeProfile) return;
  if (!await ask(t('프로필 전환'), [t('기기에 즉시 적용됩니다. 저장하지 않은 편집 내용은 버립니다.')], t('전환'))) return;
  await busy(t('프로필 전환 중…'), async () => {
    try {
      await state.client.setProfile(index);
      const status = await state.client.readStatus();
      if (status.activeProfile !== index) throw new Error(t('기기가 프로필 전환을 확인하지 않았습니다.'));
      accept(status);
    } catch (error) { state.stale = true; throw error; }
  });
  shell.refresh();
}
function profileName(status, index) {
  const name = status.profileNames?.[index]?.trim();
  return !name || /^(?:Profile|Config|默认板载|默认配置)\s*\d+$/i.test(name) || /[\u0000-\u001f\u007f�]/.test(name)
    ? t('프로필 {n}', { n: index + 1 }) : name;
}
export function renderProfiles(root) {
  const s = state.original;
  if (!s.profileCount || !s.activeProfile) { root.replaceChildren(); return false; }
  root.replaceChildren(...Array.from({ length: Math.min(s.profileCount, 8) }, (_, i) => h('button', {
    type: 'button', class: 'profile' + (s.activeProfile === i + 1 ? ' selected' : ''), disabled: !canEdit(),
    'aria-pressed': String(s.activeProfile === i + 1), onclick: () => switchProfile(i + 1),
  }, h('span', { class: 'profile-main' },
    h('span', { class: 'profile-name' }, profileName(s, i)),
    h('span', { class: 'profile-sub' }, s.activeProfile === i + 1 ? t('사용 중') : t('프로필 {n} · 눌러서 전환', { n: i + 1 }))))));
  return true;
}
function changed() { shell.refreshActions(); }
// 기기가 영어 이름으로 알려 주는 선택지의 표시 이름
const OPTION_NAMES = { Low: '낮음', Medium: '중간', High: '높음', eSports: 'e스포츠', Office: '사무용', Gaming: '게임', 'High Performance': '고성능' };
function select(key, label, options) {
  const current = state.work[key];
  if (current === null || current === undefined || !options?.length) return null;
  const values = options.map((value) => (Array.isArray(value) ? value : [value, OPTION_NAMES[value] ? t(OPTION_NAMES[value]) : String(value)]));
  if (!values.some(([v]) => v === current)) values.push([current, t('현재 값: {value}', { value: current })]);
  return field(label, null, h('select', { disabled: !canEdit(), onchange: (e) => {
    state.work[key] = values[Number(e.target.value)][0]; changed();
  } }, ...values.map(([v, text], i) => h('option', { value: i, selected: v === current }, text))));
}
function numberInput(value, min, max, step, setter, attrs = {}) {
  return h('input', { type: 'number', value, min, max, step, disabled: !canEdit(), ...attrs, onchange: (e) => {
    const n = Number(e.target.value);
    if (!e.target.value || !Number.isInteger(n) || n < min || n > max || (n - min) % step) {
      e.target.value = value; toast(t('{min}~{max}, {step} 단위로 입력하세요.', { min, max, step }), 'error'); return;
    }
    setter(n); changed();
  } });
}
// 버튼 이름과 동작 이름. 기기가 영어로 알려 주는 이름은 한국어 원문으로 바꾼 뒤 번역한다.
const BUTTON_NAMES = { Left: '왼쪽 버튼', Right: '오른쪽 버튼', Middle: '휠 클릭', Forward: '앞으로', Back: '뒤로', Backward: '뒤로', 'DPI Loop': 'DPI 순환' };
function buttonLabel(name) {
  const macro = /^매크로: (.*)$/.exec(name);
  if (macro) return t('매크로: {name}', { name: macro[1] });
  const unknown = /^알 수 없음 \((.*)\)$/.exec(name);
  if (unknown) return t('알 수 없음 ({bytes})', { bytes: unknown[1] });
  return t(BUTTON_NAMES[name] || name);
}
function overview(s) {
  return h('div', null, h('div', { class: 'stat-grid' },
    tile(t('현재 DPI'), s.dpiStages?.[s.activeDpiStage] != null ? num(s.dpiStages[s.activeDpiStage]) : (s.dpi ?? '–'), t('{n}단계', { n: s.dpiStages?.length || 0 })),
    tile(t('보고율'), s.pollingRateHz ? `${num(s.pollingRateHz)} Hz` : '–', summary().modeText),
    tile(t('배터리'), s.batteryPercent == null ? '–' : `${s.batteryPercent}%`, s.batteryState === 'Charging' ? t('충전 중') : null),
    tile(t('현재 프로필'), s.activeProfile ? profileName(s, s.activeProfile - 1) : '–')),
    h('p', { class: 'hint' }, t('성능과 버튼 탭에서 설정을 편집하세요. 변경 내용은 「기기에 저장」을 누르면 적용됩니다. 프로필 전환은 즉시 적용됩니다.')));
}
function performance(s) {
  const nodes = [select('pollingRateHz', t('보고율'), s.supportedPollingRates?.map((v) => [v, `${num(v)} Hz`])),
    select('liftOffDistance', t('리프트오프 거리'), s.supportedLiftOffDistances), select('powerMode', t('성능 모드'), s.powerModes)];
  const dpi = s.ui?.dpiStageEditor;
  if (dpi && s.dpiStages?.length) {
    nodes.push(h('h3', null, t('DPI 단계 ({min}~{max})', { min: num(dpi.minDpi), max: num(dpi.maxDpi) })));
    s.dpiStages.forEach((value, i) => {
      const stageName = t('{n}단계', { n: i + 1 });
      const numeric = numberInput(value, dpi.minDpi, dpi.maxDpi, dpi.stepDpi, (n) => {
        state.work.dpiStages[i] = n; slider.value = n;
      }, { 'aria-label': t('{stage} DPI', { stage: stageName }) });
      const slider = h('input', { type: 'range', min: dpi.minDpi, max: dpi.maxDpi, step: dpi.stepDpi, value,
        disabled: !canEdit(), 'aria-label': t('{stage} DPI 슬라이더', { stage: stageName }), oninput: (e) => {
          state.work.dpiStages[i] = Number(e.target.value); numeric.value = e.target.value; changed();
        } });
      nodes.push(h('div', { class: 'dpi-row' }, h('span', { class: 'dpi-idx' }, stageName), slider, numeric,
        h('label', null, h('input', { type: 'radio', name: 'mchose-stage', checked: i === s.activeDpiStage,
          disabled: !canEdit(), onchange: () => { state.work.activeDpiStage = i; changed(); } }), ' ' + t('현재'))));
    });
  }
  nodes.push(h('h3', null, t('센서')));
  const toggles = [['motionSync', '모션 싱크', '센서 판독을 보고 주기에 맞춥니다.'],
    ['angleSnapping', '각도 스냅', '직선에 가까운 움직임을 곧게 보정합니다.'],
    ['rippleControl', '리플 컨트롤', '높은 DPI에서 생기는 미세한 떨림을 줄입니다.']];
  nodes.push(h('div', { class: 'toggle-list' }, ...toggles.filter(([key]) => typeof s[key] === 'boolean').map(([key, label, desc]) =>
    h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', checked: s[key], disabled: !canEdit(),
      onchange: (e) => { state.work[key] = e.target.checked; changed(); } }), h('span', null, h('b', null, t(label)), h('small', null, t(desc)))))));
  return h('div', null, ...nodes.filter(Boolean));
}
function buttons(s) {
  const nodes = [];
  if (s.debounceMs != null) {
    nodes.push(field(t('디바운스'), 'ms', numberInput(s.debounceMs, 0, state.client.getDebounceMaxMs(), 1, (n) => { state.work.debounceMs = n; })),
      h('p', { class: 'hint' }, t('클릭 후 중복 입력을 무시하는 시간입니다. 채터링이 생기면 값을 높이세요.')));
  }
  if (s.buttonMappings && s.buttonOptions?.length) nodes.push(h('table', { class: 'buttons' },
    h('thead', null, h('tr', null, ...[t('버튼'), t('현재 동작'), t('바꿀 동작')].map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, ...Object.entries(s.buttonMappings).map(([button, action]) => h('tr', null,
      h('th', { class: 'btn-idx', scope: 'row' }, buttonLabel(button)), h('td', { class: 'btn-desc' }, buttonLabel(action)),
      h('td', null, h('select', { 'aria-label': t('{button} 바꿀 동작', { button: buttonLabel(button) }), disabled: !canEdit() || button === 'Left', onchange: (e) => {
        state.work.buttonMappings[button] = e.target.value; changed();
      } }, ...[...new Set([action, ...s.buttonOptions.filter((o) => !(s.family === 'V3' && button === 'DPI' && o === '기본값'))])]
        .map((value) => h('option', { value, selected: value === action }, buttonLabel(value))))))))),
    h('p', { class: 'hint' }, t('왼쪽 클릭은 유지됩니다. 기존 매크로는 다른 동작을 선택하지 않으면 유지됩니다.')));
  return h('div', null, ...nodes);
}
function advanced(s) {
  return h('div', null, ...[
    select('sleepTimeout', t('자동 절전'), state.client.getSleepOptions().map((v) => [v, v ? t('{n}분', { n: v / 60 }) : t('끔')])),
    Number.isInteger(s.angleTuning) ? field(t('센서 각도'), '°', numberInput(s.angleTuning, -30, 30, 1, (n) => { state.work.angleTuning = n; })) : null,
    h('h3', null, t('기기 정보')), h('table', { class: 'info' }, ...[
      [t('기기'), s.name], [t('연결'), summary().modeText], [t('펌웨어'), (s.firmware || []).join(' · ') || t('알 수 없음')],
      [t('프로필 수'), s.profileCount || t('알 수 없음')],
    ].map(([key, value]) => h('tr', null, h('th', { scope: 'row' }, key), h('td', null, value)))),
    h('button', { onclick: refresh }, t('기기 설정 다시 읽기')),
  ].filter(Boolean));
}
export function render(root) {
  const s = state.work;
  const ready = s.ui?.settingsReady && knownStatus(s);
  const tabList = [['overview', t('개요')], ['performance', t('성능')], ['buttons', t('버튼')], ['advanced', t('고급')]];
  const body = ({ overview, performance, buttons, advanced })[state.tab](s);
  root.replaceChildren(...[
    !ready && h('p', { class: 'notice' }, t('기기 설정을 확인하지 못해 읽기 전용입니다. 고급 탭에서 다시 읽거나 진단 정보를 내보내세요.')),
    state.stale && h('p', { class: 'notice' }, t('일부 설정이 변경되었을 수 있습니다. 고급 탭에서 현재 설정을 다시 읽으세요.')),
    h('div', { class: 'editor-head' }, h('h2', null, s.name), h('span', { class: 'chip' }, canEdit() ? t('편집 가능') : t('읽기 전용'))),
    ready && h('label', { class: 'notice mchose-unlock' }, h('input', { type: 'checkbox', checked: state.unlocked, onchange: (e) => {
      state.unlocked = e.target.checked; if (!state.unlocked) state.work = clone(state.original); shell.refresh();
    } }), ' ' + t('M HUB와 표시 값이 일치함을 확인하고 편집합니다. (저장 실기기 검증 전)')),
    s.ui?.statusNote && h('p', { class: 'hint' }, t(s.ui.statusNote)),
    tabs(tabList, state.tab, (id) => { state.tab = id; render(root); }, t('기기 설정 항목')),
    tabPanel(state.tab, body),
  ].filter(Boolean));
}
