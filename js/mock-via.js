// 시험·데모용 가상 VIA 키보드. WebHID HIDDevice와 같은 모양으로 via.js의 명령에 답한다. 모두 메모리 안에서만 동작한다.
// 기본값은 실기기(Qwertykeys QK80 MK2)에서 읽은 크기를 따른다: 프로토콜 12, 6×16 행렬, 레이어 4, 매크로 16칸·3079바이트.
// vial 옵션을 주면 Vial 펌웨어처럼 VIA 프로토콜 9로 답하고 0xFE 명령을 받는다. 잠겨 있으면 vial-qmk처럼
// 매크로 기록·스위치 상태 요청을 무시하고(받은 그대로 돌려준다) QK_BOOT 지정을 0으로 바꾼다.
import { CMD, VALUE, VIAL, DYNAMIC } from './via.js';

const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

class MockViaDevice {
  constructor(o = {}) {
    this.vendorId = o.vendorId ?? 0x514b;
    this.productId = o.productId ?? 0x4d02;
    this.productName = o.productName ?? 'QK80 MK2';
    this.collections = [{ usagePage: 0xff60, usage: 0x61, inputReports: [{ reportId: 0 }], outputReports: [{ reportId: 0 }], featureReports: [] }];
    // vial: {protocol, uid, packed(xz, base64), unlockKeys, unlocked, tapDance, combos, keyOverrides, settings: {qsid: [폭, 값]}}
    this.vial = o.vial ? { protocol: 6, uid: [1, 2, 3, 4, 5, 6, 7, 8], unlockKeys: [[0, 0], [0, 1]], unlocked: false, tapDance: [], combos: [], keyOverrides: [], settings: {}, ...structuredClone(o.vial) } : null;
    if (this.vial) { this.vial.definition = fromBase64(this.vial.packed); this.vial.inProgress = false; this.vial.counter = 0; }
    this.protocol = o.protocol ?? (this.vial ? 9 : 12);
    this.rows = o.rows ?? 6;
    this.cols = o.cols ?? 16;
    this.layers = o.layers ?? 4;
    this.keymap = Uint16Array.from(o.keymap ?? Array.from({ length: this.layers * this.rows * this.cols }, (_, i) => (i < this.rows * this.cols ? 0x04 + (i % 26) : 0x01)));
    this.macroCount = o.macroCount ?? 16;
    this.macroBuffer = new Uint8Array(o.macroBufferSize ?? 3079);
    if (o.macroBuffer) this.macroBuffer.set(o.macroBuffer);
    this.layoutOptions = o.layoutOptions ?? 0;
    this.custom = new Map(Object.entries(o.custom ?? {})); // "채널,값" → [바이트…]
    this.encoders = new Map(Object.entries(o.encoders ?? {})); // "레이어,번호,방향" → 키 코드
    this.matrix = o.matrix ?? null; // 눌린 스위치 [[행, 열]…]
    this.opened = false;
    this.listeners = new Set();
    this.log = []; // 받은 쓰기 명령 [명령, 바이트…]
    this.saved = []; // 저장 명령을 받은 채널
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(type, fn) { if (type === 'inputreport') this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }

  async sendReport(reportId, data) {
    const p = new Uint8Array(data);
    const r = new Uint8Array(32);
    r.set(p.subarray(0, 32));
    if (reportId !== 0 || p.length !== 32) r[0] = CMD.UNHANDLED;
    else this._handle(p, r);
    const event = { reportId: 0, data: new DataView(r.buffer) };
    queueMicrotask(() => this.listeners.forEach((fn) => fn(event)));
  }

  get locked() { return !!this.vial && !this.vial.unlocked; }

  _vial(p, r) {
    const v = this.vial;
    r.fill(0);
    switch (p[1]) {
      case VIAL.KEYBOARD_ID: r.set([v.protocol & 0xff, 0, 0, 0, ...v.uid], 0); break;
      case VIAL.SIZE: { const n = v.definition.length; r.set([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0], 0); break; }
      case VIAL.DEFINITION: { const start = (p[2] | (p[3] << 8)) * 32; r.set(v.definition.subarray(start, start + 32), 0); break; }
      case VIAL.GET_ENCODER: for (const cw of [0, 1]) { const c = this.encoders.get(`${p[2]},${p[3]},${cw}`) ?? 0; r.set([c >> 8, c & 0xff], 2 * cw); } break;
      case VIAL.SET_ENCODER: this.encoders.set(`${p[2]},${p[3]},${p[4]}`, this._firewall((p[5] << 8) | p[6])); this.log.push(Array.from(p.subarray(0, 7))); break;
      case VIAL.UNLOCK_STATUS:
        r.fill(0xff); r[0] = v.unlocked ? 1 : 0; r[1] = v.inProgress ? 1 : 0;
        v.unlockKeys.forEach(([row, col], i) => r.set([row, col], 2 + 2 * i));
        break;
      case VIAL.UNLOCK_START: v.inProgress = true; v.counter = 3; break;
      case VIAL.UNLOCK_POLL: {
        const held = v.unlockKeys.every(([row, col]) => (this.matrix || []).some(([a, b]) => a === row && b === col));
        if (v.inProgress) { if (held) v.counter -= 1; else v.counter = 3; if (v.counter === 0) { v.inProgress = false; v.unlocked = true; } }
        r.set([v.unlocked ? 1 : 0, v.inProgress ? 1 : 0, v.counter], 0);
        break;
      }
      case VIAL.SETTINGS_QUERY: {
        const after = p[2] | (p[3] << 8);
        r.fill(0xff);
        Object.keys(v.settings).map(Number).filter((id) => id > after).sort((a, b) => a - b).slice(0, 16).forEach((id, i) => r.set(le16(id), 2 * i));
        break;
      }
      case VIAL.SETTINGS_GET: {
        const s = v.settings[p[2] | (p[3] << 8)];
        if (!s) { r[0] = 1; break; }
        for (let i = 0; i < s[0]; i++) r[1 + i] = Math.floor(s[1] / 256 ** i) & 0xff;
        break;
      }
      case VIAL.SETTINGS_SET: {
        const s = v.settings[p[2] | (p[3] << 8)];
        if (!s) { r[0] = 1; break; }
        s[1] = Array.from(p.subarray(4, 4 + s[0])).reduceRight((n, b) => n * 256 + b, 0);
        this.log.push(Array.from(p.subarray(0, 4 + s[0])));
        break;
      }
      case VIAL.DYNAMIC: this._dynamic(p, r); break;
      default: r.set(p); // 모르는 Vial 명령
    }
  }

  _dynamic(p, r) {
    const v = this.vial;
    const u16 = (o) => p[o] | (p[o + 1] << 8);
    const lists = { [DYNAMIC.TAP_DANCE_GET]: 'tapDance', [DYNAMIC.COMBO_GET]: 'combos', [DYNAMIC.KEY_OVERRIDE_GET]: 'keyOverrides' };
    const op = p[2];
    if (op === DYNAMIC.COUNTS) { r.set([v.tapDance.length, v.combos.length, v.keyOverrides.length, 0], 0); return; }
    const list = lists[op] || lists[op - 1];
    const entry = v[list]?.[p[3]];
    if (!entry) { r[0] = 1; return; }
    const fw = (c) => this._firewall(c);
    if (lists[op]) {
      const bytes = list === 'tapDance' ? [entry.onTap, entry.onHold, entry.onDoubleTap, entry.onTapHold, entry.term].flatMap(le16)
        : list === 'combos' ? [...entry.keys, entry.output].flatMap(le16)
          : [...le16(entry.trigger), ...le16(entry.replacement), ...le16(entry.layers), entry.triggerMods, entry.negativeMods, entry.suppressedMods, entry.options];
      r.set(bytes, 1);
      return;
    }
    if (list === 'tapDance') Object.assign(entry, { onTap: fw(u16(4)), onHold: fw(u16(6)), onDoubleTap: fw(u16(8)), onTapHold: fw(u16(10)), term: u16(12) });
    else if (list === 'combos') Object.assign(entry, { keys: [u16(4), u16(6), u16(8), u16(10)], output: fw(u16(12)) });
    else Object.assign(entry, { trigger: u16(4), replacement: fw(u16(6)), layers: u16(8), triggerMods: p[10], negativeMods: p[11], suppressedMods: p[12], options: p[13] });
    this.log.push(Array.from(p.subarray(0, 14)));
  }

  // vial-qmk: 잠겨 있으면 QK_BOOT를 받지 않는다
  _firewall(code) { return code === 0x7c00 && this.locked ? 0 : code; }

  _handle(p, r) {
    if (this.vial && p[0] === CMD.VIAL) { this._vial(p, r); return; }
    // 잠긴 Vial 키보드는 스위치 상태와 매크로 기록 요청을 처리하지 않고 받은 그대로 돌려준다
    if (this.locked && ((p[0] === CMD.GET_KEYBOARD_VALUE && p[1] === VALUE.SWITCH_MATRIX) || p[0] === CMD.MACRO_SET_BUFFER)) return;
    const offset = (p[1] << 8) | p[2];
    const index = (layer, row, col) => (layer * this.rows + row) * this.cols + col;
    switch (p[0]) {
      case CMD.PROTOCOL_VERSION: r.set([this.protocol >> 8, this.protocol & 0xff], 1); break;
      case CMD.LAYER_COUNT: r[1] = this.layers; break;
      case CMD.GET_KEYBOARD_VALUE:
        if (p[1] === VALUE.UPTIME) r.set([0, 0, 0x30, 0x39], 2);
        else if (p[1] === VALUE.LAYOUT_OPTIONS) r.set([this.layoutOptions >>> 24, (this.layoutOptions >> 16) & 0xff, (this.layoutOptions >> 8) & 0xff, this.layoutOptions & 0xff], 2);
        else if (p[1] === VALUE.FIRMWARE_VERSION) r.set([0, 0, 1, 8], 2);
        else if (p[1] === VALUE.SWITCH_MATRIX) {
          // 프로토콜 12는 2번 바이트에 시작 행을 되돌려 주고 3번 바이트부터 행 데이터, 그 전은 2번 바이트부터
          const per = Math.ceil(this.cols / 8);
          const start = this.protocol >= 12 ? 3 : 2;
          const first = this.protocol >= 12 ? p[2] : 0;
          r.fill(0, start);
          for (const [row, col] of this.matrix || []) {
            const o = start + (row - first) * per + (per - 1 - Math.floor(col / 8));
            if (row >= first && o < 32) r[o] |= 1 << (col % 8);
          }
        } else r[0] = CMD.UNHANDLED;
        break;
      case CMD.SET_KEYBOARD_VALUE:
        if (p[1] !== VALUE.LAYOUT_OPTIONS) { r[0] = CMD.UNHANDLED; break; }
        this.layoutOptions = ((p[2] << 24) | (p[3] << 16) | (p[4] << 8) | p[5]) >>> 0;
        this.log.push(Array.from(p.subarray(0, 6)));
        break;
      case CMD.GET_KEYCODE: { const c = this.keymap[index(p[1], p[2], p[3])]; r.set([c >> 8, c & 0xff], 4); break; }
      case CMD.SET_KEYCODE:
        this.keymap[index(p[1], p[2], p[3])] = this._firewall((p[4] << 8) | p[5]);
        this.log.push(Array.from(p.subarray(0, 6)));
        break;
      case CMD.KEYMAP_GET_BUFFER: {
        const bytes = new Uint8Array(this.keymap.length * 2);
        this.keymap.forEach((c, i) => bytes.set([c >> 8, c & 0xff], 2 * i));
        r.set(bytes.subarray(offset, offset + p[3]), 4);
        break;
      }
      case CMD.GET_ENCODER: if (this.vial) { r[0] = CMD.UNHANDLED; break; } { const c = this.encoders.get(`${p[1]},${p[2]},${p[3]}`) ?? 0; r.set([c >> 8, c & 0xff], 4); break; }
      case CMD.SET_ENCODER:
        this.encoders.set(`${p[1]},${p[2]},${p[3]}`, (p[4] << 8) | p[5]);
        this.log.push(Array.from(p.subarray(0, 6)));
        break;
      case CMD.MACRO_COUNT: r[1] = this.macroCount; break;
      case CMD.MACRO_BUFFER_SIZE: r.set([this.macroBuffer.length >> 8, this.macroBuffer.length & 0xff], 1); break;
      case CMD.MACRO_GET_BUFFER: r.set(this.macroBuffer.subarray(offset, offset + p[3]), 4); break;
      case CMD.MACRO_SET_BUFFER:
        this.macroBuffer.set(p.subarray(4, 4 + p[3]), offset);
        this.log.push([p[0], p[1], p[2], p[3]]);
        break;
      case CMD.CUSTOM_GET: {
        const value = this.custom.get(`${p[1]},${p[2]}`) ?? [0, 0];
        r.set(value, 3);
        break;
      }
      case CMD.CUSTOM_SET:
        this.custom.set(`${p[1]},${p[2]}`, Array.from(p.subarray(3, 5)));
        this.log.push(Array.from(p.subarray(0, 5)));
        break;
      case CMD.CUSTOM_SAVE: this.saved.push(p[1]); this.log.push([p[0], p[1]]); break;
      default: r[0] = CMD.UNHANDLED;
    }
  }
}

export { MockViaDevice };
