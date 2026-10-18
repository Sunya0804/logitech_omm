// VIA(QMK) 키보드의 raw HID 프로토콜. 사용 페이지 0xFF60·용도 0x61 인터페이스로 32바이트 리포트를 주고받는다.
// 명령 번호와 응답 배치는 QMK의 via.h·via.c(공개 문서와 소스)에 정리된 내용을 따랐다. 코드는 가져오지 않았다.
// 실기기(Qwertykeys QK80 MK2, 프로토콜 12)에서 읽기 명령의 응답 배치를 확인했다. 쓰기 명령은 실기기로 확인하지 않았다.
// 이 파일은 공장 초기화·부트로더 진입·키맵 초기화 명령을 내보내지 않는다.
import { t } from './i18n.js';

const USAGE_PAGE = 0xff60;
const USAGE = 0x61;
const REPORT_LENGTH = 32;
const CHUNK = 28; // 버퍼 읽기·쓰기 한 번에 실리는 바이트 수 (32 - 머리 4)
const TIMEOUT_MS = 1000;

const CMD = {
  PROTOCOL_VERSION: 0x01, GET_KEYBOARD_VALUE: 0x02, SET_KEYBOARD_VALUE: 0x03,
  GET_KEYCODE: 0x04, SET_KEYCODE: 0x05,
  CUSTOM_SET: 0x07, CUSTOM_GET: 0x08, CUSTOM_SAVE: 0x09,
  MACRO_COUNT: 0x0c, MACRO_BUFFER_SIZE: 0x0d, MACRO_GET_BUFFER: 0x0e, MACRO_SET_BUFFER: 0x0f,
  LAYER_COUNT: 0x11, KEYMAP_GET_BUFFER: 0x12, KEYMAP_SET_BUFFER: 0x13,
  GET_ENCODER: 0x14, SET_ENCODER: 0x15,
  UNHANDLED: 0xff,
};
// 키보드 값(GET/SET_KEYBOARD_VALUE)의 번호
const VALUE = { UPTIME: 0x01, LAYOUT_OPTIONS: 0x02, SWITCH_MATRIX: 0x03, FIRMWARE_VERSION: 0x04 };

const filters = [{ usagePage: USAGE_PAGE, usage: USAGE }];
const hasViaInterface = (d) => (d.collections || []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
const be16 = (r, o) => (r[o] << 8) | r[o + 1];
const be32 = (r, o) => ((r[o] << 24) | (r[o + 1] << 16) | (r[o + 2] << 8) | r[o + 3]) >>> 0;

class ViaDevice {
  // devices: requestDevice가 돌려준 HIDDevice 목록. VIA 인터페이스가 있는 것을 쓴다.
  constructor(devices) {
    this.dev = devices.find(hasViaInterface) || null;
    this.pending = null;
    this.queue = Promise.resolve();
    this._listener = (e) => this._onInput(e);
  }

  get vendorId() { return this.dev.vendorId; }
  get productId() { return this.dev.productId; }
  get name() { return this.dev.productName || 'VIA'; }
  // VIA 정의 파일의 vendorProductId와 같은 값
  get vendorProductId() { return this.dev.vendorId * 65536 + this.dev.productId; }

  async open() {
    if (!this.dev) throw new Error(t('VIA 인터페이스(사용 페이지 0xFF60)가 없는 기기입니다.'));
    if (!this.dev.opened) await this.dev.open();
    this.dev.addEventListener('inputreport', this._listener);
  }

  async close() {
    if (!this.dev) return;
    this.dev.removeEventListener('inputreport', this._listener);
    if (this.dev.opened) await this.dev.close().catch(() => {});
  }

  _onInput(e) {
    const p = this.pending;
    if (!p) return;
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (bytes[0] === p.command || bytes[0] === CMD.UNHANDLED) p.resolve(bytes.slice(0, REPORT_LENGTH));
  }

  // 리포트 하나를 보내고 같은 명령 번호의 응답을 기다린다. 요청은 한 번에 하나씩 처리한다.
  // 기기가 모르는 명령이면 0xFF로 답하고, 그때는 오류로 알린다.
  request(bytes) {
    const run = () => new Promise((resolve, reject) => {
      const packet = new Uint8Array(REPORT_LENGTH);
      packet.set(bytes.slice(0, REPORT_LENGTH));
      const command = packet[0];
      const done = (settle) => (v) => {
        clearTimeout(timer);
        this.pending = null;
        settle(v);
      };
      const timer = setTimeout(done(reject), TIMEOUT_MS, new Error(t('기기 응답 시간 초과')));
      this.pending = {
        command,
        resolve: done((r) => (r[0] === CMD.UNHANDLED && command !== CMD.UNHANDLED
          ? reject(new Error(t('키보드가 이 명령(0x{command})을 지원하지 않습니다.', { command: command.toString(16).padStart(2, '0') })))
          : resolve(r))),
        reject: done(reject),
      };
      Promise.resolve(this.dev.sendReport(0, packet)).catch((e) => this.pending && this.pending.reject(e));
    });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  // ---------- 기본 정보 ----------

  async protocolVersion() { return be16(await this.request([CMD.PROTOCOL_VERSION]), 1); }
  async layerCount() { return (await this.request([CMD.LAYER_COUNT]))[1]; }
  async uptime() { return be32(await this.request([CMD.GET_KEYBOARD_VALUE, VALUE.UPTIME]), 2); }
  async firmwareVersion() { return be32(await this.request([CMD.GET_KEYBOARD_VALUE, VALUE.FIRMWARE_VERSION]), 2); }
  async layoutOptions() { return be32(await this.request([CMD.GET_KEYBOARD_VALUE, VALUE.LAYOUT_OPTIONS]), 2); }

  async setLayoutOptions(value) {
    await this.request([CMD.SET_KEYBOARD_VALUE, VALUE.LAYOUT_OPTIONS, value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
  }

  // 눌린 스위치: rows × cols 의 true/false. 응답의 2번 바이트부터 행마다 ceil(cols / 8) 바이트이고,
  // 큰 쪽 바이트가 앞, 비트 0이 0번 열이다. 한 응답에 다 들어가지 않으면 시작 행(요청의 2번 바이트)을 옮겨 가며 읽는다.
  async switchMatrix(rows, cols) {
    const per = Math.ceil(cols / 8);
    const perReply = Math.floor((REPORT_LENGTH - 4) / per);
    const out = [];
    for (let first = 0; first < rows; first += perReply) {
      const r = await this.request([CMD.GET_KEYBOARD_VALUE, VALUE.SWITCH_MATRIX, first]);
      for (let row = first; row < Math.min(rows, first + perReply); row++) {
        const o = 2 + (row - first) * per;
        let bits = 0n;
        for (let i = 0; i < per; i++) bits = (bits << 8n) | BigInt(r[o + i]);
        out.push(Array.from({ length: cols }, (_, col) => ((bits >> BigInt(col)) & 1n) === 1n));
      }
    }
    return out;
  }

  // ---------- 키맵 ----------

  async readBuffer(command, total) {
    const out = new Uint8Array(total);
    for (let off = 0; off < total; off += CHUNK) {
      const n = Math.min(CHUNK, total - off);
      const r = await this.request([command, off >> 8, off & 0xff, n]);
      out.set(r.subarray(4, 4 + n), off);
    }
    return out;
  }

  async writeBuffer(command, offset, bytes) {
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const chunk = bytes.subarray(off, off + CHUNK);
      const a = offset + off;
      await this.request([command, a >> 8, a & 0xff, chunk.length, ...chunk]);
    }
  }

  // 모든 레이어의 키 코드: Uint16Array, 순서는 [레이어][행][열]
  async readKeymap(layers, rows, cols) {
    const bytes = await this.readBuffer(CMD.KEYMAP_GET_BUFFER, layers * rows * cols * 2);
    return Uint16Array.from({ length: bytes.length / 2 }, (_, i) => be16(bytes, 2 * i));
  }

  async getKeycode(layer, row, col) { return be16(await this.request([CMD.GET_KEYCODE, layer, row, col]), 4); }
  async setKeycode(layer, row, col, code) { await this.request([CMD.SET_KEYCODE, layer, row, col, code >> 8, code & 0xff]); }

  // 로터리 인코더: 시계 방향이면 cw = true
  async getEncoder(layer, index, cw) { return be16(await this.request([CMD.GET_ENCODER, layer, index, cw ? 1 : 0]), 4); }
  async setEncoder(layer, index, cw, code) { await this.request([CMD.SET_ENCODER, layer, index, cw ? 1 : 0, code >> 8, code & 0xff]); }

  // ---------- 매크로 ----------

  async macroCount() { return (await this.request([CMD.MACRO_COUNT]))[1]; }
  async macroBufferSize() { return be16(await this.request([CMD.MACRO_BUFFER_SIZE]), 1); }
  readMacroBuffer(size) { return this.readBuffer(CMD.MACRO_GET_BUFFER, size); }
  writeMacroBuffer(bytes) { return this.writeBuffer(CMD.MACRO_SET_BUFFER, 0, bytes); }

  // ---------- 정의 파일의 메뉴 값(조명·설정) ----------

  // head: [채널, 값 번호, 덧붙는 바이트…] (정의 파일 content의 두 번째부터). 값은 head 바로 뒤에서 size 바이트다.
  async customGet(head, size) {
    const r = await this.request([CMD.CUSTOM_GET, ...head]);
    return Array.from(r.subarray(1 + head.length, 1 + head.length + size));
  }
  async customSet(head, bytes) { await this.request([CMD.CUSTOM_SET, ...head, ...bytes]); }
  async customSave(channel) { await this.request([CMD.CUSTOM_SAVE, channel]); }
}

export { filters, hasViaInterface, USAGE_PAGE, USAGE, CMD, VALUE, CHUNK, REPORT_LENGTH, ViaDevice };
