// ATK 온보드 매크로(js/compx-macro.js) 해석·기록 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../js/compx-macro.js';

const CTRL_C = [
  { kind: 'key', down: true, mods: 0x01, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x06 }, { kind: 'delay', ms: 30 },
  { kind: 'key', down: false, mods: 0, usage: 0x06 }, { kind: 'key', down: false, mods: 0x01, usage: 0 },
];

test('a slot is the vendor header, the event count, 5-byte events and a checksum', () => {
  const data = X.encodeSlot(CTRL_C);
  assert.equal(X.COUNT_OFFSET, 31);
  assert.deepEqual([...data.subarray(0, 10)], [8, 2, 2, 2, 2, 2, 2, 2, 2, 0xff]);
  const body = data.subarray(X.COUNT_OFFSET);
  // 대기가 없던 이벤트는 1 ms, 대기 단계는 앞 이벤트에 붙는다.
  assert.deepEqual([...body.subarray(0, 21)], [
    4,
    0x80, 0x01, 0x00, 0x00, 0x01,
    0x81, 0x06, 0x00, 0x00, 0x1e,
    0x41, 0x06, 0x00, 0x00, 0x01,
    0x40, 0x01, 0x00, 0x00, 0x01,
  ]);
  assert.equal(body.length, 22);
  assert.equal((body.reduce((a, b) => a + b, 0) & 0xff), 0x55);
  const back = X.decodeSlot(body);
  assert.deepEqual(back, { steps: CTRL_C, empty: false, error: null, editable: true });
});

test('slots are addressed from 0x0300 in 384-byte steps and buttons point at them', () => {
  assert.equal(X.slotAddress(0), 0x0300);
  assert.equal(X.slotAddress(11), 0x1380);
  assert.equal(X.slotAddress(11) + 384, 0x1500);
  const param = X.keyParam(3, X.REPEAT.WHILE_HELD);
  assert.equal(param, 0x03fe);
  assert.equal(X.keySlot({ cls: X.KEY_CLASS, param }), 3);
  assert.equal(X.keyRepeat({ cls: X.KEY_CLASS, param }), 254);
  assert.equal(X.keySlot({ cls: 1, param: 0x0100 }), null);
});

test('empty, damaged and unknown slots are reported without guessing', () => {
  assert.equal(X.decodeSlot(Uint8Array.of(0)).empty, true);
  assert.equal(X.decodeSlot(Uint8Array.of(0xff)).empty, true);
  assert.equal(X.decodeSlot(Uint8Array.of(71)).empty, true);
  const body = X.encodeSlot(CTRL_C).slice(X.COUNT_OFFSET);
  assert.equal(X.decodeSlot(body.subarray(0, 10)).error, 'short');
  body[3] ^= 1;
  assert.equal(X.decodeSlot(body).error, 'checksum');
  // 휠 이벤트(종류 6)는 원래 바이트로 남고 그대로 다시 기록된다.
  const wheel = [{ kind: 'other', bytes: [0x06, 0x01, 0x00] }, { kind: 'delay', ms: 20 }, { kind: 'other', bytes: [0x06, 0x00, 0x00] }];
  const r = X.decodeSlot(X.encodeSlot(wheel).subarray(X.COUNT_OFFSET));
  assert.deepEqual(r.steps, wheel);
  assert.equal(r.editable, true);
});

test('encoding counts events, drops leading delays and rejects what it cannot write', () => {
  assert.throws(() => X.encodeSlot([]));
  assert.throws(() => X.encodeSlot([{ kind: 'delay', ms: 10 }]));
  assert.throws(() => X.encodeSlot([{ kind: 'key', down: true, mods: 0x01, usage: 0x04 }]));
  assert.throws(() => X.encodeSlot([{ kind: 'consumer', down: true, usage: 0xe9 }]));
  const click = [{ kind: 'mouse', down: true, mask: 1 }, { kind: 'delay', ms: 10 }];
  const max = Array.from({ length: X.MAX_EVENTS }, () => click).flat();
  assert.equal(X.eventCount(max), 70);
  const full = X.encodeSlot(max);
  assert.ok(full.length <= 384);
  assert.throws(() => X.encodeSlot([...max, ...click]));
  const lead = X.encodeSlot([{ kind: 'delay', ms: 500 }, ...click]).subarray(X.COUNT_OFFSET);
  assert.deepEqual([...lead.subarray(0, 6)], [1, 0x84, 0x01, 0x00, 0x00, 0x0a]);
});

test('reading a slot asks for the count first and then only the bytes it needs', async () => {
  const flash = new Uint8Array(0x1500).fill(0xff);
  flash.set(X.encodeSlot(CTRL_C), X.slotAddress(2));
  const reads = [];
  const dev = {
    async readFlash(address, length) { reads.push([address, length]); return flash.slice(address, address + length); },
    async writeFlash(address, bytes) { flash.set(bytes, address); },
  };
  assert.deepEqual([...(await X.readSlot(dev, 0))], [0xff]);
  const body = await X.readSlot(dev, 2);
  assert.deepEqual(reads, [[0x031f, 1], [0x061f, 1], [0x061f, 22]]);
  assert.deepEqual(X.decodeSlot(body).steps, CTRL_C);
  const written = await X.writeSlot(dev, 5, CTRL_C.slice(1, 4));
  assert.equal(written[0], 2);
  // 기기가 다르게 기록하면 알린다.
  dev.writeFlash = async () => {};
  await assert.rejects(() => X.writeSlot(dev, 6, CTRL_C));
});
