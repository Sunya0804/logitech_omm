import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../js/wlmouse.js';
import { MockWLMouse } from '../js/mock-wlmouse.js';

test('WLMouse frames: request layout, shifted replies, unsupported and busy answers', () => {
  const p = W.encodeRequest(2, 1, 0x81, [1, 6]);
  assert.deepEqual([...p.slice(0, 8)], [0, 0, 2, 2, 1, 0x81, 1, 6]);
  assert.equal(p.length, 64);
  const reply = new Uint8Array(64); reply.set([0xa1, 0, 2, 3, 1, 0x80, 1, 0x01, 9]);
  assert.deepEqual([...W.decodeReply(reply, 1, 0x80)], [1, 0x01, 9]);
  const shifted = Uint8Array.from([0, ...reply.slice(0, 63)]);
  assert.deepEqual([...W.decodeReply(shifted, 1, 0x80)], [1, 0x01, 9]);
  assert.equal(W.decodeReply(reply, 1, 0x81), null); // 다른 명령의 답
  reply[0] = 0xa3; assert.equal(W.decodeReply(reply, 1, 0x80), null); // 처리 중
  reply[0] = 0xa2; assert.throws(() => W.decodeReply(reply, 1, 0x80));
  assert.deepEqual(W.decodeStages([1, 2, 0x01, 0x90, 0x01, 0x90, 0x03, 0x20, 0x06, 0x40]), [{ x: 400, y: 400 }, { x: 800, y: 1600 }]);
  assert.deepEqual([0x87, 0x01, 0x02, 0x8f, 3, 0].map(W.decodeLiftOff), ['0.7 mm', '1 mm', '2 mm', '1.5 mm', '3 mm', null]);
});

test('WLMouse driver reads status, hides unsupported settings and names the mouse behind the 1K receiver', async () => {
  const dev = new MockWLMouse({ unsupported: ['1:147', '1:148'] }); // 터보 모드(0x93)·센서 각도(0x94)가 없는 기종
  const client = W.createClient([dev]);
  const s = await client.readStatus();
  assert.equal(s.name, 'WLMouse Beast X');
  assert.deepEqual([s.dpiStages, s.activeDpiStage, s.dpi, s.pollingRateHz, s.liftOffDistance], [[400, 800, 1600, 3200], 2, 1600, 1000, '1 mm']);
  assert.deepEqual([s.motionSync, s.angleSnapping, s.turboMode, s.angleTuning, s.debounceMs, s.sleepTimeout], [true, false, null, null, 4, 120]);
  assert.deepEqual([s.batteryPercent, s.firmware], [87, ['마우스 1.2', '수신기 3.4']]);
  assert.ok(W.knownStatus(s));
  assert.equal(s.ui.statusNote, null); // Beast X는 OpenMouse가 실기기로 확인한 기종

  const receiver = new MockWLMouse({ productId: 0xa882, productName: 'WLmouse 1K receiver', pairedId: 0xa866, shifted: true });
  const r = await W.createClient([receiver]).readStatus();
  assert.equal(r.name, 'WLMouse Beast Miao');
  assert.deepEqual(r.supportedPollingRates, [125, 250, 500, 1000]); // 1K 수신기
  assert.match(r.ui.statusNote, /실기기로 확인된 적이 없습니다/);
  const lonely = new MockWLMouse({ productId: 0xa882, productName: 'WLmouse 1K receiver', pairedId: 0x1234 });
  assert.equal(W.knownStatus(await W.createClient([lonely]).readStatus()), false); // 짝 마우스를 모르면 읽기 전용

  assert.throws(() => W.createClient([new MockWLMouse({ productId: 0xa887 })]), /Beast X 4K/);
  const noConfig = new MockWLMouse(); noConfig.collections = [{ usagePage: 1, usage: 2, children: [], inputReports: [], outputReports: [], featureReports: [] }];
  assert.throws(() => W.createClient([noConfig]), /기능 보고서 0번/);
});

test('WLMouse save writes only the changed settings, keeps a separate Y DPI and verifies by reading back', async () => {
  const dev = new MockWLMouse();
  dev.settings.stages[1] = [800, 1200]; // 2단계는 세로 DPI가 따로 설정돼 있다
  const client = W.createClient([dev]);
  const before = await client.readStatus();
  const desired = structuredClone(before);
  Object.assign(desired, { pollingRateHz: 4000, liftOffDistance: '0.7 mm', motionSync: false, debounceMs: 8, sleepTimeout: 300, activeDpiStage: 0, angleTuning: -5 });
  desired.dpiStages = [500, 900, 1600, 3200];
  assert.deepEqual(W.changes(before, desired).sort(), ['activeDpiStage', 'debounceMs', 'dpiStages.0', 'dpiStages.1', 'liftOffDistance', 'motionSync', 'pollingRateHz', 'sleepTimeout', 'angleTuning'].sort());
  const after = await W.saveChanges(client, before, desired);
  assert.deepEqual([after.pollingRateHz, after.liftOffDistance, after.motionSync, after.debounceMs, after.sleepTimeout, after.activeDpiStage, after.angleTuning],
    [4000, '0.7 mm', false, 8, 300, 0, -5]);
  assert.deepEqual(dev.settings.stages, [[500, 500], [900, 1200], [1600, 1600], [3200, 3200]]);
  assert.equal(dev.writes.filter(([page, command]) => page === 1 && command === 0x01).length, 1); // DPI 표는 한 번만 쓴다
  assert.ok(!dev.writes.some(([page, command]) => page === 1 && command === 0x04)); // 바꾸지 않은 각도 스냅은 쓰지 않는다

  // 외부(제조사 프로그램)에서 값이 바뀌었으면 쓰지 않는다
  const stale = structuredClone(after); stale.pollingRateHz = 1000;
  dev.settings.rate = 0x02;
  const count = dev.writes.length;
  await assert.rejects(W.saveChanges(client, after, stale), /외부에서 바뀌었습니다/);
  assert.equal(dev.writes.length, count);
});
