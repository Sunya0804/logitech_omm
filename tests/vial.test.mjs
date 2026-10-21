import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../js/i18n.js';
import { ViaDevice } from '../js/via.js';
import { ViaSession, readVialDefinition } from '../js/via-session.js';
import { MockViaDevice } from '../js/mock-via.js';
import { packed, definition } from '../js/vial-demo.js';

setLang('ko');

const vialMock = (vial = {}, extra = {}) => new MockViaDevice({
  vendorId: 0x1234, productId: 0x5678, productName: 'Vial 60', rows: 5, cols: 15, layers: 4, macroCount: 4, macroBufferSize: 128,
  encoders: { '0,0,0': 0xaa, '0,0,1': 0xa9 },
  vial: {
    packed,
    tapDance: [{ onTap: 0x04, onHold: 0xe0, onDoubleTap: 0x05, onTapHold: 0, term: 200 }, { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, term: 200 }],
    combos: [{ keys: [0x04, 0x05, 0, 0], output: 0x29 }],
    keyOverrides: [{ trigger: 0x2a, replacement: 0x4c, layers: 0xffff, triggerMods: 0x02, negativeMods: 0, suppressedMods: 0x02, options: 0x87 }],
    settings: { 7: [2, 200], 21: [4, 0], 3: [1, 0], 999: [1, 5] },
    ...vial,
  },
  ...extra,
});

async function open(mock) {
  const dev = new ViaDevice([mock]);
  await dev.open();
  const found = await readVialDefinition(dev, await dev.protocolVersion());
  const s = new ViaSession(dev, found.json, found.vial);
  await s.load();
  return { dev, s, found };
}

test('a Vial keyboard is found by its protocol and gives its own compressed definition', async () => {
  const { found, s } = await open(vialMock());
  assert.equal(found.vial.protocol, 6);
  assert.equal(found.vial.uid, '0102030405060708');
  assert.deepEqual({ ...found.json, vendorProductId: undefined }, { ...definition, vendorProductId: undefined });
  assert.equal(found.json.vendorProductId, 0x12345678);
  assert.equal(s.def.name, 'GOMM Vial 60');
  assert.equal(s.protocol, 9);
  assert.equal(s.editable, true);
  // VIA 키보드(프로토콜 12)에는 Vial 명령을 보내지 않는다
  const via = new MockViaDevice();
  const dev = new ViaDevice([via]);
  await dev.open();
  assert.equal(await readVialDefinition(dev, await dev.protocolVersion()), null);
  // 프로토콜 9인 VIA 키보드는 Vial 명령에 「모르는 명령」으로 답한다
  const old = new MockViaDevice({ protocol: 9 });
  const oldDev = new ViaDevice([old]);
  await oldDev.open();
  assert.equal(await readVialDefinition(oldDev, 9), null);
});

test('Vial protocol 5 and older keep the old keycodes and are read only', async () => {
  const { s } = await open(vialMock({ protocol: 5 }));
  assert.equal(s.editable, false);
  assert.throws(() => s.setKeycode(0, 0, 0, 0x04), /편집할 수 없습니다/);
});

test('tap dance, combos, key overrides and QMK settings load and save with read-back', async () => {
  const { s, dev } = await open(vialMock());
  const mock = dev.dev;
  assert.deepEqual(s.vialEntry('tapDance', 0), { onTap: 0x04, onHold: 0xe0, onDoubleTap: 0x05, onTapHold: 0, term: 200 });
  assert.deepEqual(s.vialEntry('combos', 0), { keys: [0x04, 0x05, 0, 0], output: 0x29 });
  assert.equal(s.vialEntry('keyOverrides', 0).options, 0x87);
  // 이 앱이 모르는 설정 번호(999)는 읽지 않는다
  assert.deepEqual(s.work.vial.settings, { 3: 0, 7: 200, 21: 0 });
  assert.equal(s.encoder(0, 0, true), 0xa9);
  assert.equal(s.keycodeGroups().find((g) => g.id === 'tapdance').keys.map((k) => k.label).join(), 'TD(0),TD(1)');

  s.setVialEntry('tapDance', 1, { onTap: 0x06, term: 180 });
  s.setVialEntry('combos', 0, { keys: [0x04, 0x05, 0x06, 0], output: 0x2a });
  s.setVialEntry('keyOverrides', 0, { options: 0x07 });
  s.setQmkSetting(7, 250);
  s.setQmkSetting(21, 1 << 7);
  s.setEncoder(1, 0, false, 0x80);
  assert.throws(() => s.setVialEntry('tapDance', 0, { term: 70000 }), /범위/);
  assert.throws(() => s.setQmkSetting(3, 256), /범위/);
  assert.throws(() => s.setQmkSetting(999, 1), /범위/);
  assert.deepEqual(s.changes().map((c) => c.kind).sort(), ['encoder', 'qmk', 'qmk', 'vial', 'vial', 'vial']);
  assert.equal(s.needsUnlock(), false); // 잠겨 있어도 이 변경들은 저장할 수 있다
  await s.save();
  assert.equal(s.isDirty(), false);
  assert.deepEqual(mock.vial.tapDance[1], { onTap: 0x06, onHold: 0, onDoubleTap: 0, onTapHold: 0, term: 180 });
  assert.deepEqual(mock.vial.combos[0].keys, [0x04, 0x05, 0x06, 0]);
  assert.equal(mock.vial.keyOverrides[0].options, 0x07);
  assert.deepEqual([mock.vial.settings[7][1], mock.vial.settings[21][1]], [250, 128]);
  assert.equal(mock.encoders.get('1,0,0'), 0x80);
  // 잠금·QMK 설정 초기화·부트로더 명령은 보내지 않는다
  assert.equal(mock.log.some((p) => p[0] === 0xfe && [0x08, 0x0c].includes(p[1])), false);
});

test('a locked Vial keyboard must be unlocked before macros, QK_BOOT and the key test', async () => {
  const { s, dev } = await open(vialMock());
  const mock = dev.dev;
  assert.equal(s.locked(), true);
  assert.deepEqual(s.unlockKeys, [[0, 0], [0, 1]]);
  await assert.rejects(s.matrixState(), /잠금을 푼 뒤/);
  s.setMacro(0, [{ kind: 'text', text: 'hi' }]);
  assert.equal(s.needsUnlock(), true);
  await assert.rejects(s.save(), /Vial 잠금을 풀어야/);
  assert.equal(mock.log.length, 0);
  s.revert();
  s.setVialEntry('tapDance', 0, { onHold: 0x7c00 });
  assert.equal(s.needsUnlock(), true);
  s.revert();

  // 정해진 키를 누르고 있는 동안 진행되어 풀린다. 떼면 처음부터 다시 센다.
  await s.startUnlock();
  mock.matrix = [[0, 0]];
  assert.equal((await s.pollUnlock()).counter, 3);
  mock.matrix = [[0, 0], [0, 1]];
  await s.pollUnlock();
  await s.pollUnlock();
  const done = await s.pollUnlock();
  assert.equal(done.unlocked, true);
  assert.equal(s.locked(), false);
  mock.matrix = [[1, 2]];
  const pressed = await s.matrixState();
  assert.equal(pressed[1][2], true);
  s.setMacro(0, [{ kind: 'text', text: 'hi' }]);
  await s.save();
  assert.equal(new TextDecoder().decode(mock.macroBuffer.slice(0, 2)), 'hi');
});

test('Vial entries travel in GOMM backups', async () => {
  const { s } = await open(vialMock());
  const backup = JSON.parse(JSON.stringify(s.exportBackup()));
  assert.equal(backup.vial.tapDance.length, 2);
  backup.vial.tapDance[0] = { term: 300, onTapHold: 0, onDoubleTap: 0x05, onHold: 0xe0, onTap: 0x04 }; // 칸 순서가 달라도 된다
  backup.vial.settings[7] = 220;
  const { s: fresh } = await open(vialMock());
  fresh.importBackup(backup);
  assert.deepEqual(fresh.changes().map((c) => c.kind).sort(), ['qmk', 'vial']);
  assert.equal(fresh.vialEntry('tapDance', 0).term, 300);
  assert.throws(() => fresh.importBackup({ ...backup, vial: { ...backup.vial, combos: [{ keys: [1], output: 2 }] } }), /Vial 항목/);
});
