// 실제 기기 없이 UI와 프로토콜 코드를 시험하기 위한 가상 HID++ 2.0 마우스.
// classic: 프로필 형식 2의 가상 마우스, extended: PRO X 2 DEX(형식 7)에서 읽은 데이터를 본뜬 마우스.
(function (OMM) {
  'use strict';

  const P = OMM.profile;
  const SECTOR_SIZE = 255; // 실제 기기와 같이 16의 배수가 아닌 크기
  const PROFILE_COUNT = 3;

  const VARIANTS = {
    classic: {
      name: 'OMM Demo Mouse', formatId: 2, buttonCount: 11,
      features: [0x0000, 0x0005, 0x8100, 0x2201, 0x1004], // 배열 인덱스 = 기능 인덱스
    },
    extended: {
      name: 'OMM Demo Mouse X', formatId: 7, buttonCount: 5,
      features: [0x0000, 0x0005, 0x8100, 0x2202, 0x1004, 0x8061],
    },
    analog: {
      name: 'OMM Demo Mouse S', formatId: 8, buttonCount: 5,
      features: [0x0000, 0x0005, 0x8100, 0x2202, 0x1004, 0x8061, 0x1b0c],
    },
  };

  // 확장 DPI 목록: 100~200(1), ~500(2), ~1000(5), ~2000(10), ~5000(20), ~10000(50), ~44000(100)
  const EXTENDED_DPI_LIST = P.fromHex('0064e00100c8e00201f4e00503e8e00a07d0e0141388e0322710e064abe00000');

  const CLASSIC_BUTTONS = [
    [0x80, 0x01, 0x00, 0x01], [0x80, 0x01, 0x00, 0x02], [0x80, 0x01, 0x00, 0x04],
    [0x80, 0x01, 0x00, 0x08], [0x80, 0x01, 0x00, 0x10], [0x90, 0x03, 0x00, 0x00],
    [0x90, 0x04, 0x00, 0x00], [0x90, 0x07, 0x00, 0x00], [0x90, 0x0a, 0x00, 0x00],
    [0x90, 0x01, 0x00, 0x00], [0x90, 0x02, 0x00, 0x00],
  ];

  function classicProfile(name, dpis, rate) {
    const L = P.LAYOUTS.classic;
    const s = new Uint8Array(SECTOR_SIZE).fill(0xff);
    P.setReportRate(s, L, 0, rate);
    P.setDpi(s, L, dpis.map((x) => ({ x, y: x, lod: 0 })), 1, 0);
    P.setName(s, L, name);
    CLASSIC_BUTTONS.forEach((b, i) => {
      P.setBinding(s, L, 'buttons', i, b);
      P.setBinding(s, L, 'gshift', i, b);
    });
    return P.finalize(s);
  }

  // 실기기 덤프의 앞부분(설정·버튼)과 뒷부분(조명)을 그대로 쓰고 DPI만 바꾼다.
  function extendedProfile(dpis, analog) {
    const L = P.LAYOUTS.extended;
    const s = new Uint8Array(SECTOR_SIZE).fill(0xff);
    s.set(P.fromHex('030300002003200302b004b0040240064006026009600902800c800c0200000000ff00ffffffffffffffffff3c002c01'
      + '8001000180010002800100048001000880010010'));
    s.set(P.fromHex('0300000000001f400000000300000000001f400000000300000000001f403200000300000000001f4032000003'), 208);
    P.setDpi(s, L, dpis.map((x) => ({ x, y: x, lod: 2 })), 0, 0);
    if (analog) for (const i of [0, 1]) P.setAnalog(s, P.LAYOUTS.analog, i, { actuation: 5, rtEnabled: i === 0, rtSensitivity: 3, haptic: 3 });
    return P.finalize(s);
  }

  class MockTransport {
    constructor(variant = 'classic') {
      this.v = VARIANTS[variant];
      this.onInput = null;
      this.name = this.v.name;
      this.mode = OMM.MODE.ONBOARD;
      this.current = 0x0001;
      this.write_ = null;
      const profiles = variant === 'classic'
        ? [classicProfile('', [400, 800, 1600, 3200], 1), classicProfile('FPS', [800, 1600], 1), classicProfile('Office', [1200], 8)]
        : [[1600], [800, 1200, 1600, 2400, 3200], [400]].map((dpis) => extendedProfile(dpis, variant === 'analog'));
      this.sectors = new Map([
        [0x0000, P.buildDirectory(SECTOR_SIZE, [true, true, false])],
        [0x0001, profiles[0]], [0x0002, profiles[1]], [0x0003, profiles[2]],
        [0x0101, profiles[0].slice()],
      ]);
    }

    async open() {}
    async close() {}

    async write(buf) {
      if (buf[0] !== 0xff) return; // 다른 기기 인덱스에는 응답하지 않는다
      const [devIdx, featIdx, funcSw] = buf;
      let reply;
      try {
        const params = this._handle(this.v.features[featIdx], funcSw >> 4, buf.subarray(3));
        reply = new Uint8Array(19);
        reply.set([devIdx, featIdx, funcSw]);
        reply.set(params, 3);
      } catch (code) {
        if (typeof code !== 'number') throw code;
        reply = new Uint8Array(19);
        reply.set([devIdx, 0xff, featIdx, funcSw, code]);
      }
      // 타이머는 백그라운드 탭에서 1초 단위로 지연되므로 마이크로태스크로 응답한다.
      queueMicrotask(() => this.onInput && this.onInput(0x11, reply));
    }

    _handle(feature, fn, p) {
      const name = this.v.name;
      switch (feature) {
        case 0x0000:
          if (fn === 0) {
            const idx = this.v.features.indexOf((p[0] << 8) | p[1]);
            return [idx < 0 ? 0 : idx, 0, 0];
          }
          if (fn === 1) return [4, 2, p[2]];
          break;
        case 0x0005:
          if (fn === 0) return [name.length];
          if (fn === 1) return Array.from(name.slice(p[0], p[0] + 16), (c) => c.charCodeAt(0));
          break;
        case 0x2201:
          if (fn === 1) return [0, 0x00, 0x64, 0xe0, 0x32, 0x64, 0x00, 0, 0]; // 100~25600, 50 단위
          break;
        case 0x2202:
          if (fn === 2) return [p[0], p[1], p[2], ...EXTENDED_DPI_LIST.subarray(13 * p[2], 13 * p[2] + 13)];
          break;
        case 0x8061:
          if (fn === 1) return [0x00, 0x7f]; // 125 Hz ~ 8000 Hz
          break;
        case 0x1004:
          if (fn === 1) return [87, 0x08, 0];
          break;
        case 0x1b0c:
          if (fn === 0) return [0x00, 0x03, 10 << 2, 5 << 2, 5 << 2, 0]; // 버튼 2개, 작동점 10 / 햅틱 5 / 래피드 트리거 5단계
          break;
        case 0x8100:
          return this._onboard(fn, p);
      }
      throw 7;
    }

    _onboard(fn, p) {
      const u16 = (i) => (p[i] << 8) | p[i + 1];
      switch (fn) {
        case 0x0:
          return [0x01, this.v.formatId, 0x01, PROFILE_COUNT, 0x01, this.v.buttonCount, 16, SECTOR_SIZE >> 8, SECTOR_SIZE & 0xff, 0x0a, 0x01];
        case 0x1:
          this.mode = p[0];
          return [];
        case 0x2:
          return [this.mode];
        case 0x3:
          if (!this.sectors.has(u16(0))) throw 2;
          this.current = u16(0);
          return [];
        case 0x4:
          return [this.current >> 8, this.current & 0xff];
        case 0x5: {
          const off = u16(2);
          if (off + 16 > SECTOR_SIZE) throw 2;
          const s = this.sectors.get(u16(0)) || new Uint8Array(SECTOR_SIZE).fill(0xff);
          return s.subarray(off, off + 16);
        }
        case 0x6:
          if (u16(0) >= 0x0100 || u16(2) !== 0 || u16(4) !== SECTOR_SIZE) throw 2;
          this.write_ = { sector: u16(0), data: new Uint8Array(SECTOR_SIZE), pos: 0 };
          return [];
        case 0x7:
          if (!this.write_ || this.write_.pos >= SECTOR_SIZE) throw 2;
          this.write_.data.set(p.subarray(0, Math.min(16, SECTOR_SIZE - this.write_.pos)), this.write_.pos);
          this.write_.pos += 16;
          return [];
        case 0x8:
          if (!this.write_ || this.write_.pos < SECTOR_SIZE) throw 2;
          this.sectors.set(this.write_.sector, this.write_.data);
          this.write_ = null;
          return [];
      }
      throw 7;
    }
  }

  OMM.MockTransport = MockTransport;
})((window.OMM = window.OMM || {}));
