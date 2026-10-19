// VIA 화면. 모든 편집·저장은 ViaSession을 통하고 정의 파일의 문자열은 텍스트로만 넣는다.
import { ViaDevice, filters } from './via.js';
import { ViaSession } from './via-session.js';
import { definitionSources, fetchDefinition, rememberedDefinition, rememberDefinition, forgetDefinition } from './via-definition.js';
import { parseKeycode, withMods, modTap, layerTap, splitCombo } from './via-keycodes.js';
import { exportViaLayout, importViaLayout } from './via-layout-file.js';
import { encodeMacro } from './via-macro.js';
import { CODE_TO_USAGE } from './keys.js';
import { macroEditor, macroSummary, stopRecording, isRecording } from './macro-editor.js';
import { h, tabs, tabPanel, field, tile, app, shell, busy, ask, toast, download } from './ui.js';
import { t } from './i18n.js';

export { filters };
// combo: 조합 만들기 칸. kind 'none'이면 고른 키를 그대로 넣고, 'mods'·'mt'·'lt'면 고른 기본 키를 그 조합으로 감싼다.
export const state = { dev: null, session: null, source: null, error: '', tab: 'keymap', layer: 0, selected: null, group: 'basic', macro: null, capture: false,
  combo: { kind: 'none', mods: 0, right: false, layer: 1 }, previous: null };
// previous: 「정의 파일 바꾸기」를 누르기 전의 {session, source}. 불러오기 화면에서 그대로 돌아갈 때 쓴다.
export const connected = () => !!state.dev;
// 구형 프로토콜도 조명·설정은 편집한다. 키맵은 각 입력 칸에서 별도로 막는다.
export const canEdit = () => !!state.session;
export const isDirty = () => state.session?.isDirty() || false;
export const ownsDevice = (d) => state.dev?.dev === d;
export const refreshBattery = async () => false;
export const renderProfiles = () => false;
export const summary = () => ({ kind: 'keyboard', name: state.session?.def.name || state.dev?.name || 'VIA', modeText: t('VIA 키보드'), dpi: null, rate: null, profileLabel: null, battery: null });

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
  state.previous = null;
  if (remember) rememberDefinition(json);
}

// 정의 파일을 찾는 출처 문구 (언어를 바꿔도 따라가도록 그릴 때 번역한다)
const foundSource = (found) => (found.source.kind === 'bundled' ? () => t('내장 정의 파일 ({date} 받음)', { date: found.source.fetchedAt }) : found.source.url);

// 직접 불러온 파일 대신 내장 사본·VIA 목록에서 다시 찾는다. 찾으면 기억한 파일을 지운다.
async function findAutomatically() {
  const dev = state.dev;
  if (!dev || app.busy) return;
  await busy(t('정의 파일 찾는 중…'), async (setMsg) => {
    const found = await fetchDefinition(dev.vendorId, dev.productId);
    if (!found) { state.error = t('이 키보드의 정의 파일을 자동으로 찾지 못했습니다. 파일을 직접 불러오세요.'); return; }
    try {
      await loadDefinition(found.json, setMsg, foundSource(found));
      forgetDefinition(dev.vendorId, dev.productId);
    } catch (e) { state.error = e.message; }
  });
  shell.refresh();
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
    source = found && foundSource(found);
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
  state.previous = null;
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
  const back = () => { Object.assign(state, { session: state.previous.session, source: state.previous.source, previous: null, error: '' }); shell.refresh(); };
  return h('section', { class: 'via-loader' },
    h('h3', null, t('정의 파일 불러오기')),
    h('p', null, `${dev.name} · ${hexId(dev.vendorId, dev.productId)}`),
    h('div', { class: 'row-actions' },
      state.previous && h('button', { id: 'via-definition-back', disabled: app.busy, onclick: back }, t('취소하고 돌아가기')),
      h('button', { class: 'ghost', id: 'via-definition-auto', disabled: app.busy, onclick: findAutomatically }, t('자동으로 찾기'))),
    definitionSources(dev.vendorId, dev.productId).filter((s) => s.kind === 'link').map((s) => h('div', { class: 'row-actions' },
      h('a', { href: s.url, target: '_blank', rel: 'noopener' }, t('정의 파일 받기 ({name})', { name: s.name })),
      h('a', { href: s.page, target: '_blank', rel: 'noopener' }, t('제작사 웹 허브 열기')))),
    h('p', { class: 'hint' }, t('받은 JSON 파일을 아래에서 불러오세요. 한 번 불러오면 이 브라우저가 기억합니다.')),
    h('label', { class: 'via-drop', ondragover: (e) => e.preventDefault(), ondrop: (e) => { e.preventDefault(); importDefinition(e.dataTransfer.files[0]); } },
      h('span', null, t('JSON 파일을 고르거나 여기로 끌어다 놓으세요.')), input),
    state.error && h('p', { class: 'notice', role: 'alert' }, state.error));
}

// 레이어: VIA처럼 번호 버튼을 나란히 두고 누르면 바로 바꾼다
function layerPicker() {
  return h('div', { class: 'via-layers', role: 'group', 'aria-label': t('레이어') },
    h('span', { class: 'via-layers-label' }, t('레이어')),
    Array.from({ length: state.session.layers }, (_, i) => h('button', {
      type: 'button', class: i === state.layer ? 'active' : '', 'aria-pressed': String(i === state.layer), 'data-layer': i,
      onclick: () => { if (state.layer === i) return; state.layer = i; state.selected = null; refresh(); },
    }, String(i))));
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
    const u = (v) => `calc(${v} * var(--via-unit))`;
    // ISO 엔터처럼 사각형 두 개로 된 키: 두 사각형을 감싸는 상자에 각각을 그린다 (shape의 x2·y2는 키 위치 기준)
    const sh = !encoder && k.shape;
    const box = sh ? { x: Math.min(0, sh.x2), y: Math.min(0, sh.y2), r: Math.max(k.w, sh.x2 + sh.w2), b: Math.max(k.h, sh.y2 + sh.h2) } : null;
    const [bx, by, bw, bh] = box ? [k.x + box.x, k.y + box.y, box.r - box.x, box.b - box.y] : [x, k.y, encoder ? k.w / 2 : k.w, k.h];
    const part = (px, py, pw, ph) => h('span', { class: 'via-key-part', style: `left:${u(px - box.x)};top:${u(py - box.y)};width:calc(${pw} * var(--via-unit) - 3px);height:calc(${ph} * var(--via-unit) - 3px);` });
    return h('button', {
      type: 'button', class: `via-key ${k.color}${sh ? ' shaped' : ''}${code === 1 ? ' transparent' : ''}${changed ? ' changed' : ''}${selected && !test ? ' selected' : ''}`,
      'data-row': k.row, 'data-col': k.col, 'data-encoder': encoder ? k.encoder : null,
      title: `${label.title}${encoder ? cw ? ' ↻' : ' ↺' : ''}`, disabled: !test && (!s.editable || app.busy),
      'aria-pressed': test ? 'false' : String(!!selected),
      style: `left:${u(bx)};top:${u(by)};width:calc(${bw} * var(--via-unit) - 3px);height:calc(${bh} * var(--via-unit) - 3px);transform:rotate(${k.r}deg);transform-origin:${u(k.rx - bx)} ${u(k.ry - by)};`,
      onclick: () => {
        if (test || !s.editable || app.busy) return;
        state.selected = target;
        // 이미 조합 키면 조합 칸을 그 키의 조합으로 맞춘다
        const split = splitCombo(code);
        state.combo = split ? { ...split } : { ...state.combo, kind: 'none' };
        refresh();
      },
    }, ...(sh ? [part(0, 0, k.w, k.h), part(sh.x2, sh.y2, sh.w2, sh.h2), h('span', { class: 'via-key-label', style: `left:${u(-box.x)};top:${u(-box.y)};width:${u(k.w)};height:${u(k.h)};` }, label.label)]
      : [encoder ? `${cw ? '↻' : '↺'} ${label.label}` : label.label]));
  };
  return h('div', { class: 'via-keyboard-scroll' }, h('div', { class: 'via-keyboard', style: `width:calc(${s.def.width} * var(--via-unit));height:calc(${s.def.height} * var(--via-unit));` },
    s.keys().flatMap((k) => k.encoder !== undefined ? [keyButton(k, false), keyButton(k, true)] : keyButton(k))));
}

// 조합 칸이 켜져 있으면 기본 키를 그 조합으로 감싼다. 감쌀 수 없으면 알리고 null.
function applyCombo(code) {
  const c = state.combo;
  if (c.kind === 'none' || code > 0xff) return code;
  const out = c.kind === 'mods' ? withMods(c.mods, c.right, code) : c.kind === 'mt' ? modTap(c.mods, c.right, code) : layerTap(c.layer, code);
  if (out === null) toast(c.kind === 'lt' ? t('레이어를 고르세요.') : t('수정자를 하나 이상 고르세요.'), 'error');
  return out;
}

async function chooseCode(picked) {
  const s = state.session;
  const target = state.selected;
  if (!s?.editable || !target || app.busy) return;
  const code = applyCombo(picked);
  if (code === null) return;
  if (s.label(code).danger && !await ask(t('주의할 키 코드'), [s.label(code).title, t('이 키를 누르면 키보드가 재시작되거나 설정이 초기화될 수 있습니다.')], t('선택'))) return;
  if (state.session !== s || state.selected !== target) return;
  edit(() => {
    if (target.custom) s.setCustom(target.custom, code);
    else if (target.encoder !== undefined) s.setEncoder(state.layer, target.encoder, target.cw, code);
    else s.setKeycode(state.layer, target.row, target.col, code);
  });
}

// 키보드 모양 선택 칸의 배치(ANSI 텐키리스): [키 코드, 너비]. null은 빈 칸.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => [a + i]);
const PICK_ROWS = [
  [[0x29], [null, 1], ...range(0x3a, 0x3d), [null, 0.5], ...range(0x3e, 0x41), [null, 0.5], ...range(0x42, 0x45), [null, 0.25], ...range(0x46, 0x48)],
  [[0x35], ...range(0x1e, 0x27), [0x2d], [0x2e], [0x2a, 2], [null, 0.25], ...range(0x49, 0x4b)],
  [[0x2b, 1.5], ...[0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13, 0x2f, 0x30].map((c) => [c]), [0x31, 1.5], [null, 0.25], ...range(0x4c, 0x4e)],
  [[0x39, 1.75], ...[0x04, 0x16, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x33, 0x34].map((c) => [c]), [0x28, 2.25]],
  [[0xe1, 2.25], ...[0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x38].map((c) => [c]), [0xe5, 2.75], [null, 1.25], [0x52]],
  [[0xe0, 1.25], [0xe3, 1.25], [0xe2, 1.25], [0x2c, 6.25], [0xe6, 1.25], [0xe7, 1.25], [0x65, 1.25], [0xe4, 1.25], [null, 0.25], [0x50], [0x51], [0x4f]],
];

// 조합 만들기: 종류를 고른 뒤 기본 키를 누르면 그 조합이 지정된다
function comboPanel() {
  const c = state.combo;
  const set = (patch) => { state.combo = { ...c, ...patch }; refresh(); };
  const mods = c.kind === 'mods' || c.kind === 'mt';
  return h('div', { class: 'via-combo' },
    field(t('조합'), null, h('select', { id: 'via-combo-kind', onchange: (e) => set({ kind: e.target.value }) },
      [['none', t('조합 없음 (키 하나)')], ['mods', t('수정자 + 키 (예: Ctrl+C)')], ['mt', t('탭하면 키, 누르고 있으면 수정자')], ['lt', t('탭하면 키, 누르고 있으면 레이어')]]
        .map(([v, label]) => h('option', { value: v, selected: c.kind === v }, label)))),
    mods && h('div', { class: 'via-combo-mods', role: 'group', 'aria-label': t('수정자') },
      [[1, 'Ctrl'], [2, 'Shift'], [4, 'Alt'], [8, 'Win']].map(([bit, name]) => h('label', null,
        h('input', { type: 'checkbox', 'data-mod': bit, checked: !!(c.mods & bit), onchange: (e) => set({ mods: e.target.checked ? c.mods | bit : c.mods & ~bit }) }), ' ' + name)),
      h('select', { 'aria-label': t('왼쪽/오른쪽'), onchange: (e) => set({ right: e.target.value === 'right' }) },
        h('option', { value: 'left', selected: !c.right }, t('왼쪽')), h('option', { value: 'right', selected: c.right }, t('오른쪽')))),
    c.kind === 'lt' && h('div', { class: 'via-layers', role: 'group', 'aria-label': t('누르고 있을 때 레이어') },
      h('span', { class: 'via-layers-label' }, t('누르고 있을 때 레이어')),
      Array.from({ length: Math.min(16, state.session.layers) }, (_, i) => h('button', {
        type: 'button', class: i === c.layer ? 'active' : '', 'aria-pressed': String(i === c.layer), 'data-combo-layer': i, onclick: () => set({ layer: i }),
      }, String(i)))),
    c.kind !== 'none' && h('p', { class: 'hint' }, t('아래에서 기본 키를 누르면 이 조합으로 지정됩니다. 다른 묶음의 키는 그대로 지정됩니다.')));
}

function codePicker() {
  if (!state.selected || !state.session.editable) return null;
  const s = state.session;
  const groups = s.keycodeGroups();
  const buttons = h('div', { class: 'via-code-grid' });
  const search = h('input', { type: 'text', 'aria-label': t('키 찾기'), placeholder: t('키 찾기'), oninput: () => draw() });
  const pickButton = (k, width) => h('button', {
    type: 'button', title: k.title, class: k.danger ? 'danger' : '', disabled: app.busy, 'data-code': k.code, onclick: () => chooseCode(k.code),
    ...(width ? { style: `width:calc(${width} * var(--pick-unit) - 4px)` } : {}),
  }, k.label);
  const draw = () => {
    const term = search.value.toLowerCase();
    const group = groups.find((g) => g.id === state.group) || groups[0];
    // 기본 키는 키보드(ANSI 텐키리스) 모양으로 보여 준다
    if (!term && group.id === 'basic') {
      const byCode = new Map(group.keys.map((k) => [k.code, k]));
      buttons.className = 'via-pick-board';
      buttons.replaceChildren(
        h('div', { class: 'via-pick-row' }, [0x00, 0x01].map((c) => pickButton(byCode.get(c), 1.5))),
        ...PICK_ROWS.map((row) => h('div', { class: 'via-pick-row' }, row.map(([c, w = 1]) => (c === null
          ? h('span', { class: 'via-pick-gap', style: `width:calc(${w} * var(--pick-unit))` })
          : pickButton(byCode.get(c) || { code: c, ...s.label(c) }, w))))));
      return;
    }
    buttons.className = 'via-code-grid';
    buttons.replaceChildren(...(term ? groups.flatMap((g) => g.keys) : group.keys)
      .filter((k) => `${k.title} ${k.label}`.toLowerCase().includes(term)).map((k) => pickButton(k)));
  };
  const error = h('p', { class: 'notice', role: 'alert', hidden: true });
  const direct = h('input', { type: 'text', id: 'via-direct', placeholder: 'LT(1, KC_SPC)', 'aria-label': t('직접 입력') });
  draw();
  const current = state.selected.custom ? s.customValue(state.selected.custom)
    : state.selected.encoder !== undefined ? s.encoder(state.layer, state.selected.encoder, state.selected.cw) : s.keycode(state.layer, state.selected.row, state.selected.col);
  return h('section', { class: 'via-picker', 'aria-label': t('키 고르기') },
    h('h3', null, t('키 고르기')),
    h('p', { class: 'hint' }, t('지금: {name}', { name: s.label(current).title })),
    comboPanel(),
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

// 키 시험 중에는 누른 키가 브라우저 단축키(F1 도움말, F5 새로고침, Ctrl+F 찾기, Alt 메뉴 등)로 실행되지 않게 막는다.
// Ctrl+W·Ctrl+T·Alt+F4·Windows 키처럼 브라우저나 운영체제가 먼저 처리하는 조합은 웹 페이지에서 막을 수 없다.
const keyTesting = () => state.tab === 'test' && !!state.session && !!root?.isConnected && document.body.dataset.view === 'config';
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (e) => { if (keyTesting() && !e.target.closest?.('dialog')) e.preventDefault(); }, true);
}

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
      : [h('p', { class: 'hint', id: 'via-test-msg' }, t('키보드의 키를 눌러 확인하세요.')),
        h('p', { class: 'hint' }, t('시험하는 동안 F1·F5 같은 브라우저 단축키는 막습니다. Ctrl+W, Alt+F4, Windows 키처럼 브라우저나 운영체제가 먼저 처리하는 키는 막을 수 없습니다.')),
        keyboard(true)];
  root.replaceChildren(...[
    h('div', { class: 'via-heading' }, h('div', null, h('h2', null, s.def.name), h('p', { class: 'hint' }, `${hexId(s.def.vendorId, s.def.productId)} · VIA ${s.protocol}${sourceText() ? ` · ${sourceText()}` : ''}`)),
      h('button', { class: 'ghost', disabled: app.busy, onclick: async () => {
        // 저장하지 않은 편집은 「취소하고 돌아가기」로 돌아오면 그대로 남는다. 새 정의 파일을 불러올 때만 버려진다.
        suspend(); state.previous = { session: s, source: state.source }; state.session = null; state.error = ''; shell.refresh();
      } }, t('정의 파일 바꾸기')),
      h('button', { class: 'ghost', id: 'via-layout-export', disabled: app.busy, onclick: () => download(exportViaLayout(s), 'layout', s.def.name) }, t('VIA 파일 내보내기')),
      h('button', { class: 'ghost', id: 'via-layout-open', disabled: app.busy, onclick: () => root.querySelector('#via-layout-import').click() }, t('VIA 파일 불러오기')),
      h('input', { type: 'file', id: 'via-layout-import', accept: '.json,application/json', hidden: true,
        onchange: async (e) => { const file = e.target.files[0]; e.target.value = ''; if (file) await importLayoutFile(file); } })),
    !s.editable && h('p', { class: 'notice' }, t('이 키보드의 VIA 프로토콜({n})은 아직 편집하지 않습니다. 읽기만 합니다.', { n: s.protocol })),
    h('div', { class: 'stats via-stats' }, tile(t('레이어'), s.layers), tile(t('행렬'), `${s.def.rows} × ${s.def.cols}`), tile(t('매크로'), s.macroCount)),
    tabs(names, state.tab, (tab) => { suspend(); state.tab = tab; state.selected = null; refresh(); }, t('키보드 설정')),
    tabPanel(state.tab, body)].filter(Boolean));
  const fit = () => {
    root.style.setProperty('--via-unit', `${Math.max(12, Math.min(64, (root.clientWidth - 36) / s.def.width))}px`);
    root.style.setProperty('--pick-unit', `${Math.max(14, Math.min(46, (root.clientWidth - 48) / 18.5))}px`);
  };
  fit(); resizeObserver = new ResizeObserver(fit); resizeObserver.observe(root);
  if (state.tab === 'test' && document.body.dataset.view === 'config') startTest();
}

// VIA 레이아웃 파일을 편집본으로 불러온다 (저장해야 기록된다)
async function importLayoutFile(file) {
  const s = state.session;
  if (!s || app.busy) return;
  try {
    const json = JSON.parse(await file.text());
    if (state.session !== s) return;
    importViaLayout(s, json);
    toast(t('VIA 레이아웃을 불러왔습니다. 확인한 뒤 저장하세요.'), 'ok');
  } catch (e) {
    toast(e instanceof SyntaxError ? t('JSON 파일을 읽을 수 없습니다.') : e.message, 'error');
  }
  shell.refresh();
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
