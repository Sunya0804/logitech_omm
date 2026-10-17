// Logitech 온보드 매크로(js/macro.js) 해석·기록 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/macro.js';
import * as P from '../js/profile.js';

const SIZE = 255;
const at = (sectors) => (n) => sectors[n] ?? null;

test('a macro round-trips through one sector with a valid CRC', () => {
  const steps = [
    { kind: 'key', down: true, mods: 0x02, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x04 },
    { kind: 'delay', ms: 300 }, { kind: 'key', down: false, mods: 0, usage: 0x04 }, { kind: 'key', down: false, mods: 0x02, usage: 0 },
    ...M.mouseClick(0x0001), { kind: 'consumer', down: true, usage: 0x00e9 }, { kind: 'consumer', down: false, usage: 0x00e9 },
  ];
  const data = M.encodeMacro(steps, SIZE);
  assert.equal(data.length, SIZE);
  assert.equal(P.hasValidCrc(data), true);
  assert.deepEqual([...data.subarray(0, 9)], [0x43, 0x02, 0x00, 0x43, 0x00, 0x04, 0x40, 0x01, 0x2c]);
  assert.equal(data[3 * steps.length], 0xff);
  const back = M.readMacro(at({ 7: data }), { sector: 7, offset: 0 }, SIZE);
  assert.deepEqual(back, { steps, sectors: [7], error: null, editable: true });
});

test('macro pointers are [0x00, sector, 0x00, offset] and the profile codec agrees', () => {
  assert.deepEqual(M.macroBinding(9, 6), [0x00, 9, 0x00, 6]);
  assert.deepEqual(M.macroTarget([0x00, 9, 0x00, 6]), { sector: 9, offset: 6 });
  assert.equal(M.macroTarget([0x80, 0x01, 0x00, 0x01]), null);
  assert.deepEqual(P.decodeBinding([0x00, 9, 0x00, 6]), { kind: 'macro', sector: 9, offset: 6 });
  assert.deepEqual(P.encodeBinding({ kind: 'macro', sector: 9, offset: 6 }), [0x00, 9, 0x00, 6]);
});

test('reading follows jumps, starts at the offset and reports unknown or missing data', () => {
  const a = new Uint8Array(SIZE).fill(0xff);
  a.set([0x00, 0x00, 0x43, 0x00, 0x05, 0x60, 0x03, 0x08]); // 위치 2부터: B 누름, 섹터 8 위치 3으로 점프
  const b = new Uint8Array(SIZE).fill(0xff);
  b.set([0x99, 0x99, 0x99, 0x44, 0x00, 0x05, 0xff]);
  const r = M.readMacro(at({ 6: a, 8: b }), { sector: 6, offset: 2 }, SIZE);
  assert.equal(r.error, null);
  assert.deepEqual(r.sectors, [6, 8]);
  assert.deepEqual(r.steps.map((s) => [s.down, s.usage]), [[true, 5], [false, 5]]);

  assert.deepEqual(M.readMacro(at({ 6: a }), { sector: 6, offset: 2 }, SIZE).missing, 8);
  const odd = new Uint8Array(SIZE).fill(0xff);
  odd.set([0x77, 0x00]);
  assert.equal(M.readMacro(at({ 4: odd }), { sector: 4, offset: 0 }, SIZE).error, 'unknown');
  const control = new Uint8Array(SIZE).fill(0xff);
  control.set([0x02, 0x20, 0x01, 0xff]); // 누르는 동안 반복, 휠 1칸
  const c = M.readMacro(at({ 4: control }), { sector: 4, offset: 0 }, SIZE);
  assert.equal(c.error, null);
  assert.equal(c.editable, false);
  const loop = new Uint8Array(SIZE).fill(0xff);
  loop.set([0x60, 0x00, 0x04]);
  assert.equal(M.readMacro(at({ 4: loop }), { sector: 4, offset: 0 }, SIZE).error, 'loop');
  const runaway = new Uint8Array(SIZE).fill(0x00); // 끝 표시 없이 섹터 끝까지
  assert.equal(M.readMacro(at({ 4: runaway }), { sector: 4, offset: 0 }, SIZE).error, 'overrun');
});

test('encoding rejects empty and oversized macros', () => {
  assert.throws(() => M.encodeMacro([], SIZE));
  const max = M.capacity(SIZE);
  assert.equal(max, 84);
  const delay = { kind: 'delay', ms: 10 };
  assert.doesNotThrow(() => M.encodeMacro(Array(max).fill(delay), SIZE));
  assert.throws(() => M.encodeMacro(Array(max + 1).fill(delay), SIZE));
  assert.throws(() => M.encodeMacro([{ kind: 'other', bytes: [0x02] }], SIZE));
});

test('keyboard recordings become key steps with delays and balanced releases', () => {
  const { steps, skipped } = M.stepsFromKeys([
    { code: 'KeyX', down: false, time: 0 }, // 녹화 전부터 누르고 있던 키
    { code: 'ControlLeft', down: true, time: 100 },
    { code: 'KeyC', down: true, time: 150 },
    { code: 'KeyC', down: true, time: 160 }, // 자동 반복
    { code: 'AudioVolumeUp', down: true, time: 170 },
    { code: 'KeyC', down: false, time: 200 },
  ]);
  assert.deepEqual(skipped, ['AudioVolumeUp']);
  assert.deepEqual(steps, [
    { kind: 'key', down: true, mods: 0x01, usage: 0 },
    { kind: 'delay', ms: 50 },
    { kind: 'key', down: true, mods: 0, usage: 0x06 },
    { kind: 'delay', ms: 50 },
    { kind: 'key', down: false, mods: 0, usage: 0x06 },
    { kind: 'key', down: false, mods: 0x01, usage: 0 }, // 녹화가 끝날 때까지 누르고 있던 Ctrl
  ]);
});
