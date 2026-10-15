// Logitech 온보드 프로필(js/profile.js) 해석·수정 시험.
// 가상 기기(js/mock.js)의 섹터는 PRO X 2 DEX(형식 7) 실기기 덤프의 설정·버튼·조명 영역을 그대로 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/profile.js';
import { MockTransport } from '../js/mock.js';

const sector = (variant, number) => new MockTransport(variant).sectors.get(number).slice();
const DPI_RANGE = { min: 100, max: 44000 };

test('CRC: finalize writes a checksum that hasValidCrc accepts, and any byte change breaks it', () => {
  const s = sector('classic', 0x0001);
  assert.equal(P.hasValidCrc(s), true);
  s[10] ^= 0x01;
  assert.equal(P.hasValidCrc(s), false);
  P.finalize(s);
  assert.equal(P.hasValidCrc(s), true);
  // CCITT(0xFFFF 시작) 기준 알려진 값
  assert.equal(P.crc16(new TextEncoder().encode('123456789'), 9), 0x29b1);
});

test('format numbers pick the right layout, and unknown formats are detected from the data', () => {
  assert.equal(P.detectLayout(sector('classic', 0x0001), 2, 11, DPI_RANGE).id, 'classic');
  assert.equal(P.detectLayout(sector('extended', 0x0001), 7, 5, DPI_RANGE).id, 'extended');
  assert.equal(P.detectLayout(sector('analog', 0x0001), 8, 5, DPI_RANGE).id, 'analog');
  assert.equal(P.detectLayout(sector('extended', 0x0001), 99, 5, DPI_RANGE).id, 'extendedBasic');
  // DPI가 기기 범위를 벗어나는 데이터는 어떤 구조로도 받지 않는다.
  assert.equal(P.detectLayout(sector('classic', 0x0001), 2, 11, { min: 100, max: 200 }), null);
});

test('DPI stages, default/shift stage and lift-off round-trip on the extended layout', () => {
  const L = P.LAYOUTS.extended;
  const s = sector('extended', 0x0002);
  P.setDpi(s, L, [{ x: 400, y: 400, lod: 1 }, { x: 1600, y: 1600, lod: 3 }], 1, 0);
  const m = P.parse(s, L);
  assert.deepEqual(m.dpi, [{ x: 400, y: 400, lod: 1 }, { x: 1600, y: 1600, lod: 3 }, null, null, null]);
  assert.equal(m.defaultDpi, 1);
  assert.equal(m.shiftDpi, 0);
});

test('classic layout keeps X and Y the same and empty slots stay empty', () => {
  const L = P.LAYOUTS.classic;
  const s = sector('classic', 0x0001);
  P.setDpi(s, L, [{ x: 800, y: 800, lod: 0 }], 0, 0);
  assert.deepEqual(P.parse(s, L).dpi, [{ x: 800, y: 800, lod: 0 }, null, null, null, null]);
});

test('profile names are UTF-16, empty names are stored as 0xFF', () => {
  const L = P.LAYOUTS.extended;
  const s = sector('extended', 0x0001);
  P.setName(s, L, 'FPS 프로필');
  assert.equal(P.parse(s, L).name, 'FPS 프로필');
  P.setName(s, L, '');
  assert.equal(P.parse(s, L).name, '');
  assert.equal(s[L.name], 0xff);
});

test('report rate and bunny hop bytes are written where they are read', () => {
  const L = P.LAYOUTS.extended;
  const s = sector('extended', 0x0001);
  P.setReportRate(s, L, 0, 3);
  P.setReportRate(s, L, 1, 6);
  P.setBunnyHop(s, L, 50);
  const m = P.parse(s, L);
  assert.deepEqual(m.reportRates, [3, 6]);
  assert.equal(m.bunnyHop, 50);
});

test('button bindings encode and decode for every editable kind', () => {
  for (const action of [
    { kind: 'mouse', mask: 0x0004 }, { kind: 'key', mods: 0x01, usage: 0x06 },
    { kind: 'consumer', usage: 0x00e9 }, { kind: 'special', code: 0x05 }, { kind: 'disabled' },
  ]) {
    assert.deepEqual(P.decodeBinding(P.encodeBinding(action)), action);
  }
  assert.equal(P.decodeBinding([0x00, 0x01, 0x02, 0x03]).kind, 'macro');
  assert.equal(P.decodeBinding([0x42, 0, 0, 0]).kind, 'raw');
  assert.throws(() => P.encodeBinding({ kind: 'macro' }));
});

test('setting a binding touches only that button', () => {
  const L = P.LAYOUTS.extended;
  const s = sector('extended', 0x0001);
  const before = s.slice();
  P.setBinding(s, L, 'buttons', 2, P.encodeBinding({ kind: 'disabled' }));
  const changed = [...s.keys()].filter((i) => s[i] !== before[i]);
  assert.ok(changed.every((i) => i >= L.buttons + 8 && i < L.buttons + 12), `changed bytes: ${changed}`);
});

test('HITS (analog buttons) values round-trip and are clamped to 6 bits', () => {
  const L = P.LAYOUTS.analog;
  const s = sector('analog', 0x0001);
  P.setAnalog(s, L, 1, { actuation: 7, rtEnabled: true, rtSensitivity: 2, haptic: 4 });
  assert.deepEqual(P.getAnalog(s, L, 1), { actuation: 7, rtEnabled: true, rtSensitivity: 2, haptic: 4 });
  assert.deepEqual([...P.analogBytes(s, L, 1)], [7 << 2, (2 << 2) | 1, 4 << 2]);
  P.setAnalog(s, L, 0, { actuation: 500, rtEnabled: false, rtSensitivity: -3, haptic: 0 });
  assert.deepEqual(P.getAnalog(s, L, 0), { actuation: 0x3f, rtEnabled: false, rtSensitivity: 0, haptic: 0 });
});

test('profile directory round-trips and stops at the end marker', () => {
  const dir = P.buildDirectory(255, [true, false, true]);
  assert.equal(P.hasValidCrc(dir), true);
  assert.deepEqual(P.parseDirectory(dir, 5), [
    { sector: 1, enabled: true }, { sector: 2, enabled: false }, { sector: 3, enabled: true },
  ]);
});

test('hex helpers round-trip and reject malformed input', () => {
  const bytes = Uint8Array.from([0, 1, 0x7f, 0xff]);
  assert.equal(P.toHex(bytes), '00017fff');
  assert.deepEqual(P.fromHex('00017fff'), bytes);
  assert.throws(() => P.fromHex('0g'));
});

test('sameData ignores only the CRC bytes', () => {
  const a = sector('classic', 0x0001);
  const b = a.slice();
  b[b.length - 1] ^= 0xff;
  assert.equal(P.sameData(a, b), true);
  b[0] ^= 0x01;
  assert.equal(P.sameData(a, b), false);
});
