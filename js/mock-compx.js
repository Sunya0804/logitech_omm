// VGN 계열(compx.js) 프로토콜을 흉내 내는 개발·테스트용 가상 HID 기기. WebHID의 HIDDevice와 같은 모양을 갖는다.
// 홈의 데모를 고를 때만 불러온다. 콘솔에서는 import('./js/mock-compx.js')로 불러와 OMM.connectCompx([new MockCompxDevice()])로 연결할 수 있다.
import * as C from './compx.js';
import * as X from './compx-macro.js';

const FLASH_LENGTH = 0x1500; // 매크로 칸 12개(0x0300~0x14ff)까지


function defaultImage() {
  const img = new Uint8Array(FLASH_LENGTH).fill(0xff);
  const F = C.FLASH;
  C.setScalar(img, F.reportRate, C.encodeRate(1000));
  C.setScalar(img, F.stageCount, 4);
  C.setScalar(img, F.currentStage, 1);
  C.setScalar(img, F.lod, 1);
  [800, 1600, 3200, 6400].forEach((dpi, i) => C.setDpi(img, i, dpi));
  [[1, 0x0100], [1, 0x0200], [1, 0x0400], [1, 0x0800], [1, 0x1000], [2, 0x0100]].forEach(([cls, param], i) => C.setKey(img, i, cls, param));
  C.setScalar(img, F.debounce, 4);
  C.setScalar(img, F.motionSync, 1);
  C.setScalar(img, F.sleep, 30);
  C.setScalar(img, F.angleSnap, 0);
  C.setScalar(img, F.ripple, 0);
  C.setScalar(img, F.performanceTime, 30);
  [[255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [255, 128, 0]].forEach((c, i) => C.setDpiColor(img, i, c));
  C.setScalar(img, F.dpiLightMode, 1);
  C.setScalar(img, F.dpiLightBrightness, 128);
  C.setScalar(img, F.dpiLightSpeed, 3);
  C.setScalar(img, F.dpiLightState, 1);
  return img;
}

// identity: { vendorId, productName, cid, mid, type } 를 바꿔 다른 기종을 흉내 낼 수 있다.
// options.macro: 프로필 1의 「앞으로」 버튼에 매크로 칸 M1(Ctrl+C)을 걸어 둔다 (ATK 데모).
class MockCompxDevice {
  constructor(identity = {}, options = {}) {
    this.identity = { vendorId: C.VENDOR_VGN, productName: 'VGN Demo Mouse', cid: 0x12, mid: 0x34, type: 1, ...identity };
    this.vendorId = this.identity.vendorId;
    this.productId = 0xfb49;
    this.productName = this.identity.productName;
    this.collections = [{ usagePage: 0xff02, usage: 2, inputReports: [{ reportId: 8 }], outputReports: [{ reportId: 8 }], featureReports: [] }];
    this.opened = false;
    // 프로필마다 설정 이미지가 따로 있다. 구분되도록 프로필별 첫 단계 DPI를 다르게 둔다.
    this.banks = [0, 1, 2, 3].map((i) => { const img = defaultImage(); C.setDpi(img, 0, 800 + 100 * i); return img; });
    if (options.macro) {
      this.banks[0].set(X.encodeSlot([
        { kind: 'key', down: true, mods: 0x01, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x06 }, { kind: 'delay', ms: 30 },
        { kind: 'key', down: false, mods: 0, usage: 0x06 }, { kind: 'key', down: false, mods: 0x01, usage: 0 },
      ]), X.slotAddress(0));
      C.setKey(this.banks[0], 4, X.KEY_CLASS, X.keyParam(0, X.REPEAT.ONCE));
    }
    this.profile = 0;
    this.online = false;
    this.awake = true; // false면 절전 중인 마우스처럼 상태 조회에 offline으로 답하고 배터리 요청을 거부한다
    this.battery = 75;
    this.listeners = new Set();
    this.writes = []; // 기록된 [주소, 바이트들]
  }

  get flash() { return this.banks[this.profile]; }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(type, fn) { if (type === 'inputreport') this.listeners.add(fn); }
  removeEventListener(type, fn) { this.listeners.delete(fn); }

  async sendReport(reportId, data) {
    const p = new Uint8Array(data);
    const r = new Uint8Array(16);
    r[0] = p[0];
    const sum = (8 + p.subarray(0, 15).reduce((a, b) => a + b, 0)) & 0xff;
    if (reportId !== 8 || p.length !== 16 || p[15] !== ((0x55 - sum) & 0xff)) r[1] = 1; // 검사 값이 틀린 패킷은 거부
    else this._handle(p, r);
    const event = { reportId: 8, data: new DataView(r.buffer) };
    queueMicrotask(() => this.listeners.forEach((fn) => fn(event)));
  }

  _handle(p, r) {
    const address = (p[2] << 8) | p[3];
    switch (p[0]) {
      case 0x01: r.set([this.identity.cid, this.identity.mid, this.identity.type, 0], 9); break; // cid, mid, 연결 종류, 수신기 종류
      case 0x03: this.online = p[5] === 1; r[5] = this.awake ? 1 : 0; break;
      case 0x04: if (this.awake) r.set([this.battery, 0], 5); else r[1] = 1; break;
      case 0x08: r.set(this.flash.subarray(address, address + p[4]), 5); break;
      case 0x07:
        if (!this.online) { r[1] = 1; break; }
        this.flash.set(p.subarray(5, 5 + p[4]), address);
        this.writes.push([address, Array.from(p.subarray(5, 5 + p[4]))]);
        break;
      case 0x0e: r[5] = this.profile; break;
      case 0x0f:
        if (p[4] !== 1 || p[5] > 3) { r[1] = 1; break; }
        this.profile = p[5];
        break;
      case 0x12: r.set([3, 0x03], 5); break;
      case 0x1d: r.set([2, 0x03], 5); break;
      default: r[1] = 1;
    }
  }
}

export { MockCompxDevice };
