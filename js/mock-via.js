// 시험·데모용 가상 VIA 키보드. WebHID HIDDevice와 같은 모양으로 via.js의 명령에 답한다. 모두 메모리 안에서만 동작한다.
// 기본값은 실기기(Qwertykeys QK80 MK2)에서 읽은 크기를 따른다: 프로토콜 12, 6×16 행렬, 레이어 4, 매크로 16칸·3079바이트.
import { CMD, VALUE } from './via.js';

class MockViaDevice {
  constructor(o = {}) {
    this.vendorId = o.vendorId ?? 0x514b;
    this.productId = o.productId ?? 0x4d02;
    this.productName = o.productName ?? 'QK80 MK2';
    this.collections = [{ usagePage: 0xff60, usage: 0x61, inputReports: [{ reportId: 0 }], outputReports: [{ reportId: 0 }], featureReports: [] }];
    this.protocol = o.protocol ?? 12;
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

  _handle(p, r) {
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
          const per = Math.ceil(this.cols / 8);
          r.fill(0, 2);
          for (const [row, col] of this.matrix || []) {
            const o = 2 + (row - p[2]) * per + (per - 1 - Math.floor(col / 8));
            if (row >= p[2] && o < 32) r[o] |= 1 << (col % 8);
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
        this.keymap[index(p[1], p[2], p[3])] = (p[4] << 8) | p[5];
        this.log.push(Array.from(p.subarray(0, 6)));
        break;
      case CMD.KEYMAP_GET_BUFFER: {
        const bytes = new Uint8Array(this.keymap.length * 2);
        this.keymap.forEach((c, i) => bytes.set([c >> 8, c & 0xff], 2 * i));
        r.set(bytes.subarray(offset, offset + p[3]), 4);
        break;
      }
      case CMD.GET_ENCODER: { const c = this.encoders.get(`${p[1]},${p[2]},${p[3]}`) ?? 0; r.set([c >> 8, c & 0xff], 4); break; }
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
