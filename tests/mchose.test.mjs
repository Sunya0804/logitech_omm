import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CapturedMouse } from './mchose-fixture.mjs';
import { catalog, createClient, saveChanges, changes, knownStatus, profileNameFrom } from '../js/mchose.js';
import { V3_PIDS } from '../js/mchose-models.js';
import { setLang } from '../js/i18n.js';
// 오류 문구를 한국어 원문으로 확인하므로, 영어 환경(CI)에서도 화면 언어를 한국어로 고정한다.
setLang('ko');
const captures = JSON.parse(fs.readFileSync(new URL('./fixtures/mchose-hardware.json', import.meta.url)));
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, Math.min(ms, 1), ...args);

for (const capture of captures) {
  test(`${capture.product_string}: captured packets, staged writes, unrelated bytes preserved`, async () => {
    const dev = new CapturedMouse(capture), client = createClient([dev]);
    const before = await client.readStatus();
    assert.equal(before.dpi, 1600);
    assert.equal(before.pollingRateHz, capture.product_id === 0x1001 ? 1000 : 4000);
    assert.equal(before.ui.settingsReady, true);
    assert.equal(knownStatus(before), true);
    assert.equal(before.dpiStages.length, 4);
    assert.equal(dev.writes.length, 0);
    const desired = structuredClone(before);
    desired.dpiStages[0] = 900;
    desired.debounceMs = 6;
    desired.pollingRateHz = 500;
    const original = dev.reads[0x67].slice();
    assert.equal(dev.writes.length, 0);
    const after = await saveChanges(client, before, desired);
    assert.equal(after.dpiStages[0], 900);
    assert.equal(after.debounceMs, 6);
    assert.equal(after.pollingRateHz, 500);
    assert.deepEqual(dev.reads[0x67].slice(20, 50), original.slice(20, 50));
    await client.close(); assert.equal(dev.opened, false);
  });
}
test('external profile/config change aborts before writing', async () => {
  const dev = new CapturedMouse(captures[0]), client = createClient([dev]);
  const before = await client.readStatus(), desired = structuredClone(before); desired.debounceMs = 4;
  dev.reads[0x67][0] = 1;
  await assert.rejects(saveChanges(client, before, desired), /외부/);
  assert.equal(dev.writes.length, 0);
});
test('rejected write cannot be reported as saved', async () => {
  const dev = new CapturedMouse(captures[0]), client = createClient([dev]);
  const before = await client.readStatus(), desired = structuredClone(before); desired.debounceMs = 4;
  dev.rejectWrites = true;
  await assert.rejects(saveChanges(client, before, desired));
});
test('unknown model and invalid active stage cannot unlock settings', async () => {
  const dev = new CapturedMouse(captures[0]); dev.productName = 'MCHOSE A7 Future';
  assert.equal((await createClient([dev]).readStatus()).ui.settingsReady, false);
  const invalid = new CapturedMouse(captures[0]); invalid.reads[0x67][2] = 0x2f;
  assert.equal((await createClient([invalid]).readStatus()).ui.settingsReady, false);
});
test('left button cannot be staged for reassignment', () => {
  const before = { buttonMappings: { Left: 'Default' } }, after = { buttonMappings: { Left: 'Disabled' } };
  assert.throws(() => changes(before, after), /왼쪽/);
});
test('V3 USB IDs route to V3; firmware, dock and unrelated vendor are rejected', () => {
  for (const productId of V3_PIDS) {
    const dev = new CapturedMouse(captures[0]); dev.productId = productId;
    assert.equal(createClient([dev]).family, 'V3');
  }
  for (const mutate of [d => { d.productId = 0x1012; }, d => { d.vendorId = 0x046d; }, d => { d.collections[0].usagePage = 0xff0b; }]) {
    const dev = new CapturedMouse(captures[0]); mutate(dev);
    assert.throws(() => createClient([dev]), /인터페이스/);
  }
  assert.equal(catalog.length, 40);
});

test('profile names decode UTF-8 and reject invalid data', () => {
  for (const text of ['내 설정', '默认板载2', 'Config 1', 'FPS 🎯']) {
    const payload = Uint8Array.from([0, ...new TextEncoder().encode(text), 0, 255]);
    assert.equal(profileNameFrom(payload), text);
  }
  assert.equal(profileNameFrom(Uint8Array.from([0, 0xff, 0])), null);
  assert.equal(profileNameFrom(Uint8Array.from([0, 0])), null);
  assert.equal(profileNameFrom(Uint8Array.from([0, 65, 1, 0])), null);
});

test('a missing profile name preserves names in the other slots', async () => {
  const dev = new CapturedMouse(captures[0]);
  dev.profileNames = ['내 설정', '', '작업용'];
  const status = await createClient([dev]).readStatus();
  assert.deepEqual(status.profileNames, ['내 설정', '', '작업용']);
});
