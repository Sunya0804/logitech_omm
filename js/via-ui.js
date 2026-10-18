// VIA 화면. 모든 편집·저장은 ViaSession을 통하고 정의 파일의 문자열은 텍스트로만 넣는다.
import { ViaDevice, filters } from './via.js';
import { ViaSession } from './via-session.js';
import { definitionSources, fetchDefinition, rememberedDefinition, rememberDefinition, forgetDefinition } from './via-definition.js';
import { parseKeycode } from './via-keycodes.js';
import { encodeMacro } from './via-macro.js';
import { CODE_TO_USAGE } from './keys.js';
import { macroEditor, macroSummary, stopRecording, isRecording } from './macro-editor.js';
import { h, tabs, tabPanel, field, tile, app, shell, busy, ask, toast, download } from './ui.js';
import { t } from './i18n.js';

export { filters };
export const state = { dev: null, session: null, source: null, error: '', tab: 'keymap', layer: 0, selected: null, group: 'basic', macro: null, capture: false };
export const connected = () => !!state.dev;
// 구형 프로토콜도 조명·설정은 편집한다. 키맵은 각 입력 칸에서 별도로 막는다.
export const canEdit = () => !!state.session;
export const isDirty = () => state.session?.isDirty() || false;
export const ownsDevice = (d) => state.dev?.dev === d;
export const refreshBattery = async () => false;
export const renderProfiles = () => false;
export const summary = () => ({ name: state.session?.def.name || state.dev?.name || 'VIA', modeText: t('VIA 키보드'), dpi: null, rate: null, profileLabel: null, battery: null });

let root;
let timer = null;
let pollEpoch = 0;
let resizeObserver;
const sourceText = () => (typeof state.source === 'function' ? state.source() : state.source || '');
const hexId = (...ids) => ids.map((id) => id.toString(16).padStart(4, '0').toUpperCase()).join(':');
const refresh = () => { if (root && connected()) render(root); shell.refreshActions(); };
const edit = (fn) => { if (app.busy) return; try { fn(); refresh(); } catch (e) { toast(e.message, 'error'); } };

// remember: 사용자가 직접 불러온 파일만 이 브라우저에 기억한다. 내장·자동으로 받은 파일은 다음에 다시 받아서,
// 사이트의 내장 파일이 바뀌면 그쪽을 쓰게 한다.
async function loadDefinition(json, setMsg, source, remember = false) {
  const dev = state.dev;
  const session = new ViaSession(dev, json);
  await session.load(setMsg);
  if (state.dev !== dev) return;
  state.session = session;
  state.source = source;
  state.error = '';
  state.selected = null;
  state.layer = 0;
  state.tab = 'keymap';
  if (remember) rememberDefinition(json);
}

export async function connect(devices, setMsg, json) {
  state.dev = new ViaDevice(devices);
  await state.dev.open();
  const { vendorId, productId } = state.dev;
  let definition = json || rememberedDefinition(vendorId, productId);
  // 출처 문구는 언어를 바꿔도 따라가도록 그릴 때 번역한다
  let source = json ? () => t('직접 불러온 파일') : () => t('이 브라우저에 기억한 파일');
  if (!definition) {
    const found = await fetchDefinition(vendorId, productId);
    definition = found?.json;
    source = found?.source.kind === 'bundled' ? () => t('내장 정의 파일 ({date} 받음)', { date: found.source.fetchedAt }) : found?.source.url;
  }
  if (definition) {
    try { await loadDefinition(definition, setMsg, source); }
    catch (e) { state.error = e.message; }
  }
}

function stopTest() { clearTimeout(timer); timer = null; pollEpoch++; }
export async function disconnect() {
  stopTest();
  stopRecording();
  resizeObserver?.disconnect();
  const dev = state.dev;
  state.dev = null;
  state.session = null;
  state.error = '';
  state.capture = false;
  state.macro = null;
  state.tab = 'keymap';
  state.selected = null;
  await app.background;
  await dev?.close();
}

async function importDefinition(file) {
  if (!file || app.busy) return;
  if (!/\.json$/i.test(file.name)) { state.error = t('JSON 파일을 골라 주세요.'); return refresh(); }
  await busy(t('키보드 정보 읽는 중…'), async (setMsg) => {
    try { await loadDefinition(JSON.parse(await file.text()), setMsg, file.name, true); }
    catch (e) { state.error = e.message; }
  });
  shell.refresh();
}

function definitionLoader() {
  const dev = state.dev;
  const input = h('input', { type: 'file', accept: '.json,application/json', id: 'via-definition', onchange: (e) => importDefinition(e.target.files[0]) });
  return h('section', { class: 'via-loader' },
    h('h3', null, t('정의 파일 불러오기')),
    h('p', null, `${dev.name} · ${hexId(dev.vendorId, dev.productId)}`),
    definitionSources(dev.vendorId, dev.productId).filter((s) => s.kind === 'link').map((s) => h('div', { class: 'row-actions' },
      h('a', { href: s.url, target: '_blank', rel: 'noopener' }, t('정의 파일 받기 ({name})', { name: s.name })),
      h('a', { href: s.page, target: '_blank', rel: 'noopener' }, t('제작사 웹 허브 열기')))),
    h('p', { class: 'hint' }, t('받은 JSON 파일을 아래에서 불러오세요. 한 번 불러오면 이 브라우저가 기억합니다.')),
    h('label', { class: 'via-drop', ondragover: (e) => e.preventDefault(), ondrop: (e) => { e.preventDefault(); importDefinition(e.dataTransfer.files[0]); } },
      h('span', null, t('JSON 파일을 고르거나 여기로 끌어다 놓으세요.')), input),
    state.error && h('p', { class: 'notice', role: 'alert' }, state.error));
}

function layerPicker() {
  return field(t('레이어'), null, h('select', { id: 'via-layer', value: state.layer, onchange: (e) => { state.layer = +e.target.value; state.selected = null; refresh(); } },
    Array.from({ length: state.session.layers }, (_, i) => h('option', { value: i, selected: i === state.layer }, String(i)))));
}

function keyboard(test = false) {
  const s = state.session;
  const dirty = s.changes();
  const keyButton = (k, cw) => {
    const encoder = k.encoder !== undefined;
    const target = { ...k, ...(encoder ? { cw } : {}) };
    const code = encoder ? s.encoder(state.layer, k.encoder, cw) : s.keycode(state.layer, k.row, k.col);
    const label = s.label(code);
    const changed = dirty.some((c) => c.layer === state.layer && (encoder ? c.kind === 'encoder' && c.index === k.encoder && c.cw === cw : c.kind === 'key' && c.row === k.row && c.col === k.col));
    const selected = state.selected && (encoder ? state.selected.encoder === k.encoder && state.selected.cw === cw : state.selected.encoder === undefined && state.selected.row === k.row && state.selected.col === k.col);
    const x = k.x + (encoder && cw ? k.w / 2 : 0);
    return h('button', {
      type: 'button', class: `via-key ${k.color}${code === 1 ? ' transparent' : ''}${changed ? ' changed' : ''}${selected && !test ? ' selected' : ''}`,
      'data-row': k.row, 'data-col': k.col, 'data-encoder': encoder ? k.encoder : null,
      title: `${label.title}${encoder ? cw ? ' ↻' : ' ↺' : ''}`, disabled: !test && (!s.editable || app.busy),
      'aria-pressed': test ? 'false' : String(!!selected),
      style: `left:calc(${x} * var(--via-unit));top:calc(${k.y} * var(--via-unit));width:calc(${encoder ? k.w / 2 : k.w} * var(--via-unit) - 3px);height:calc(${k.h} * var(--via-unit) - 3px);transform:rotate(${k.r}deg);transform-origin:calc(${k.rx - x} * var(--via-unit)) calc(${k.ry - k.y} * var(--via-unit));`,
      onclick: () => { if (!test && s.editable && !app.busy) { state.selected = target; refresh(); } },
    }, encoder ? `${cw ? '↻' : '↺'} ${label.label}` : label.label);
  };
  return h('div', { class: 'via-keyboard-scroll' }, h('div', { class: 'via-keyboard', style: `width:calc(${s.def.width} * var(--via-unit));height:calc(${s.def.height} * var(--via-unit));` },
    s.keys().flatMap((k) => k.encoder !== undefined ? [keyButton(k, false), keyButton(k, true)] : keyButton(k))));
}

async function chooseCode(code) {
  const s = state.session;
  const target = state.selected;
  if (!s?.editable || !target || app.busy) return;
  if (s.label(code).danger && !await ask(t('주의할 키 코드'), [s.label(code).title, t('이 키를 누르면 키보드가 재시작되거나 설정이 초기화될 수 있습니다.')], t('선택'))) return;
  if (state.session !== s || state.selected !== target) return;
  edit(() => {
    if (target.custom) s.setCustom(target.custom, code);
    else if (target.encoder !== undefined) s.setEncoder(state.layer, target.encoder, target.cw, code);
    else s.setKeycode(state.layer, target.row, target.col, code);
  });
}

function codePicker() {
  if (!state.selected || !state.session.editable) return null;
  const s = state.session;
  const groups = s.keycodeGroups();
  const buttons = h('div', { class: 'via-code-grid' });
  const search = h('input', { type: 'text', 'aria-label': t('키 찾기'), placeholder: t('키 찾기'), oninput: () => draw() });
  const draw = () => {
    const term = search.value.toLowerCase();
    const keys = term ? groups.flatMap((g) => g.keys) : (groups.find((g) => g.id === state.group) || groups[0]).keys;
    buttons.replaceChildren(...keys.filter((k) => `${k.title} ${k.label}`.toLowerCase().includes(term)).map((k) => h('button', {
      title: k.title, class: k.danger ? 'danger' : '', disabled: app.busy, onclick: () => chooseCode(k.code),
    }, k.label)));
  };
  const error = h('p', { class: 'notice', role: 'alert', hidden: true });
  const direct = h('input', { type: 'text', id: 'via-direct', placeholder: 'LT(1, KC_SPC)', 'aria-label': t('직접 입력') });
  draw();
  return h('section', { class: 'via-picker', 'aria-label': t('키 고르기') },
    h('h3', null, t('키 고르기')),
    h('div', { class: 'via-groups', role: 'group', 'aria-label': t('키 묶음') }, groups.map((g) => h('button', {
      'aria-pressed': String(state.group === g.id), class: state.group === g.id ? 'active' : '',
      onclick: () => { state.group = g.id; refresh(); },
    }, g.label))), search, buttons,
    h('form', { class: 'row-actions', onsubmit: (e) => {
      e.preventDefault();
      const code = parseKeycode(direct.value);
      if (code === null || code === undefined) { error.hidden = false; error.textContent = t('읽을 수 없는 키 코드입니다.'); }
      else { error.hidden = true; chooseCode(code); }
    } }, direct, h('button', { type: 'submit', disabled: app.busy }, t('직접 입력'))), error,
    h('button', { 'aria-pressed': String(state.capture), disabled: app.busy, onclick: () => { state.capture = !state.capture; refresh(); } },
      state.capture ? t('키보드 입력 기다리는 중…') : t('키보드로 고르기')));
}

window.addEventListener('keydown', (e) => {
  if (!state.capture || !state.selected || !state.session?.editable || app.busy || isRecording() || !root?.isConnected || document.body.dataset.view !== 'config') return;
  if (!['keymap', 'settings'].includes(state.tab) || e.target.closest('input, select, textarea, dialog')) return;
  const code = CODE_TO_USAGE[e.code];
  if (code === undefined) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) { state.capture = false; chooseCode(code); }
}, true);

function layoutPanel() {
  const s = state.session;
  return h('div', null, s.def.options.length ? s.def.options.map((o, i) => field(o.label, null,
    o.toggle ? h('input', { type: 'checkbox', checked: !!s.work.options[i], disabled: app.busy, onchange: (e) => edit(() => s.setLayoutOption(i, +e.target.checked)) })
      : h('select', { 'data-option': i, disabled: app.busy, onchange: (e) => edit(() => s.setLayoutOption(i, +e.target.value)) }, o.choices.map((label, j) => h('option', { value: j, selected: s.work.options[i] === j }, label)))))
    : h('p', { class: 'hint' }, t('이 키보드는 레이아웃 옵션이 없습니다.')), keyboard());
}

function setting(item) {
  const s = state.session;
  const value = s.customValue(item.id);
  const set = (v) => edit(() => s.setCustom(item.id, v));
  if (item.action) return h('div', { class: 'notice', 'data-action': item.id }, h('b', null, item.label), h('p', null, t('이 동작은 제작사 허브에서 실행하세요')));
  let control;
  const slider = (label, val, min, max, change) => field(label, null, h('div', { class: 'via-range' },
    h('input', { type: 'range', min, max, value: val, disabled: app.busy, 'aria-label': label, oninput: (e) => { e.target.nextElementSibling.value = e.target.value; }, onchange: (e) => change(+e.target.value) }),
    h('input', { type: 'number', min, max, value: val, disabled: app.busy, 'aria-label': label, onchange: (e) => change(Math.max(min, Math.min(max, Math.round(+e.target.value || 0)))) })));
  if (item.type === 'range') return h('div', { 'data-setting': item.id }, slider(item.label, value, item.min, item.max, set));
  if (item.type === 'toggle') control = h('input', { type: 'checkbox', checked: value === item.on, disabled: app.busy, onchange: (e) => set(e.target.checked ? item.on : item.off) });
  if (item.type === 'dropdown') control = h('select', { disabled: app.busy, onchange: (e) => set(+e.target.value) }, item.choices.map((c) => h('option', { value: c.value, selected: c.value === value }, c.label)));
  if (item.type === 'color') control = h('div', { class: 'via-color' },
    h('span', { class: 'via-swatch', style: `background:hsl(${value.hue / 255 * 360},${value.sat / 255 * 100}%,50%)` }),
    slider(t('색상'), value.hue, 0, 255, (hue) => set({ ...value, hue })), slider(t('채도'), value.sat, 0, 255, (sat) => set({ ...value, sat })));
  if (item.type === 'keycode') control = h('button', { disabled: !s.editable || app.busy, onclick: () => { state.selected = { custom: item.id }; refresh(); } }, s.label(value).label);
  return h('div', { 'data-setting': item.id }, field(item.label, null, control));
}

function settingsPanel() {
  const s = state.session;
  return h('div', null, s.def.menus.sections.map((section) => h('section', null, h('h3', null, section.label), section.groups.map((g) => h('div', { class: 'via-settings-group' },
    g.label && h('h4', null, g.label), g.items.filter((item) => s.itemVisible(item)).map(setting))))),
    s.def.menus.unsupported.length > 0 && h('p', { class: 'notice' }, t('이 정의 파일의 일부 메뉴({menus})는 아직 표시하지 않습니다.', { menus: s.def.menus.unsupported.join(', ') })),
    state.selected?.custom && codePicker());
}

function macrosPanel() {
  const s = state.session;
  return h('div', null,
    h('p', { class: 'hint' }, t('매크로 사용량: {used} / {max} 바이트', { used: s.macroBytesUsed(), max: s.macroBufferSize })),
    h('div', { class: 'via-macros' }, Array.from({ length: s.macroCount }, (_, i) => h('button', { disabled: app.busy, onclick: () => { stopRecording(); state.macro = i; refresh(); } }, `M${i}`, h('small', null, macroSummary(s.macro(i)))))),
    state.macro !== null && macroEditor({
      title: `M${state.macro}`, current: () => s.macro(state.macro), max: s.macroBufferSize, minDelay: 0, allowText: true,
      size: (steps) => { try { return encodeMacro(steps).length; } catch { return Infinity; } },
      readOnly: app.busy, onChange: (steps) => edit(() => s.setMacro(state.macro, steps)), onClose: () => { state.macro = null; refresh(); }, rerender: refresh,
      notice: t('읽을 수 없는 명령이 있습니다. 새 매크로를 만들면 이 칸을 덮어씁니다.'),
    }));
}

function startTest() {
  const s = state.session;
  const epoch = pollEpoch;
  const tick = async () => {
    if (epoch !== pollEpoch || state.session !== s || state.tab !== 'test' || document.body.dataset.view !== 'config' || document.hidden) return;
    if (!app.busy && !app.background) {
      const job = s.matrixState();
      app.background = job;
      try {
        const pressed = await job;
        if (epoch !== pollEpoch) return;
        for (const el of root.querySelectorAll('.via-key')) {
          const on = !!pressed[+el.dataset.row]?.[+el.dataset.col];
          el.classList.toggle('pressed', on); el.setAttribute('aria-pressed', String(on));
        }
      } catch (e) {
        if (epoch === pollEpoch) { stopTest(); const message = root.querySelector('#via-test-msg'); if (message) message.textContent = t('키 시험을 멈췄습니다: {error}', { error: e.message }); }
        return;
      } finally { if (app.background === job) app.background = null; }
    }
    if (epoch === pollEpoch) timer = setTimeout(tick, 100);
  };
  timer = setTimeout(tick, 100);
}

export function suspend() { stopTest(); state.capture = false; stopRecording(); }
export function resume() { if (state.tab === 'test' && state.session) { stopTest(); startTest(); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTest(); else resume(); });

export function render(el) {
  stopTest(); resizeObserver?.disconnect(); root = el;
  const s = state.session;
  root.classList.add('via-editor');
  if (!s) { root.replaceChildren(h('h2', null, summary().name), definitionLoader()); return; }
  const names = [['keymap', t('키맵')], ['layout', t('레이아웃')], ['settings', t('조명 / 설정')], ['macros', t('매크로')], ['test', t('키 시험')]];
  const body = state.tab === 'keymap' ? [layerPicker(), keyboard(), codePicker()]
    : state.tab === 'layout' ? layoutPanel() : state.tab === 'settings' ? settingsPanel() : state.tab === 'macros' ? macrosPanel()
      : [h('p', { class: 'hint', id: 'via-test-msg' }, t('키보드의 키를 눌러 확인하세요.')), keyboard(true)];
  root.replaceChildren(...[
    h('div', { class: 'via-heading' }, h('div', null, h('h2', null, s.def.name), h('p', { class: 'hint' }, `${hexId(s.def.vendorId, s.def.productId)} · VIA ${s.protocol}${sourceText() ? ` · ${sourceText()}` : ''}`)),
      h('button', { class: 'ghost', disabled: app.busy, onclick: async () => {
        if (isDirty() && !await ask(t('정의 파일 바꾸기'), [t('저장되지 않은 변경을 버릴까요?')], t('바꾸기'))) return;
        suspend(); forgetDefinition(s.def.vendorId, s.def.productId); state.session = null; state.error = ''; shell.refresh();
      } }, t('정의 파일 바꾸기'))),
    !s.editable && h('p', { class: 'notice' }, t('이 키보드의 VIA 프로토콜({n})은 아직 편집하지 않습니다. 읽기만 합니다.', { n: s.protocol })),
    h('div', { class: 'stats via-stats' }, tile(t('레이어'), s.layers), tile(t('행렬'), `${s.def.rows} × ${s.def.cols}`), tile(t('매크로'), s.macroCount)),
    tabs(names, state.tab, (tab) => { suspend(); state.tab = tab; state.selected = null; refresh(); }, t('키보드 설정')),
    tabPanel(state.tab, body)].filter(Boolean));
  const fit = () => { root.style.setProperty('--via-unit', `${Math.max(12, Math.min(48, (root.clientWidth - 36) / s.def.width))}px`); };
  fit(); resizeObserver = new ResizeObserver(fit); resizeObserver.observe(root);
  if (state.tab === 'test' && document.body.dataset.view === 'config') startTest();
}

export async function save() {
  const s = state.session;
  const changes = s?.changes() || [];
  if (!changes.length || app.busy) return;
  const keys = changes.filter((c) => ['key', 'encoder'].includes(c.kind)).length;
  const macros = changes.filter((c) => c.kind === 'macro').length;
  const settings = changes.length - keys - macros;
  const lines = [t('키 {keys}개, 매크로 {macros}개, 설정 {settings}개를 저장합니다.', { keys, macros, settings }),
    ...changes.filter((c) => c.danger).map((c) => t('주의: {name} — 연결이 끊어질 수 있습니다.', { name: c.item.label }))];
  if (!await ask(t('키보드에 저장'), lines, t('저장'))) return;
  if (state.session !== s) return;
  await busy(t('저장 중…'), (setMsg) => s.save(setMsg));
  shell.refresh();
}
export function revert() { if (state.session && !app.busy) { stopRecording(); state.session.revert(); shell.refresh(); } }
export function exportBackup() { const s = state.session; if (s) download(s.exportBackup(), 'via-backup', s.def.name); }
export async function importBackup(file) {
  const s = state.session;
  if (!s || app.busy) return;
  try { const json = JSON.parse(await file.text()); if (state.session === s) { s.importBackup(json); shell.refresh(); } }
  catch (e) { toast(e.message, 'error'); }
}
export function exportDiagnostics() {
  const s = state.session;
  if (!s) return;
  download({ protocol: s.protocol, layers: s.layers, matrix: { rows: s.def.rows, cols: s.def.cols }, firmware: s.firmware,
    id: hexId(s.def.vendorId, s.def.productId), definition: { name: s.def.name, source: sourceText() },
    keymap: s.orig.keymap.map((c) => c.toString(16).padStart(4, '0')), unsupported: s.def.menus.unsupported }, 'via-diagnostics', s.def.name);
}
