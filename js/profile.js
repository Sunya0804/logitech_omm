// 온보드 프로필 섹터(HID++ 0x8100) 바이너리 포맷 해석/수정.
(function (OMM) {
  'use strict';

  const DPI_SLOTS = 5;
  const MAX_BUTTONS = 16;
  const NAME_CHARS = 24;

  // 필드 오프셋. null인 필드는 위치가 확인되지 않아 읽지도 쓰지도 않는다.
  const LAYOUTS = {
    // 프로필 형식 1~5. libratbag(hidpp20.c)의 hidpp20_internal_profile 기준,
    // PRO X Wireless(형식 4)와 G502 X PLUS(형식 5) 실기기로 확인.
    classic: {
      id: 'classic', reportRate: [0], defaultDpi: 1, shiftDpi: 2, dpi: 3, dpiEntrySize: 2,
      buttons: 32, gshift: 96, name: 160, minSize: 210,
    },
    // 프로필 형식 7. PRO X 2 DEX 실기기 데이터로 확인. 보고율이 2바이트(연결 방식별)이고
    // DPI 단계가 [X(2), Y(2), LOD(1)] 5바이트로 늘어나 버튼 영역이 16바이트 뒤로 밀렸다.
    extended: {
      id: 'extended', reportRate: [0, 1], defaultDpi: 2, shiftDpi: 3, dpi: 4, dpiEntrySize: 5,
      buttons: 48, gshift: null, name: null, minSize: 114,
    },
  };

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
      else out.push({ x, y: x, lod: 0 });
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
      reportRates: L.reportRate.map((o) => raw[o]),
      defaultDpi: raw[L.defaultDpi], shiftDpi: raw[L.shiftDpi], dpi: readDpi(raw, L), name,
    };
  }

  function setReportRate(raw, L, value) {
    for (const o of L.reportRate) raw[o] = value;
  }

  // entries: 앞에서부터 채운 {x, y, lod} 목록. 남는 슬롯은 0으로 비운다.
  function setDpi(raw, L, entries, defaultIdx, shiftIdx) {
    for (let i = 0; i < DPI_SLOTS; i++) {
      const o = L.dpi + L.dpiEntrySize * i;
      const e = entries[i] || { x: 0, y: 0, lod: 0 };
      raw[o] = e.x & 0xff;
      raw[o + 1] = e.x >> 8;
      if (L.dpiEntrySize === 5) raw.set([e.y & 0xff, e.y >> 8, e.lod], o + 2);
    }
    raw[L.defaultDpi] = defaultIdx;
    raw[L.shiftDpi] = shiftIdx;
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
    const rateOk = L === LAYOUTS.classic ? (r) => r >= 1 && r <= 8 : (r) => r <= 6;
    if (!m.reportRates.every(rateOk)) return false;
    const stages = m.dpi.filter(Boolean);
    const inRange = (v) => v >= dpiRange.min && v <= dpiRange.max;
    if (!stages.length || !stages.every((e) => inRange(e.x) && inRange(e.y) && e.lod <= 0x0f)) return false;
    if (m.defaultDpi >= DPI_SLOTS || m.shiftDpi >= DPI_SLOTS) return false;
    for (let i = 0; i < Math.min(buttonCount, MAX_BUTTONS); i++) {
      if (decodeBinding(getBinding(raw, L, 'buttons', i)).kind === 'raw') return false;
    }
    return true;
  }

  // 프로필 형식 번호로 예상되는 레이아웃을 고르되, 실제 데이터와 맞지 않으면 다른 쪽을 시도한다.
  // 어느 쪽으로도 읽히지 않으면 null.
  function detectLayout(raw, formatId, buttonCount, dpiRange) {
    const expected = formatId >= 6 ? LAYOUTS.extended : LAYOUTS.classic;
    const other = expected === LAYOUTS.classic ? LAYOUTS.extended : LAYOUTS.classic;
    return [expected, other].find((L) => plausible(raw, L, buttonCount, dpiRange)) || null;
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
    LAYOUTS, DPI_SLOTS, MAX_BUTTONS, NAME_CHARS,
    crc16, hasValidCrc, finalize, sameData, parse, detectLayout,
    setReportRate, setDpi, setName, getBinding, setBinding, decodeBinding, encodeBinding,
    parseDirectory, buildDirectory, toHex, fromHex,
  };
})((window.OMM = window.OMM || {}));
