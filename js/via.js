// VIA(QMK) 키보드의 raw HID 프로토콜. 사용 페이지 0xFF60·용도 0x61 인터페이스로 32바이트 리포트를 주고받는다.
// 명령 번호와 응답 배치는 QMK의 via.h·via.c(공개 문서와 소스)에 정리된 내용을 따랐다. 코드는 가져오지 않았다.
// 실기기(Qwertykeys QK80 MK2, 프로토콜 12)에서 읽기 명령의 응답 배치를 확인했다. 쓰기 명령은 실기기로 확인하지 않았다.
// 이 파일은 공장 초기화·부트로더 진입·키맵 초기화 명령을 내보내지 않는다.
// Vial 명령(0xFE로 시작)은 vial-qmk의 vial.c·vial-gui의 프로토콜 정리를 따랐다(코드는 가져오지 않았다).
// Vial의 잠금(lock)·QMK 설정 초기화 명령도 내보내지 않는다.
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
  VIAL: 0xfe, UNHANDLED: 0xff,
};
// Vial 명령 (0xFE 다음 바이트). 응답은 명령 번호를 되돌려 주지 않고 0번 바이트부터 데이터다.
const VIAL = {
  KEYBOARD_ID: 0x00, SIZE: 0x01, DEFINITION: 0x02, GET_ENCODER: 0x03, SET_ENCODER: 0x04,
  UNLOCK_STATUS: 0x05, UNLOCK_START: 0x06, UNLOCK_POLL: 0x07,
  SETTINGS_QUERY: 0x09, SETTINGS_GET: 0x0a, SETTINGS_SET: 0x0b, DYNAMIC: 0x0d,
};
// 동적 항목(DYNAMIC) 명령
const DYNAMIC = { COUNTS: 0x00, TAP_DANCE_GET: 0x01, TAP_DANCE_SET: 0x02, COMBO_GET: 0x03, COMBO_SET: 0x04, KEY_OVERRIDE_GET: 0x05, KEY_OVERRIDE_SET: 0x06 };
// 키보드 값(GET/SET_KEYBOARD_VALUE)의 번호
const VALUE = { UPTIME: 0x01, LAYOUT_OPTIONS: 0x02, SWITCH_MATRIX: 0x03, FIRMWARE_VERSION: 0x04 };

const filters = [{ usagePage: USAGE_PAGE, usage: USAGE }];
const hasViaInterface = (d) => (d.collections || []).some((c) => c.usagePage === USAGE_PAGE && c.usage === USAGE);
const be16 = (r, o) => (r[o] << 8) | r[o + 1];
const be32 = (r, o) => ((r[o] << 24) | (r[o + 1] << 16) | (r[o + 2] << 8) | r[o + 3]) >>> 0;
const le16 = (r, o) => r[o] | (r[o + 1] << 8);
const le32 = (r, o) => (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;
const le16Bytes = (v) => [v & 0xff, (v >> 8) & 0xff];

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
    if (p.raw || bytes[0] === p.command || bytes[0] === CMD.UNHANDLED) p.resolve(bytes.slice(0, REPORT_LENGTH));
  }

  // 리포트 하나를 보내고 같은 명령 번호의 응답을 기다린다. 요청은 한 번에 하나씩 처리한다.
  // 기기가 모르는 명령이면 0xFF로 답하고, 그때는 오류로 알린다.
  // raw: Vial 명령처럼 응답이 명령 번호로 시작하지 않으면 다음 응답을 그대로 받는다 (0xFF도 데이터로 본다).
  request(bytes, { raw = false } = {}) {
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
        command, raw,
        resolve: done((r) => (!raw && r[0] === CMD.UNHANDLED && command !== CMD.UNHANDLED
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

  // 눌린 스위치: rows × cols 의 true/false. 행마다 ceil(cols / 8) 바이트이고, 큰 쪽 바이트가 앞, 비트 0이 0번 열이다.
  // 프로토콜 12는 요청의 2번 바이트로 시작 행을 받고 응답 2번 바이트에 그 값을 되돌려 주므로, 행 데이터는 3번 바이트부터다.
  // (실기기 QK80 MK2에서 Esc·A·→를 눌러 확인했다.) 그 전 프로토콜은 시작 행 없이 2번 바이트부터 한 번에 보낸다.
  async switchMatrix(rows, cols, protocol = 12) {
    const per = Math.ceil(cols / 8);
    const withOffset = protocol >= 12;
    const start = withOffset ? 3 : 2;
    const perReply = withOffset ? Math.floor((REPORT_LENGTH - 4) / per) : Math.floor((REPORT_LENGTH - start) / per);
    if (!withOffset && rows > perReply) throw new Error(t('행렬이 커서 이 키보드에서는 키 시험을 할 수 없습니다.'));
    const out = [];
    for (let first = 0; first < rows; first += perReply) {
      const r = await this.request([CMD.GET_KEYBOARD_VALUE, VALUE.SWITCH_MATRIX, ...(withOffset ? [first] : [])]);
      for (let row = first; row < Math.min(rows, first + perReply); row++) {
        const o = start + (row - first) * per;
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

  // ---------- Vial ----------

  vial(bytes) { return this.request([CMD.VIAL, ...bytes], { raw: true }); }

  // Vial 키보드인지 묻는다. Vial이면 {protocol, uid(16진 문자열), vialrgb}, 아니면 null.
  // Vial이 아닌 펌웨어는 0xFF(모르는 명령)나 보낸 그대로를 돌려준다.
  async vialId() {
    const r = await this.vial([VIAL.KEYBOARD_ID]).catch(() => null);
    if (!r) return null;
    const protocol = le32(r, 0);
    if (r[0] >= 0xfe || protocol > 0xff) return null;
    return { protocol, uid: Array.from(r.subarray(4, 12), (b) => b.toString(16).padStart(2, '0')).join(''), vialrgb: r[12] === 1 };
  }

  // 펌웨어에 들어 있는 압축된 정의 파일 (32바이트 블록 단위로 읽는다)
  async vialDefinition() {
    const size = le32(await this.vial([VIAL.SIZE]), 0);
    if (!size || size > 1 << 20) throw new Error(t('키보드가 알려 준 정의 파일 크기({n})가 올바르지 않습니다.', { n: size }));
    const out = new Uint8Array(size);
    for (let block = 0; block * REPORT_LENGTH < size; block++) {
      const r = await this.vial([VIAL.DEFINITION, block & 0xff, (block >> 8) & 0xff, 0, 0]);
      out.set(r.subarray(0, Math.min(REPORT_LENGTH, size - block * REPORT_LENGTH)), block * REPORT_LENGTH);
    }
    return out;
  }

  // 잠금 상태: {unlocked, inProgress, keys: [[행, 열]…]} (잠금 해제할 때 누르고 있어야 하는 키)
  async vialUnlockStatus() {
    const r = await this.vial([VIAL.UNLOCK_STATUS]);
    const keys = [];
    for (let i = 0; i < 15; i++) if (r[2 + 2 * i] !== 0xff && r[3 + 2 * i] !== 0xff) keys.push([r[2 + 2 * i], r[3 + 2 * i]]);
    return { unlocked: r[0] === 1, inProgress: r[1] === 1, keys };
  }
  async vialUnlockStart() { await this.vial([VIAL.UNLOCK_START]); }
  // 잠금 해제 진행: 키를 누르고 있는 동안 counter가 줄어 0이 되면 풀린다
  async vialUnlockPoll() {
    const r = await this.vial([VIAL.UNLOCK_POLL]);
    return { unlocked: r[0] === 1, inProgress: r[1] === 1, counter: r[2] };
  }

  // Vial 키보드의 인코더 (VIA 프로토콜 9에는 인코더 명령이 없다). 방향 1이 시계 방향.
  async vialGetEncoder(layer, index, cw) { const r = await this.vial([VIAL.GET_ENCODER, layer, index]); return be16(r, cw ? 2 : 0); }
  async vialSetEncoder(layer, index, cw, code) { await this.vial([VIAL.SET_ENCODER, layer, index, cw ? 1 : 0, code >> 8, code & 0xff]); }

  // QMK 설정: 키보드가 지원하는 설정 번호(qsid) 목록
  async qmkSettingsList() {
    const out = [];
    let after = 0;
    for (let guard = 0; guard < 64; guard++) {
      const r = await this.vial([VIAL.SETTINGS_QUERY, ...le16Bytes(after)]);
      let more = true;
      for (let o = 0; o + 1 < REPORT_LENGTH; o += 2) {
        const id = le16(r, o);
        if (id === 0xffff) { more = false; break; }
        if (id > after) { out.push(id); after = id; }
      }
      if (!more) break;
    }
    return out;
  }
  // 설정 값 width바이트 (작은 쪽이 앞). 키보드가 거절하면 null.
  async qmkSettingGet(qsid, width) {
    const r = await this.vial([VIAL.SETTINGS_GET, ...le16Bytes(qsid)]);
    if (r[0] !== 0) return null;
    let v = 0;
    for (let i = width - 1; i >= 0; i--) v = v * 256 + r[1 + i];
    return v;
  }
  async qmkSettingSet(qsid, width, value) {
    const bytes = Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** i) & 0xff);
    const r = await this.vial([VIAL.SETTINGS_SET, ...le16Bytes(qsid), ...bytes]);
    if (r[0] !== 0) throw new Error(t('키보드가 QMK 설정({id}) 값을 받지 않았습니다.', { id: qsid }));
  }

  // 탭 댄스·콤보·키 오버라이드 칸 수
  async vialDynamicCounts() {
    const r = await this.vial([VIAL.DYNAMIC, DYNAMIC.COUNTS]);
    return { tapDance: r[0], combo: r[1], keyOverride: r[2], altRepeat: r[3] };
  }
  async dynamicGet(op, index) {
    const r = await this.vial([VIAL.DYNAMIC, op, index]);
    if (r[0] !== 0) throw new Error(t('키보드에서 Vial 항목({index})을 읽지 못했습니다.', { index }));
    return r.subarray(1);
  }
  async dynamicSet(op, index, bytes) {
    const r = await this.vial([VIAL.DYNAMIC, op, index, ...bytes]);
    if (r[0] !== 0) throw new Error(t('키보드가 Vial 항목({index})을 받지 않았습니다.', { index }));
  }
  // 탭 댄스: 탭, 길게, 두 번 탭, 탭 후 길게 (키 코드)와 탭 판정 시간(ms)
  async tapDanceGet(i) {
    const d = await this.dynamicGet(DYNAMIC.TAP_DANCE_GET, i);
    return { onTap: le16(d, 0), onHold: le16(d, 2), onDoubleTap: le16(d, 4), onTapHold: le16(d, 6), term: le16(d, 8) };
  }
  tapDanceSet(i, e) {
    return this.dynamicSet(DYNAMIC.TAP_DANCE_SET, i, [e.onTap, e.onHold, e.onDoubleTap, e.onTapHold, e.term].flatMap(le16Bytes));
  }
  // 콤보: 함께 누르는 키 4개(빈 칸은 0)와 결과 키
  async comboGet(i) {
    const d = await this.dynamicGet(DYNAMIC.COMBO_GET, i);
    return { keys: [0, 1, 2, 3].map((k) => le16(d, 2 * k)), output: le16(d, 8) };
  }
  comboSet(i, e) { return this.dynamicSet(DYNAMIC.COMBO_SET, i, [...e.keys, e.output].flatMap(le16Bytes)); }
  // 키 오버라이드: 누른 키+수정자를 다른 키로 바꾼다. layers는 레이어 비트, options의 비트 7이 켜짐.
  async keyOverrideGet(i) {
    const d = await this.dynamicGet(DYNAMIC.KEY_OVERRIDE_GET, i);
    return { trigger: le16(d, 0), replacement: le16(d, 2), layers: le16(d, 4), triggerMods: d[6], negativeMods: d[7], suppressedMods: d[8], options: d[9] };
  }
  keyOverrideSet(i, e) {
    return this.dynamicSet(DYNAMIC.KEY_OVERRIDE_SET, i, [...le16Bytes(e.trigger), ...le16Bytes(e.replacement), ...le16Bytes(e.layers), e.triggerMods, e.negativeMods, e.suppressedMods, e.options]);
  }
}

export { filters, hasViaInterface, USAGE_PAGE, USAGE, CMD, VALUE, VIAL, DYNAMIC, CHUNK, REPORT_LENGTH, ViaDevice };
