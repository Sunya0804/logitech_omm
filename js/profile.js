// 온보드 프로필 섹터(HID++ 0x8100) 바이너리 포맷 해석/수정.
(function (OMM) {
  'use strict';

  const DPI_SLOTS = 5;
  const MAX_BUTTONS = 16;
  const NAME_CHARS = 24;

  // 프로필 형식별 필드 오프셋. 공식 Onboard Memory Manager 2.7의 구조 정보와 대조했고,
  // classic은 PRO X Wireless(형식 4)·G502 X PLUS(형식 5), extended는 PRO X 2 DEX(형식 7) 실기기로도 확인했다.
  // reportRate: 보고율 바이트들. rateUnit 'ms'는 보고 간격(1=1000Hz), 'index'는 125 << n Hz.
  // null인 필드는 그 형식에 없거나 값의 표현을 알 수 없어 건드리지 않는다.
  const WIRELESS_WIRED = [{ offset: 0, label: '무선' }, { offset: 1, label: '유선' }];
  const LAYOUTS = {
    // 형식 1~5
    classic: {
      id: 'classic', reportRate: [{ offset: 0, label: '' }], rateUnit: 'ms',
      defaultDpi: 1, shiftDpi: 2, dpi: 3, dpiEntrySize: 2, dpiY: null, lodEditable: false, bunnyHop: null,
      buttons: 32, gshift: 96, maxButtons: 16, maxGShift: 16, name: 160, analog: null, minSize: 210,
    },
    // 형식 10 (펌웨어 업데이트 이후의 G502 X 계열): classic에 세로 DPI 표가 추가되어 버튼이 13개로 줄었다.
    // 보고율은 연결 방식별 바이트(0x14, 0x15)가 따로 있는데 값의 표현을 알 수 없어 편집하지 않는다.
    classicDpiY: {
      id: 'classicDpiY', reportRate: [], rateUnit: null,
      defaultDpi: 1, shiftDpi: 2, dpi: 3, dpiEntrySize: 2, dpiY: 0x56, lodEditable: false, bunnyHop: null,
      buttons: 32, gshift: 96, maxButtons: 13, maxGShift: 16, name: 160, analog: null, minSize: 210,
    },
    // 형식 6: 보고율이 무선/유선 2바이트, DPI 단계가 [X(2), Y(2), LOD(1)] 5바이트.
    // lodEditable: 리프트오프 거리 값(1 낮음, 2 중간, 3 높음)이 실기기 데이터로 확인된 형식인지 (형식 7, 8).
    extendedBasic: {
      id: 'extendedBasic', reportRate: WIRELESS_WIRED, rateUnit: 'index',
      defaultDpi: 2, shiftDpi: 3, dpi: 4, dpiEntrySize: 5, dpiY: null, lodEditable: false, bunnyHop: null,
      buttons: 0x30, gshift: 0x70, maxButtons: 12, maxGShift: 12, name: 0xa0, analog: null, minSize: 210,
    },
    // 형식 7: 형식 6에 버니합 방지 시간(0x25, 10ms 단위, 0은 끔)이 추가됐다.
    extended: {
      id: 'extended', reportRate: WIRELESS_WIRED, rateUnit: 'index',
      defaultDpi: 2, shiftDpi: 3, dpi: 4, dpiEntrySize: 5, dpiY: null, lodEditable: true, bunnyHop: 0x25,
      buttons: 0x30, gshift: 0x70, maxButtons: 12, maxGShift: 12, name: 0xa0, analog: null, minSize: 210,
    },
    // 형식 8 (PRO X2 SUPERSTRIKE): extended에 아날로그 버튼 설정(버튼당 3바이트)이 추가됐다.
    analog: {
      id: 'analog', reportRate: WIRELESS_WIRED, rateUnit: 'index',
      defaultDpi: 2, shiftDpi: 3, dpi: 4, dpiEntrySize: 5, dpiY: null, lodEditable: true, bunnyHop: 0x25,
      buttons: 0x30, gshift: 0x70, maxButtons: 12, maxGShift: 12, name: 0xa0,
      analog: { offset: 0x26, count: 2 }, minSize: 210,
    },
  };
  const LAYOUT_BY_FORMAT = {
    1: 'classic', 2: 'classic', 3: 'classic', 4: 'classic', 5: 'classic',
    6: 'extendedBasic', 7: 'extended', 8: 'analog', 10: 'classicDpiY',
  };
  const ANALOG_MAX = 0x3f; // 값은 각 바이트의 상위 6비트에 저장된다

  // CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021)
  function crc16(data, len) {
    let crc = 0xffff;
    for (let i = 0; i < len; i++) {
      crc ^= data[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  // CRC는 항상 섹터의 마지막 2바이트(빅엔디언)다. 실제 기기의 섹터 크기는 보통 255.
  function hasValidCrc(sector) {
    const n = sector.length;
    return ((sector[n - 2] << 8) | sector[n - 1]) === crc16(sector, n - 2);
  }

  function finalize(sector) {
    const n = sector.length;
    const crc = crc16(sector, n - 2);
    sector[n - 2] = crc >> 8;
    sector[n - 1] = crc & 0xff;
    return sector;
  }

  // CRC 바이트를 제외한 내용 비교
  function sameData(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length - 2; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  const le16 = (raw, o) => raw[o] | (raw[o + 1] << 8);

  // DPI 단계: {x, y, lod} 또는 비어 있으면 null
  function readDpi(raw, L) {
    const out = [];
    for (let i = 0; i < DPI_SLOTS; i++) {
      const o = L.dpi + L.dpiEntrySize * i;
      const x = le16(raw, o);
      if (x === 0 || x === 0xffff) out.push(null);
      else if (L.dpiEntrySize === 5) out.push({ x, y: le16(raw, o + 2), lod: raw[o + 4] });
      else out.push({ x, y: L.dpiY === null ? x : le16(raw, L.dpiY + 2 * i), lod: 0 });
    }
    return out;
  }

  function parse(raw, L) {
    let name = '';
    for (let i = 0; L.name !== null && i < NAME_CHARS; i++) {
      const c = le16(raw, L.name + 2 * i);
      if (c === 0 || c === 0xffff) break;
      name += String.fromCharCode(c);
    }
    return {
      reportRates: L.reportRate.map((r) => raw[r.offset]),
      defaultDpi: raw[L.defaultDpi], shiftDpi: raw[L.shiftDpi], dpi: readDpi(raw, L), name,
      bunnyHop: L.bunnyHop ? raw[L.bunnyHop] : null,
    };
  }

  // index: L.reportRate 안에서의 순번
  function setReportRate(raw, L, index, value) {
    raw[L.reportRate[index].offset] = value;
  }

  // entries: 앞에서부터 채운 {x, y, lod} 목록. 남는 슬롯은 0으로 비운다.
  function setDpi(raw, L, entries, defaultIdx, shiftIdx) {
    for (let i = 0; i < DPI_SLOTS; i++) {
      const o = L.dpi + L.dpiEntrySize * i;
      const e = entries[i] || { x: 0, y: 0, lod: 0 };
      raw[o] = e.x & 0xff;
      raw[o + 1] = e.x >> 8;
      if (L.dpiEntrySize === 5) raw.set([e.y & 0xff, e.y >> 8, e.lod], o + 2);
      if (L.dpiY !== null) raw.set([e.y & 0xff, e.y >> 8], L.dpiY + 2 * i);
    }
    raw[L.defaultDpi] = defaultIdx;
    raw[L.shiftDpi] = shiftIdx;
  }

  // value: 저장 바이트 (0 = 끔, 그 외 = 시간(ms) / 10)
  function setBunnyHop(raw, L, value) {
    raw[L.bunnyHop] = value;
  }

  // 아날로그 버튼 i의 저장 바이트 3개. 기기의 현재 값 설정 명령(0x1B0C)도 같은 표현을 쓴다.
  function analogBytes(raw, L, i) {
    return raw.slice(L.analog.offset + 3 * i, L.analog.offset + 3 * i + 3);
  }

  function setName(raw, L, name) {
    // 이름이 없는 프로필은 기기에 0xFF로 채워져 있다.
    const pad = name.length ? 0 : 0xffff;
    for (let i = 0; i < NAME_CHARS; i++) {
      const c = i < name.length ? name.charCodeAt(i) : pad;
      raw[L.name + 2 * i] = c & 0xff;
      raw[L.name + 2 * i + 1] = c >> 8;
    }
  }

  // layer: 'buttons' | 'gshift'
  function getBinding(raw, L, layer, i) {
    const o = L[layer] + 4 * i;
    return raw.slice(o, o + 4);
  }

  function setBinding(raw, L, layer, i, bytes) {
    raw.set(bytes, L[layer] + 4 * i);
  }

  // 아날로그 버튼 i의 설정. 바이트 0: 작동점 << 2, 바이트 1: 래피드 트리거 민감도 << 2 | 사용(비트 0),
  // 바이트 2: 클릭 햅틱 << 2.
  function getAnalog(raw, L, i) {
    const o = L.analog.offset + 3 * i;
    return { actuation: raw[o] >> 2, rtEnabled: !!(raw[o + 1] & 1), rtSensitivity: raw[o + 1] >> 2, haptic: raw[o + 2] >> 2 };
  }

  function setAnalog(raw, L, i, a) {
    const clamp = (v) => Math.min(ANALOG_MAX, Math.max(0, v | 0));
    raw.set([clamp(a.actuation) << 2, (clamp(a.rtSensitivity) << 2) | (a.rtEnabled ? 1 : 0), clamp(a.haptic) << 2], L.analog.offset + 3 * i);
  }

  function decodeBinding(b) {
    if (b[0] === 0x80) {
      if (b[1] === 0x01) return { kind: 'mouse', mask: (b[2] << 8) | b[3] };
      if (b[1] === 0x02) return { kind: 'key', mods: b[2], usage: b[3] };
      if (b[1] === 0x03) return { kind: 'consumer', usage: (b[2] << 8) | b[3] };
    }
    if (b[0] === 0x90) return { kind: 'special', code: b[1] };
    if (b[0] === 0xff) return { kind: 'disabled' };
    if (b[0] === 0x00) return { kind: 'macro' };
    return { kind: 'raw' };
  }

  function encodeBinding(a) {
    switch (a.kind) {
      case 'mouse': return [0x80, 0x01, a.mask >> 8, a.mask & 0xff];
      case 'key': return [0x80, 0x02, a.mods & 0xff, a.usage & 0xff];
      case 'consumer': return [0x80, 0x03, a.usage >> 8, a.usage & 0xff];
      case 'special': return [0x90, a.code, 0x00, 0x00];
      case 'disabled': return [0xff, 0xff, 0xff, 0xff];
    }
    throw new Error('인코딩할 수 없는 할당: ' + a.kind);
  }

  // 이 섹터를 레이아웃 L로 읽었을 때 값들이 말이 되는지 검사한다.
  function plausible(raw, L, buttonCount, dpiRange) {
    if (raw.length < L.minSize) return false;
    const m = parse(raw, L);
    const rateOk = L.rateUnit === 'ms' ? (r) => r >= 1 && r <= 8 : (r) => r <= 6;
    if (!m.reportRates.every(rateOk)) return false;
    const stages = m.dpi.filter(Boolean);
    const inRange = (v) => v >= dpiRange.min && v <= dpiRange.max;
    if (!stages.length || !stages.every((e) => inRange(e.x) && inRange(e.y) && e.lod <= 0x0f)) return false;
    if (m.defaultDpi >= DPI_SLOTS || m.shiftDpi >= DPI_SLOTS) return false;
    for (let i = 0; i < Math.min(buttonCount, L.maxButtons); i++) {
      if (decodeBinding(getBinding(raw, L, 'buttons', i)).kind === 'raw') return false;
    }
    return true;
  }

  // 프로필 형식 번호에 해당하는 레이아웃을 고르고, 실제 데이터가 그 구조로 말이 되는지 확인한다.
  // 모르는 형식 번호는 최신 구조부터 차례로 맞춰 본다. 어느 쪽으로도 읽히지 않으면 null.
  function detectLayout(raw, formatId, buttonCount, dpiRange) {
    const known = LAYOUT_BY_FORMAT[formatId];
    const candidates = known ? [LAYOUTS[known]] : [LAYOUTS.extendedBasic, LAYOUTS.classic];
    return candidates.find((L) => plausible(raw, L, buttonCount, dpiRange)) || null;
  }

  // 섹터 0x0000: [섹터(2, BE), 활성(1), 예약(1)] 반복, 0xFFFF로 종료
  function parseDirectory(sector, count) {
    const entries = [];
    for (let i = 0; i < count; i++) {
      const addr = (sector[4 * i] << 8) | sector[4 * i + 1];
      if (addr === 0xffff) break;
      entries.push({ sector: addr, enabled: !!sector[4 * i + 2] });
    }
    return entries;
  }

  function buildDirectory(sectorSize, enabledList) {
    // 실제 기기가 쓰는 형태 그대로: 예약 바이트와 나머지는 0xFF
    const s = new Uint8Array(sectorSize).fill(0xff);
    enabledList.forEach((en, i) => s.set([0x00, i + 1, en ? 1 : 0, 0xff], 4 * i));
    return finalize(s);
  }

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function fromHex(hex) {
    if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('잘못된 16진수 데이터');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
  }

  OMM.profile = {
    LAYOUTS, LAYOUT_BY_FORMAT, DPI_SLOTS, NAME_CHARS, ANALOG_MAX,
    crc16, hasValidCrc, finalize, sameData, parse, detectLayout,
    setReportRate, setDpi, setName, setBunnyHop, analogBytes, getBinding, setBinding, getAnalog, setAnalog, decodeBinding, encodeBinding,
    parseDirectory, buildDirectory, toHex, fromHex,
  };
})((window.OMM = window.OMM || {}));
