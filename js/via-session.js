// VIA 키보드 한 대의 읽은 값(orig)과 편집본(work), 저장. 화면(js/via-ui.js)은 이 객체만 써서 키보드를 다룬다.
// 다른 브랜드 화면과 같이, 편집은 저장을 누를 때 기기에 기록된다(VIA 원래 앱은 바로 기록한다).
import { isSupportedProtocol, keycodeLabel, keycodeGroups } from './via-keycodes.js';
import { parseDefinition, decodeLayoutOptions, encodeLayoutOptions, visibleKeys, encodeValue, decodeValue, evaluateShowIf } from './via-definition.js';
import { decodeMacro, decodeMacros, encodeMacros, encodeMacro } from './via-macro.js';
import { WIDTH as SETTING_WIDTH } from './vial-settings.js';
import { decompress } from './xz.js';
import { t } from './i18n.js';

const BACKUP_TYPE = 'gomm-via-backup';
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => (/^([0-9a-f]{2})*$/i.test(text) ? Uint8Array.from(text.match(/../g) || [], (h) => parseInt(h, 16)) : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => structuredClone(v);
const encoderKey = (layer, index, cw) => `${layer},${index},${cw ? 1 : 0}`;
const QK_BOOT = 0x7c00;
// Vial 동적 항목: 편집본의 목록 이름 → 기기 명령, 키 코드가 들어 있는 칸
const VIAL_LISTS = {
  tapDance: { get: 'tapDanceGet', set: 'tapDanceSet', codes: (e) => [e.onTap, e.onHold, e.onDoubleTap, e.onTapHold] },
  combos: { get: 'comboGet', set: 'comboSet', codes: (e) => [...e.keys, e.output] },
  keyOverrides: { get: 'keyOverrideGet', set: 'keyOverrideSet', codes: (e) => [e.trigger, e.replacement] },
};
// 항목을 정해진 칸 순서로 맞춘다 (백업 파일 등에서 칸 순서가 달라도 같은 값이면 같게 본다)
const VIAL_FIELDS = {
  tapDance: ['onTap', 'onHold', 'onDoubleTap', 'onTapHold', 'term'],
  combos: ['keys', 'output'],
  keyOverrides: ['trigger', 'replacement', 'layers', 'triggerMods', 'negativeMods', 'suppressedMods', 'options'],
};
const vialEntry = (list, e) => Object.fromEntries(VIAL_FIELDS[list].map((k) => [k, clone(e[k])]));
const isU16 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffff;
const isU8 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xff;
// 각 항목의 모양 검사 (키 코드·시간은 2바이트, 수정자·옵션은 1바이트)
const VIAL_SHAPE = {
  tapDance: (e) => ['onTap', 'onHold', 'onDoubleTap', 'onTapHold', 'term'].every((k) => isU16(e[k])),
  combos: (e) => Array.isArray(e.keys) && e.keys.length === 4 && e.keys.every(isU16) && isU16(e.output),
  keyOverrides: (e) => ['trigger', 'replacement', 'layers'].every((k) => isU16(e[k])) && ['triggerMods', 'negativeMods', 'suppressedMods', 'options'].every((k) => isU8(e[k])),
};

class ViaSession {
  // dev: ViaDevice (열린 것), definition: 정의 파일 JSON, vial: Vial 키보드면 dev.vialId()의 결과
  constructor(dev, definition, vial = null) {
    this.dev = dev;
    this.vial = vial;
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
    // Vial 키보드는 VIA 프로토콜을 9로 알리지만, Vial 프로토콜 6부터 QMK 0.19 이후 키 코드를 쓴다.
    this.editable = this.vial ? this.vial.protocol >= 6 : isSupportedProtocol(this.protocol);
    this.layers = await dev.layerCount();
    if (!this.layers || this.layers > 32) throw new Error(t('키보드가 알려 준 레이어 수({n})가 올바르지 않습니다.', { n: this.layers }));
    setMsg(t('키맵 읽는 중…'));
    const keymap = Array.from(await dev.readKeymap(this.layers, def.rows, def.cols));
    const encoders = {};
    const encoderIds = [...new Set([...def.keys, ...def.optionKeys.flatMap((o) => Object.values(o).flat())].filter((k) => k.encoder !== undefined).map((k) => k.encoder))];
    for (let layer = 0; layer < this.layers; layer++) {
      for (const index of encoderIds) {
        for (const cw of [false, true]) encoders[encoderKey(layer, index, cw)] = this.vial ? await dev.vialGetEncoder(layer, index, cw) : await dev.getEncoder(layer, index, cw);
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
    const vial = this.vial ? await this.loadVial(setMsg) : null;
    this.orig = { keymap, encoders, options, macros: macros.map(stored), custom, ...(vial ? { vial } : {}) };
    this.work = clone(this.orig);
  }

  // Vial: 잠금 상태, 탭 댄스·콤보·키 오버라이드(프로토콜 4·5부터), 이 앱이 아는 QMK 설정
  async loadVial(setMsg) {
    const { dev } = this;
    setMsg(t('Vial 기능 읽는 중…'));
    await this.refreshUnlock();
    this.vialCounts = this.vial.protocol >= 4 ? await dev.vialDynamicCounts() : { tapDance: 0, combo: 0, keyOverride: 0 };
    const list = async (count, get) => { const out = []; for (let i = 0; i < count; i++) out.push(await dev[get](i)); return out; };
    const settings = {};
    if (this.vial.protocol >= 4) {
      for (const id of await dev.qmkSettingsList()) {
        if (!SETTING_WIDTH.has(id)) continue;
        const v = await dev.qmkSettingGet(id, SETTING_WIDTH.get(id));
        if (v !== null) settings[id] = v;
      }
    }
    return {
      tapDance: await list(this.vialCounts.tapDance, 'tapDanceGet'),
      combos: await list(this.vialCounts.combo, 'comboGet'),
      keyOverrides: await list(this.vialCounts.keyOverride, 'keyOverrideGet'),
      settings,
    };
  }

  // ---------- Vial 잠금 ----------
  // 잠겨 있으면 키보드가 매크로 기록, 키 시험(스위치 상태), QK_BOOT 지정을 받지 않는다.

  async refreshUnlock() {
    if (!this.vial) return { unlocked: true, inProgress: false, keys: [] };
    const s = await this.dev.vialUnlockStatus();
    this.unlocked = s.unlocked;
    this.unlockKeys = s.keys;
    return s;
  }
  startUnlock() { return this.dev.vialUnlockStart(); }
  async pollUnlock() { const r = await this.dev.vialUnlockPoll(); if (r.unlocked) this.unlocked = true; return r; }
  locked() { return !!this.vial && !this.unlocked; }
  // 저장하려면 잠금을 풀어야 하는 변경이 있는지
  needsUnlock(list = this.changes()) {
    if (!this.locked()) return false;
    const { work } = this;
    return list.some((c) => c.kind === 'macro' || ((c.kind === 'key' || c.kind === 'encoder') && c.to === QK_BOOT)
      || (c.kind === 'vial' && VIAL_LISTS[c.list].codes(work.vial[c.list][c.index]).includes(QK_BOOT)));
  }
  // ---------- 읽기 ----------

  index(layer, row, col) { return (layer * this.def.rows + row) * this.def.cols + col; }
  keycode(layer, row, col) { return this.work.keymap[this.index(layer, row, col)]; }
  encoder(layer, index, cw) { return this.work.encoders[encoderKey(layer, index, cw)]; }
  // 지금 레이아웃 옵션으로 보이는 키
  keys() { return visibleKeys(this.def, this.work.options); }
  label(code) { return keycodeLabel(code, { customKeycodes: this.def.customKeycodes }); }
  keycodeGroups() {
    return keycodeGroups({ layers: this.layers, macroCount: this.macroCount, customKeycodes: this.def.customKeycodes, lighting: this.def.lighting, tapDanceCount: this.vialCounts?.tapDance || 0 });
  }
  vialEntry(list, i) { return this.work.vial?.[list]?.[i]; }
  qmkSetting(qsid) { return this.work.vial?.settings[qsid]; }
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
  // Vial 항목 하나를 고친다. patch는 바꿀 칸만 담는다 (예: {onHold: 0x00e1}).
  setVialEntry(list, i, patch) {
    const entries = this.work.vial?.[list];
    if (!entries || !entries[i]) throw new Error(t('없는 Vial 항목입니다.'));
    const next = vialEntry(list, { ...entries[i], ...patch });
    if (!VIAL_SHAPE[list](next)) throw new Error(t('Vial 항목의 값이 범위를 벗어났습니다.'));
    if (!same(VIAL_LISTS[list].codes(next), VIAL_LISTS[list].codes(entries[i]))) this.needEditable();
    entries[i] = next;
  }
  setQmkSetting(qsid, value) {
    const width = SETTING_WIDTH.get(qsid);
    if (!this.work.vial || !(qsid in this.work.vial.settings) || !Number.isInteger(value) || value < 0 || value >= 256 ** width) {
      throw new Error(t('QMK 설정 값이 범위를 벗어났습니다.'));
    }
    this.work.vial.settings[qsid] = value;
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
    if (work.vial) {
      for (const list of Object.keys(VIAL_LISTS)) {
        work.vial[list].forEach((e, index) => { if (!same(e, orig.vial[list][index])) out.push({ kind: 'vial', list, index }); });
      }
      for (const [qsid, v] of Object.entries(work.vial.settings)) if (v !== orig.vial.settings[qsid]) out.push({ kind: 'qmk', qsid: +qsid });
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
    if (this.needsUnlock(list)) throw new Error(t('매크로나 QK_BOOT 키를 저장하려면 먼저 Vial 잠금을 풀어야 합니다.'));
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
      if (this.vial) await dev.vialSetEncoder(c.layer, c.index, c.cw, c.to);
      else await dev.setEncoder(c.layer, c.index, c.cw, c.to);
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
    // Vial 항목과 QMK 설정: 기록한 뒤 다시 읽어 대조한다
    const vial = list.filter((c) => c.kind === 'vial');
    if (vial.length) setMsg(t('Vial 항목 기록 중…'));
    for (const c of vial) {
      const { get, set } = VIAL_LISTS[c.list];
      const want = this.work.vial[c.list][c.index];
      await dev[set](c.index, want);
      if (!same(await dev[get](c.index), want)) throw new Error(t('Vial 항목이 기기에 그대로 기록되지 않았습니다.'));
      this.orig.vial[c.list][c.index] = clone(want);
    }
    for (const c of list.filter((x) => x.kind === 'qmk')) {
      const value = this.work.vial.settings[c.qsid];
      const width = SETTING_WIDTH.get(c.qsid);
      await dev.qmkSettingSet(c.qsid, width, value);
      if (await dev.qmkSettingGet(c.qsid, width) !== value) throw new Error(t('QMK 설정이 기기에 그대로 기록되지 않았습니다.'));
      this.orig.vial.settings[c.qsid] = value;
    }
  }

  // ---------- 키 시험 ----------

  matrixState() {
    if (this.locked()) return Promise.reject(new Error(t('Vial 키보드는 잠금을 푼 뒤에 키 시험을 할 수 있습니다.')));
    return this.dev.switchMatrix(this.def.rows, this.def.cols, this.protocol);
  }

  // ---------- 백업 ----------

  exportBackup() {
    const { def, orig } = this;
    return {
      type: BACKUP_TYPE, version: 1, exportedAt: new Date().toISOString(), name: def.name,
      vendorId: def.vendorId, productId: def.productId, protocol: this.protocol, layers: this.layers, rows: def.rows, cols: def.cols,
      keymap: orig.keymap, encoders: orig.encoders, layoutOptions: orig.options,
      macros: orig.macros.map((m) => (m.steps ? toHex(encodeMacro(m.steps)) : m.hex)),
      custom: orig.custom,
      ...(orig.vial ? { vial: orig.vial } : {}),
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
    if (work.vial && b.vial) {
      // 칸 수가 같은 목록만, 모양이 맞는 항목만 옮긴다. QMK 설정은 이 키보드가 지원하는 번호만.
      for (const list of Object.keys(VIAL_LISTS)) {
        const from = b.vial[list];
        if (Array.isArray(from) && from.length === work.vial[list].length) {
          if (!from.every((e) => e && VIAL_SHAPE[list](e))) throw new Error(t('백업의 Vial 항목이 올바르지 않습니다.'));
          work.vial[list] = from.map((e) => vialEntry(list, e));
        }
      }
      for (const qsid of Object.keys(work.vial.settings)) {
        const v = b.vial.settings?.[qsid];
        if (Number.isInteger(v) && v >= 0 && v < 256 ** SETTING_WIDTH.get(+qsid)) work.vial.settings[qsid] = v;
      }
    }
    if (!this.editable && !same(work.keymap, this.orig.keymap)) this.needEditable();
    this.work = work;
  }
}

// Vial 키보드면 {vial, json}: 펌웨어에 든 정의 파일을 풀어 제조사·제품 ID와 이름을 채운다. Vial이 아니면 null.
// Vial 펌웨어는 VIA 프로토콜을 9로 알린다. 다른 프로토콜의 키보드에는 Vial 명령(0xFE)을 보내지 않는다.
async function readVialDefinition(dev, protocol) {
  if (protocol !== 9) return null;
  const vial = await dev.vialId();
  if (!vial) return null;
  let json;
  try { json = JSON.parse(new TextDecoder().decode(decompress(await dev.vialDefinition()))); }
  catch (e) { throw new Error(t('Vial 키보드의 정의 파일을 읽지 못했습니다: {error}', { error: e.message })); }
  if (!json || typeof json !== 'object') throw new Error(t('Vial 키보드의 정의 파일을 읽지 못했습니다: {error}', { error: 'JSON' }));
  return { vial, json: { ...json, name: json.name || dev.name, vendorProductId: dev.vendorProductId } };
}

// 기기에서 읽은 매크로를 저장해 두는 모양: 편집할 수 있으면 {steps}, 아니면 원래 바이트 {hex}
function stored(m) { return m.editable ? { steps: m.steps } : { hex: toHex(m.bytes) }; }
function storedForEncode(m) { return m.steps ? { steps: m.steps } : { bytes: fromHex(m.hex) }; }
function hexId(vendorId, productId) { return [vendorId, productId].map((v) => v.toString(16).padStart(4, '0').toUpperCase()).join(':'); }

export { ViaSession, BACKUP_TYPE, readVialDefinition };
