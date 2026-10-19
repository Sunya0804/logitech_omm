// VIA 키보드 한 대의 읽은 값(orig)과 편집본(work), 저장. 화면(js/via-ui.js)은 이 객체만 써서 키보드를 다룬다.
// 다른 브랜드 화면과 같이, 편집은 저장을 누를 때 기기에 기록된다(VIA 원래 앱은 바로 기록한다).
import { isSupportedProtocol, keycodeLabel, keycodeGroups } from './via-keycodes.js';
import { parseDefinition, decodeLayoutOptions, encodeLayoutOptions, visibleKeys, encodeValue, decodeValue, evaluateShowIf } from './via-definition.js';
import { decodeMacro, decodeMacros, encodeMacros, encodeMacro } from './via-macro.js';
import { t } from './i18n.js';

const BACKUP_TYPE = 'gomm-via-backup';
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => (/^([0-9a-f]{2})*$/i.test(text) ? Uint8Array.from(text.match(/../g) || [], (h) => parseInt(h, 16)) : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => structuredClone(v);
const encoderKey = (layer, index, cw) => `${layer},${index},${cw ? 1 : 0}`;

class ViaSession {
  // dev: ViaDevice (열린 것), definition: 정의 파일 JSON
  constructor(dev, definition) {
    this.dev = dev;
    this.json = definition;
    this.def = parseDefinition(definition);
    if (this.def.vendorId !== dev.vendorId || this.def.productId !== dev.productId) {
      throw new Error(t('이 정의 파일은 다른 키보드의 것입니다 (파일 {file}, 기기 {device}).', {
        file: hexId(this.def.vendorId, this.def.productId), device: hexId(dev.vendorId, dev.productId),
      }));
    }
    this.orig = null;
    this.work = null;
  }

  // 키보드에서 모두 읽는다. setMsg(문구)로 진행 상황을 알린다.
  async load(setMsg = () => {}) {
    const { dev, def } = this;
    setMsg(t('키보드 정보 읽는 중…'));
    this.protocol = await dev.protocolVersion();
    this.editable = isSupportedProtocol(this.protocol);
    this.layers = await dev.layerCount();
    if (!this.layers || this.layers > 32) throw new Error(t('키보드가 알려 준 레이어 수({n})가 올바르지 않습니다.', { n: this.layers }));
    setMsg(t('키맵 읽는 중…'));
    const keymap = Array.from(await dev.readKeymap(this.layers, def.rows, def.cols));
    const encoders = {};
    const encoderIds = [...new Set([...def.keys, ...def.optionKeys.flatMap((o) => Object.values(o).flat())].filter((k) => k.encoder !== undefined).map((k) => k.encoder))];
    for (let layer = 0; layer < this.layers; layer++) {
      for (const index of encoderIds) {
        for (const cw of [false, true]) encoders[encoderKey(layer, index, cw)] = await dev.getEncoder(layer, index, cw);
      }
    }
    const options = def.options.length ? decodeLayoutOptions(await dev.layoutOptions(), def.options) : [];
    setMsg(t('매크로 읽는 중…'));
    this.macroCount = await dev.macroCount().catch(() => 0);
    this.macroBufferSize = this.macroCount ? await dev.macroBufferSize() : 0;
    const macros = this.macroCount ? decodeMacros(await dev.readMacroBuffer(this.macroBufferSize), this.macroCount) : [];
    setMsg(t('조명·설정 값 읽는 중…'));
    const custom = {};
    for (const item of def.menus.items) {
      if (item.action) continue; // 초기화 같은 동작은 값으로 읽지 않는다
      custom[item.id] = decodeValue(item, await dev.customGet(item.head, item.size));
    }
    this.firmware = await dev.firmwareVersion().catch(() => null);
    this.orig = { keymap, encoders, options, macros: macros.map(stored), custom };
    this.work = clone(this.orig);
  }

  // ---------- 읽기 ----------

  index(layer, row, col) { return (layer * this.def.rows + row) * this.def.cols + col; }
  keycode(layer, row, col) { return this.work.keymap[this.index(layer, row, col)]; }
  encoder(layer, index, cw) { return this.work.encoders[encoderKey(layer, index, cw)]; }
  // 지금 레이아웃 옵션으로 보이는 키
  keys() { return visibleKeys(this.def, this.work.options); }
  label(code) { return keycodeLabel(code, { customKeycodes: this.def.customKeycodes }); }
  keycodeGroups() {
    return keycodeGroups({ layers: this.layers, macroCount: this.macroCount, customKeycodes: this.def.customKeycodes, lighting: this.def.lighting });
  }
  // 매크로 i: {steps, editable, pending}. 읽을 수 없는 매크로는 읽을 수 있는 앞부분만 steps에 있다.
  macro(i) {
    const m = this.work.macros[i];
    const steps = m.steps || decodeMacro(fromHex(m.hex)).steps;
    return { steps, editable: !!m.steps, pending: !same(m, this.orig.macros[i]) };
  }
  macroBytesUsed() {
    return this.work.macros.reduce((n, m) => n + (m.steps ? encodeMacro(m.steps).length : fromHex(m.hex).length) + 1, 0);
  }
  customValue(id) { return this.work.custom[id]; }
  // 메뉴 항목이 지금 값들에서 보이는지 (showIf)
  itemVisible(item) { return evaluateShowIf(item.showIf, this.work.custom); }

  // ---------- 편집 ----------

  needEditable() { if (!this.editable) throw new Error(t('VIA 프로토콜 {n}은 키 코드 체계가 달라 편집할 수 없습니다.', { n: this.protocol })); }
  setKeycode(layer, row, col, code) {
    this.needEditable();
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) throw new Error(t('키 코드가 범위를 벗어났습니다.'));
    this.work.keymap[this.index(layer, row, col)] = code;
  }
  setEncoder(layer, index, cw, code) {
    this.needEditable();
    const key = encoderKey(layer, index, cw);
    if (!(key in this.work.encoders)) throw new Error(t('없는 인코더입니다.'));
    this.work.encoders[key] = code;
  }
  setLayoutOption(i, choice) {
    const o = this.def.options[i];
    if (!o || !Number.isInteger(choice) || choice < 0 || choice >= o.choices.length) throw new Error(t('레이아웃 옵션이 범위를 벗어났습니다.'));
    this.work.options[i] = choice;
  }
  // steps를 null로 주면 기기에 있던 대로 되돌린다
  setMacro(i, steps) {
    if (i < 0 || i >= this.macroCount) throw new Error(t('없는 매크로 칸입니다.'));
    const macros = this.work.macros.slice();
    macros[i] = steps ? { steps: clone(steps) } : clone(this.orig.macros[i]);
    encodeMacros(macros.map(storedForEncode), this.macroBufferSize); // 넘치거나 넣을 수 없는 단계면 여기서 알리고 바꾸지 않는다
    this.work.macros = macros;
  }
  // 매크로 여러 칸을 한 번에 바꾼다 (칸마다 바꾸면 중간에 잠시 저장 공간을 넘을 수 있어서). 비어 있는 자리는 그대로 둔다.
  setMacros(stepsList) {
    const macros = this.work.macros.map((m, i) => (stepsList[i] ? { steps: clone(stepsList[i]) } : m));
    encodeMacros(macros.map(storedForEncode), this.macroBufferSize);
    this.work.macros = macros;
  }
  setCustom(id, value) {
    const item = this.def.menus.items.find((x) => x.id === id);
    if (!item) throw new Error(t('없는 설정 항목입니다.'));
    this.work.custom[id] = clone(value);
  }

  // ---------- 바뀐 것 ----------

  changes() {
    const out = [];
    const { orig, work, def } = this;
    work.keymap.forEach((code, i) => {
      if (code === orig.keymap[i]) return;
      const layer = Math.floor(i / (def.rows * def.cols));
      out.push({ kind: 'key', layer, row: Math.floor(i / def.cols) % def.rows, col: i % def.cols, from: orig.keymap[i], to: code });
    });
    for (const [key, code] of Object.entries(work.encoders)) {
      if (code !== orig.encoders[key]) { const [layer, index, cw] = key.split(',').map(Number); out.push({ kind: 'encoder', layer, index, cw: !!cw, from: orig.encoders[key], to: code }); }
    }
    if (!same(work.options, orig.options)) out.push({ kind: 'options', from: orig.options, to: work.options });
    work.macros.forEach((m, i) => { if (!same(m, orig.macros[i])) out.push({ kind: 'macro', index: i }); });
    for (const item of def.menus.items) {
      if (item.id in work.custom && !same(work.custom[item.id], orig.custom[item.id])) out.push({ kind: 'custom', id: item.id, item, danger: item.danger });
    }
    return out;
  }
  isDirty() { return !!this.work && this.changes().length > 0; }
  revert() { this.work = clone(this.orig); }

  // ---------- 저장 ----------

  // 바뀐 것만 기록한다. 순서: 레이아웃 옵션 → 키 → 인코더 → 매크로 → 조명·설정(값을 쓰고 채널마다 저장 명령).
  // 키와 매크로는 기록한 뒤 다시 읽어 대조한다. 부분마다 성공하면 orig에 반영해서, 중간에 실패해도 남은 것만 다시 저장된다.
  async save(setMsg = () => {}) {
    const { dev, def } = this;
    const list = this.changes();
    if (list.some((c) => c.kind === 'key' || c.kind === 'encoder')) this.needEditable();
    if (list.some((c) => c.kind === 'options')) {
      setMsg(t('레이아웃 옵션 기록 중…'));
      await dev.setLayoutOptions(encodeLayoutOptions(this.work.options, def.options));
      this.orig.options = clone(this.work.options);
    }
    const keys = list.filter((c) => c.kind === 'key');
    if (keys.length) setMsg(t('키 {n}개 기록 중…', { n: keys.length }));
    for (const c of keys) {
      await dev.setKeycode(c.layer, c.row, c.col, c.to);
      const back = await dev.getKeycode(c.layer, c.row, c.col);
      if (back !== c.to) throw new Error(t('키({layer}층 {row},{col})가 기기에 그대로 기록되지 않았습니다.', { layer: c.layer, row: c.row, col: c.col }));
      this.orig.keymap[this.index(c.layer, c.row, c.col)] = c.to;
    }
    for (const c of list.filter((x) => x.kind === 'encoder')) {
      await dev.setEncoder(c.layer, c.index, c.cw, c.to);
      this.orig.encoders[encoderKey(c.layer, c.index, c.cw)] = c.to;
    }
    if (list.some((c) => c.kind === 'macro')) {
      setMsg(t('매크로 기록 중…'));
      const bytes = encodeMacros(this.work.macros.map(storedForEncode), this.macroBufferSize);
      await dev.writeMacroBuffer(bytes);
      const back = await dev.readMacroBuffer(this.macroBufferSize);
      if (back.some((b, i) => b !== bytes[i])) throw new Error(t('매크로가 기기에 그대로 기록되지 않았습니다.'));
      this.orig.macros = clone(this.work.macros);
    }
    const custom = list.filter((c) => c.kind === 'custom');
    if (custom.length) setMsg(t('조명·설정 기록 중…'));
    const channels = new Set();
    for (const c of custom) {
      await dev.customSet(c.item.head, encodeValue(c.item, this.work.custom[c.id]));
      channels.add(c.item.head[0]);
      this.orig.custom[c.id] = clone(this.work.custom[c.id]);
    }
    for (const channel of channels) await dev.customSave(channel);
  }

  // ---------- 키 시험 ----------

  matrixState() { return this.dev.switchMatrix(this.def.rows, this.def.cols, this.protocol); }

  // ---------- 백업 ----------

  exportBackup() {
    const { def, orig } = this;
    return {
      type: BACKUP_TYPE, version: 1, exportedAt: new Date().toISOString(), name: def.name,
      vendorId: def.vendorId, productId: def.productId, protocol: this.protocol, layers: this.layers, rows: def.rows, cols: def.cols,
      keymap: orig.keymap, encoders: orig.encoders, layoutOptions: orig.options,
      macros: orig.macros.map((m) => (m.steps ? toHex(encodeMacro(m.steps)) : m.hex)),
      custom: orig.custom,
    };
  }

  // 백업을 편집본으로 불러온다 (저장해야 기기에 기록된다). 맞지 않는 백업이면 오류를 던진다.
  importBackup(b) {
    const { def } = this;
    if (!b || b.type !== BACKUP_TYPE || b.version !== 1) throw new Error(t('GOMM VIA 백업 파일이 아닙니다.'));
    if (b.vendorId !== def.vendorId || b.productId !== def.productId) throw new Error(t('다른 키보드의 백업입니다.'));
    if (b.layers !== this.layers || b.rows !== def.rows || b.cols !== def.cols) throw new Error(t('레이어 수나 행렬 크기가 이 키보드와 다른 백업입니다.'));
    const size = this.layers * def.rows * def.cols;
    if (!Array.isArray(b.keymap) || b.keymap.length !== size || !b.keymap.every((c) => Number.isInteger(c) && c >= 0 && c <= 0xffff)) throw new Error(t('백업의 키맵이 올바르지 않습니다.'));
    const work = clone(this.orig);
    work.keymap = b.keymap.slice();
    for (const key of Object.keys(work.encoders)) if (Number.isInteger(b.encoders?.[key])) work.encoders[key] = b.encoders[key];
    if (Array.isArray(b.layoutOptions) && b.layoutOptions.length === def.options.length
      && b.layoutOptions.every((c, i) => Number.isInteger(c) && c >= 0 && c < def.options[i].choices.length)) work.options = b.layoutOptions.slice();
    if (Array.isArray(b.macros) && b.macros.length === this.macroCount) {
      const bytes = b.macros.map(fromHex);
      if (bytes.some((x) => !x || x.includes(0))) throw new Error(t('백업의 매크로가 올바르지 않습니다.'));
      work.macros = bytes.map((x) => { const d = decodeMacro(x); return d.editable ? { steps: d.steps } : { hex: toHex(x) }; });
      encodeMacros(work.macros.map(storedForEncode), this.macroBufferSize);
    }
    for (const item of def.menus.items) {
      if (!item.danger && b.custom && item.id in b.custom && item.id in work.custom) work.custom[item.id] = clone(b.custom[item.id]); // 연결 방식 같은 위험 항목은 백업에서 되돌리지 않는다
    }
    if (!this.editable && !same(work.keymap, this.orig.keymap)) this.needEditable();
    this.work = work;
  }
}

// 기기에서 읽은 매크로를 저장해 두는 모양: 편집할 수 있으면 {steps}, 아니면 원래 바이트 {hex}
function stored(m) { return m.editable ? { steps: m.steps } : { hex: toHex(m.bytes) }; }
function storedForEncode(m) { return m.steps ? { steps: m.steps } : { bytes: fromHex(m.hex) }; }
function hexId(vendorId, productId) { return [vendorId, productId].map((v) => v.toString(16).padStart(4, '0').toUpperCase()).join(':'); }

export { ViaSession, BACKUP_TYPE };
