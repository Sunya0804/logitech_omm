import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/razer.js';
import { MockRazer } from '../js/mock-razer.js';

test('Razer frames: 90-byte layout, XOR checksum, busy, stale and corrupt replies', () => {
  const p = R.encodeRequest([0x04, 0x86, 0x26], [0x01], 0x1f);
  assert.equal(p.length, 90);
  assert.deepEqual([...p.slice(0, 9)], [0, 0x1f, 0, 0, 0, 0x26, 0x04, 0x86, 0x01]);
  assert.equal(p[88], 0x26 ^ 0x04 ^ 0x86 ^ 0x01);
  const reply = Uint8Array.from(p); reply[0] = 2; reply[8] = 7; reply[88] = R.checksum(reply);
  assert.equal(R.decodeReply(reply, [0x04, 0x86])[0], 7);
  assert.equal(R.decodeReply(Uint8Array.from([0, ...reply]), [0x04, 0x86])[0], 7); // 보고서 번호가 붙은 답
  assert.equal(R.decodeReply(reply, [0x00, 0x81]), null); // 앞선 명령의 답
  const busy = Uint8Array.from(reply); busy[0] = 1; busy[88] = R.checksum(busy);
  assert.equal(R.decodeReply(busy, [0x04, 0x86]), null);
  const bad = Uint8Array.from(reply); bad[88] ^= 1;
  assert.throws(() => R.decodeReply(bad, [0x04, 0x86]), /corrupt/);
  const no = Uint8Array.from(reply); no[0] = 5; no[88] = R.checksum(no);
  assert.throws(() => R.decodeReply(no, [0x04, 0x86]));
  const table = R.encodeStages(1, 2, [{ x: 400, y: 400 }, { x: 1600, y: 800 }]);
  assert.equal(table.length, 0x26);
  assert.deepEqual(R.decodeStages(table), { active: 2, stages: [{ x: 400, y: 400 }, { x: 1600, y: 800 }] });
});

test('Razer driver reads a Viper V3 Pro on its receiver and saves DPI stages and HyperPolling rate', async () => {
  const dev = new MockRazer({ tid: 0x1f, busyReplies: 2 });
  dev.stages[1] = [800, 1000]; // 2단계는 세로 DPI가 따로 설정돼 있다
  const client = R.createClient([dev]);
  const s = await client.readStatus();
  assert.deepEqual([s.name, s.connectionType, s.firmware[0], s.batteryPercent], ['Razer Viper V3 Pro', 'Wireless', '1.12', 80]);
  assert.deepEqual([s.dpiStages, s.activeDpiStage, s.pollingRateHz, s.sleepTimeout, s.ui.dpiStageEditor.maxDpi], [[400, 800, 1600, 3200], 2, 1000, 300, 35000]);
  assert.deepEqual(s.supportedPollingRates, [125, 500, 1000, 2000, 4000, 8000]);
  assert.ok(R.knownStatus(s));
  const desired = structuredClone(s);
  Object.assign(desired, { dpiStages: [400, 900, 1600, 3200], activeDpiStage: 1, pollingRateHz: 4000, sleepTimeout: 600 });
  const back = await R.saveChanges(client, s, desired);
  assert.deepEqual([back.dpiStages, back.activeDpiStage, back.pollingRateHz, back.sleepTimeout], [[400, 900, 1600, 3200], 1, 4000, 600]);
  assert.deepEqual(dev.stages[1], [900, 1000]);
  assert.deepEqual(dev.dpi, [900, 1000]); // 현재 DPI도 고른 단계로 맞춘다
  // 고속 보고율은 0x40으로 쓰고, 이 기종은 같은 값을 확정 명령(첫 인자 1)으로 한 번 더 보낸다
  const rateWrites = dev.sent.filter((p) => p[6] === 0 && p[7] === 0x40).map((p) => [p[1], p[8], p[9]]);
  assert.deepEqual(rateWrites, [[0x1f, 0, 2], [0x1f, 1, 2]]);
});

test('Razer wired legacy polling, unknown models and a browser that blocks the control channel', async () => {
  const wired = new MockRazer({ productId: 0x0084, productName: 'Razer DeathAdder V2', tid: 0x3f });
  const client = R.createClient([wired]);
  const s = await client.readStatus();
  assert.deepEqual([s.name, s.connectionType, s.batteryPercent, s.sleepTimeout, s.supportedPollingRates], ['Razer DeathAdder V2', 'Wired', null, null, [125, 500, 1000]]);
  assert.equal(wired.sent.find((p) => p[7] === 0x86)[8], 0); // 이 기종은 저장 위치 0번으로 읽는다
  const desired = { ...structuredClone(s), pollingRateHz: 500 };
  await R.saveChanges(client, s, desired);
  assert.equal(wired.rateDivisor1k, 2);

  assert.throws(() => R.createClient([new MockRazer({ productId: 0x0091, productName: 'Razer Viper 8KHz' })]), /아직 지원하지 않는 Razer 기종입니다 \(1532:0091\)/);
  const blocked = R.createClient([new MockRazer({ blocked: true })]);
  await assert.rejects(blocked.readStatus(), /Chrome·Edge 153 이상은 Windows에서 이 채널을 막고 있어/);
});
