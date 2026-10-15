// HID++ 2.0 전송 계층(WebHID)과 온보드 프로필 기능(0x8100) 래퍼.
import { t } from './i18n.js';
const VENDOR_LOGITECH = 0x046d;
const HIDPP_USAGE_PAGES = [0xff00, 0xff43]; // USB·수신기 / 블루투스 직결
const REPORT_SHORT = 0x10;
const REPORT_LONG = 0x11;
const LONG_PARAMS = 16;
const SW_ID = 0x0b;
const DEVICE_INDEXES = [0xff, 1, 2, 3, 4, 5, 6]; // 0xFF: 유선/직결, 1~6: 수신기에 페어링된 기기

const FEATURE = {
  ROOT: 0x0000, FEATURE_SET: 0x0001, NAME: 0x0005, ANALOG_BUTTONS: 0x1b0c, BATTERY_LEVEL: 0x1000, UNIFIED_BATTERY: 0x1004,
  ADJUSTABLE_DPI: 0x2201, EXTENDED_DPI: 0x2202, EXTENDED_REPORT_RATE: 0x8061, ONBOARD_PROFILES: 0x8100,
};

const ERROR_NAMES = {
  1: 'Unknown', 2: 'InvalidArgument', 3: 'OutOfRange', 4: 'HardwareError', 5: 'LogitechInternal',
  6: 'InvalidFeatureIndex', 7: 'InvalidFunctionId', 8: 'Busy', 9: 'Unsupported',
};

class HidppError extends Error {
  constructor(code, legacy) {
    super(legacy ? t('HID++ 1.0 오류 0x{code}', { code: code.toString(16) }) : t('HID++ 오류 {name}', { name: ERROR_NAMES[code] || code }));
    this.code = code;
    this.legacy = legacy;
  }
}

class WebHidTransport {
  constructor(devices) {
    this.devices = devices;
    this.out = devices.find((d) => WebHidTransport.hasOutputReport(d, REPORT_LONG));
    this.onInput = null;
    this._listener = (e) => {
      if (this.onInput) this.onInput(e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    };
  }

  static hasOutputReport(device, id) {
    return device.collections.some((c) => c.outputReports.some((r) => r.reportId === id));
  }

  // 기기 선택 창에 쓰는 필터. HID++ 인터페이스(벤더 전용 usage page)가 있는 기기만 보여 준다.
  // 벤더 ID만으로 거르면 G HUB가 설치한 가상 마우스/키보드 같은 장치까지 목록에 나온다.
  static get filters() {
    return HIDPP_USAGE_PAGES.map((usagePage) => ({ vendorId: VENDOR_LOGITECH, usagePage }));
  }

  get name() {
    return this.out.productName;
  }

  async open() {
    for (const d of this.devices) {
      if (!d.opened) await d.open();
      d.addEventListener('inputreport', this._listener);
    }
  }

  write(data) {
    return this.out.sendReport(REPORT_LONG, data);
  }

  async close() {
    for (const d of this.devices) {
      d.removeEventListener('inputreport', this._listener);
      if (d.opened) await d.close().catch(() => {});
    }
  }
}

class Hidpp {
  constructor(transport) {
    this.transport = transport;
    this.devIdx = 0xff;
    this.features = new Map();
    this.pending = null;
    this.queue = Promise.resolve();
    this.onEvent = null;
    transport.onInput = (id, data) => this._onInput(id, data);
  }

  _onInput(reportId, d) {
    if (reportId !== REPORT_SHORT && reportId !== REPORT_LONG) return;
    const p = this.pending;
    if (p && d[0] === p.devIdx) {
      const isError = (d[1] === 0xff || d[1] === 0x8f) && d[2] === p.featIdx && d[3] === p.funcSw;
      if (isError) return p.reject(new HidppError(d[4], d[1] === 0x8f));
      if (d[1] === p.featIdx && d[2] === p.funcSw) {
        const params = new Uint8Array(LONG_PARAMS);
        params.set(d.subarray(3, 3 + LONG_PARAMS));
        return p.resolve(params);
      }
    }
    // swId가 0이면 기기가 스스로 보낸 알림
    if ((d[2] & 0x0f) === 0 && d[0] === this.devIdx && this.onEvent) {
      this.onEvent(d[1], d[2] >> 4, d.subarray(3));
    }
  }

  // 요청은 한 번에 하나씩 직렬로 처리한다.
  request(featIdx, fn, params = [], opts = {}) {
    const run = () => new Promise((resolve, reject) => {
      const devIdx = opts.devIdx ?? this.devIdx;
      const funcSw = ((fn & 0x0f) << 4) | SW_ID;
      const buf = new Uint8Array(3 + LONG_PARAMS);
      buf.set([devIdx, featIdx, funcSw]);
      buf.set(params, 3);
      const done = (settle) => (v) => {
        clearTimeout(timer);
        this.pending = null;
        settle(v);
      };
      const timer = setTimeout(done(reject), opts.timeout ?? 2000, new Error(t('기기 응답 시간 초과')));
      this.pending = { devIdx, featIdx, funcSw, resolve: done(resolve), reject: done(reject) };
      Promise.resolve(this.transport.write(buf)).catch((e) => this.pending && this.pending.reject(e));
    });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  // HID++ 2.0으로 응답하는 기기 인덱스를 찾는다. 온보드 프로필을 지원하는 기기를 우선한다.
  async probe() {
    let fallback = null;
    for (const idx of DEVICE_INDEXES) {
      let major;
      try {
        // 없는 인덱스는 수신기가 바로 오류로 답하지만, 절전 중인 무선 기기는 깨어나는 데 시간이 걸린다.
        major = (await this.request(0, 1, [0, 0, 0x5a], { devIdx: idx, timeout: 1500 }))[0];
      } catch (e) {
        continue;
      }
      if (major < 2) continue;
      this.devIdx = idx;
      this.features.clear();
      if (await this.getFeature(FEATURE.ONBOARD_PROFILES)) return true;
      fallback ??= idx;
    }
    if (fallback === null) return false;
    this.devIdx = fallback;
    this.features.clear();
    return true;
  }

  // 기능 ID → 기능 인덱스 (미지원이면 0)
  async getFeature(id) {
    if (!this.features.has(id)) {
      const r = await this.request(0, 0, [id >> 8, id & 0xff]);
      this.features.set(id, r[0]);
    }
    return this.features.get(id);
  }

  // 기기가 지원하는 모든 기능: [{index, id}]
  async getFeatureList() {
    const idx = await this.getFeature(FEATURE.FEATURE_SET);
    if (!idx) return [];
    const count = (await this.request(idx, 0))[0];
    const list = [];
    for (let i = 0; i <= count; i++) {
      const r = await this.request(idx, 1, [i]);
      list.push({ index: i, id: (r[0] << 8) | r[1] });
    }
    return list;
  }

  async getName() {
    const idx = await this.getFeature(FEATURE.NAME);
    if (!idx) return null;
    const count = (await this.request(idx, 0))[0];
    const bytes = [];
    while (bytes.length < count) {
      const r = await this.request(idx, 1, [bytes.length]);
      bytes.push(...r.subarray(0, Math.min(LONG_PARAMS, count - bytes.length)));
    }
    return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, '');
  }

  // {percent, charging} 또는 null
  async getBattery() {
    let idx = await this.getFeature(FEATURE.UNIFIED_BATTERY);
    if (idx) {
      const r = await this.request(idx, 1);
      return { percent: r[0], charging: r[2] >= 1 && r[2] <= 3 };
    }
    idx = await this.getFeature(FEATURE.BATTERY_LEVEL);
    if (idx) {
      const r = await this.request(idx, 0);
      return { percent: r[0], charging: false };
    }
    return null;
  }

  // {min, max, step, segments: [{from, to, step}]} 또는 null.
  // DPI 목록은 BE 16비트 값의 나열이고, 0xE000 | step 은 앞뒤 값 사이의 간격을 뜻하며 0으로 끝난다.
  async getDpiRange() {
    const bytes = [];
    const terminated = () => {
      for (let i = 0; i + 1 < bytes.length; i += 2) if (!bytes[i] && !bytes[i + 1]) return true;
      return false;
    };
    const ext = await this.getFeature(FEATURE.EXTENDED_DPI);
    const idx = ext || (await this.getFeature(FEATURE.ADJUSTABLE_DPI));
    if (!idx) return null;
    if (ext) {
      // 확장 DPI는 목록을 여러 페이지에 걸쳐 이어서 보낸다.
      for (let page = 0; page < 8 && !terminated(); page++) {
        bytes.push(...(await this.request(ext, 2, [0, 0, page])).subarray(3));
      }
    } else {
      bytes.push(...(await this.request(idx, 1, [0])).subarray(1));
    }
    const values = [];
    const segments = [];
    let step = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const v = (bytes[i] << 8) | bytes[i + 1];
      if (v === 0) break;
      if (v >> 13 === 0x7) {
        step = v & 0x1fff;
      } else {
        if (step) segments.push({ from: values[values.length - 1], to: v, step });
        values.push(v);
        step = 0;
      }
    }
    if (!values.length) return null;
    const minStep = segments.length ? Math.min(...segments.map((s) => s.step)) : 50;
    return { min: Math.min(...values), max: Math.max(...values), step: minStep, segments };
  }

  // 아날로그 버튼(0x1B0C)의 단계 수: {buttonMask, actuationMax, hapticMax, rtMax}. 미지원이거나 값이 이상하면 null.
  // 응답: [버튼 비트맵(2, BE), 작동점 단계 << 2, 햅틱 단계 << 2, 래피드 트리거 단계 << 2, ...] (공식 OMM 2.7 기준)
  async getAnalogCapabilities() {
    const idx = await this.getFeature(FEATURE.ANALOG_BUTTONS);
    if (!idx) return null;
    const r = await this.request(idx, 0);
    const caps = { buttonMask: (r[0] << 8) | r[1], actuationMax: r[2] >> 2, hapticMax: r[3] >> 2, rtMax: r[4] >> 2 };
    const sane = caps.buttonMask && [caps.actuationMax, caps.hapticMax, caps.rtMax].every((v) => v >= 1);
    return sane ? caps : null;
  }

  // 아날로그 버튼 하나의 현재 값을 바꾼다 (프로필에 저장되는 것과 같은 3바이트). 프로필에 쓴 값은
  // 전원을 켤 때 불러오므로, 저장 직후 바로 적용하려면 이 명령도 보내야 한다.
  async setAnalogLive(button, bytes) {
    const idx = await this.getFeature(FEATURE.ANALOG_BUTTONS);
    if (idx) await this.request(idx, 1, [button, ...bytes]);
    return !!idx;
  }

  // 확장 보고율(0x8061)이 지원하는 보고율 인덱스 목록 (인덱스 i = 125 << i Hz). 미지원이면 null.
  async getReportRateIndexes() {
    const idx = await this.getFeature(FEATURE.EXTENDED_REPORT_RATE);
    if (!idx) return null;
    const r = await this.request(idx, 1, [0]);
    const mask = (r[0] << 8) | r[1];
    return [...Array(16).keys()].filter((i) => mask & (1 << i));
  }
}

const MODE = { ONBOARD: 1, HOST: 2 };

class OnboardProfiles {
  constructor(hidpp, featIdx) {
    this.hidpp = hidpp;
    this.idx = featIdx;
  }

  async getDescription() {
    const r = await this.hidpp.request(this.idx, 0x0);
    return {
      memoryModelId: r[0], profileFormatId: r[1], macroFormatId: r[2],
      profileCount: r[3], profileCountOob: r[4], buttonCount: r[5], sectorCount: r[6],
      sectorSize: (r[7] << 8) | r[8],
      hasGShift: (r[9] & 0x03) === 0x02,
      hasDpiShift: ((r[9] & 0x0c) >> 2) === 0x02,
    };
  }

  async getMode() {
    return (await this.hidpp.request(this.idx, 0x2))[0];
  }

  setMode(mode) {
    return this.hidpp.request(this.idx, 0x1, [mode]);
  }

  // 현재 프로필의 섹터 번호 (사용자 프로필 N → 0x000N, ROM 프로필 N → 0x010N)
  async getCurrentProfile() {
    const r = await this.hidpp.request(this.idx, 0x4);
    return (r[0] << 8) | r[1];
  }

  setCurrentProfile(sector) {
    return this.hidpp.request(this.idx, 0x3, [sector >> 8, sector & 0xff]);
  }

  async readSector(sector, size) {
    const out = new Uint8Array(size);
    for (let off = 0; off < size; off += LONG_PARAMS) {
      // 섹터 끝을 넘겨 읽으면 오류가 나므로 마지막 조각은 끝에 맞춰 읽는다.
      const from = Math.min(off, size - LONG_PARAMS);
      const r = await this.hidpp.request(this.idx, 0x5, [sector >> 8, sector & 0xff, from >> 8, from & 0xff]);
      out.set(r, from);
    }
    return out;
  }

  async writeSector(sector, data) {
    const size = data.length;
    await this.hidpp.request(this.idx, 0x6, [sector >> 8, sector & 0xff, 0, 0, size >> 8, size & 0xff]);
    for (let off = 0; off < size; off += LONG_PARAMS) {
      await this.hidpp.request(this.idx, 0x7, data.subarray(off, off + LONG_PARAMS));
    }
    await this.hidpp.request(this.idx, 0x8, [], { timeout: 5000 });
  }
}

export { FEATURE, MODE, HidppError, WebHidTransport, Hidpp, OnboardProfiles };
