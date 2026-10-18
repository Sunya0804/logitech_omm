// 가상 기기로 화면 전체를 시험한다. 사용: npm run test:browser
// Chrome 경로는 CHROME_PATH로 바꿀 수 있다(기본: 설치된 Chrome). SCREENSHOT_DIR을 주면 화면을 저장한다.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = process.argv[2] ? await import(pathToFileURL(path.resolve(process.argv[2]))) : await import('playwright-core');
const chromePath = process.argv[3] || process.env.CHROME_PATH;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep) && file !== root) throw new Error('outside root');
    const target = file === root ? path.join(root, 'index.html') : file;
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(target)] || 'text/plain');
    res.end(await fs.readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(chromePath ? { executablePath: chromePath, headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'ko-KR' });
  const shot = async (name) => { if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, name), fullPage: true }); };
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => !!window.OMM?.mchoseUi);
  await page.evaluate(async () => {
    const { CapturedMouse } = await import('/tests/mchose-fixture.mjs');
    window.captures = await (await fetch('/tests/fixtures/mchose-hardware.json')).json();
    window.makeMouse = i => new CapturedMouse(window.captures[i]);
    const timer = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => timer(fn, ms >= 8000 ? ms : Math.min(ms, 5), ...args);
    // 알림은 줄인 setTimeout 때문에 곧바로 사라지므로 나타날 때마다 기록해 둔다.
    window.toastLog = [];
    new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => toastLog.push(n.textContent))))
      .observe(document.querySelector('#toasts'), { childList: true });
    window.mockMouse = window.makeMouse(0);
    await OMM.connectMchose([window.mockMouse]);
  });
  assert.equal(await page.locator('#editor h2').textContent(), 'MCHOSE K7 Ultra');
  // 배터리만 다시 읽어도 설정은 바뀌지 않는다.
  await page.evaluate(() => OMM.pollBattery());
  assert.equal(await page.evaluate(() => [OMM.mchoseUi.isDirty(), mockMouse.writes.length].join()), 'false,0');
  await page.getByRole('tab', { name: '성능', exact: true }).click();
  assert.equal(await page.locator('#editor input[type=number]').first().isDisabled(), true);
  await page.locator('.mchose-unlock input').check();
  await page.locator('#editor input[type=number]').first().fill('900');
  await page.locator('#editor input[type=number]').first().blur();
  assert.equal(await page.evaluate(() => mockMouse.writes.length), 0);
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.mchoseUi.isDirty());
  assert.doesNotMatch(await page.locator('#editor').textContent(), /undefined|falsefalse/);
  assert.equal(await page.evaluate(() => OMM.mchoseUi.state.original.dpiStages[0]), 900);
  await shot('mchose-ui.png');
  await page.evaluate(async () => { window.previousMouse = mockMouse; window.mockMouse = makeMouse(1); await OMM.connectMchose([mockMouse]); });
  assert.equal(await page.evaluate(() => previousMouse.opened), false);
  assert.equal(await page.locator('#editor h2').textContent(), 'MCHOSE A7 V2 Ultra+');
  assert.equal(await page.evaluate(() => OMM.mchoseUi.state.original.pollingRateHz), 4000);
  await page.evaluate(async () => { const { MockTransport } = await import('/js/mock.js'); await OMM.connect(new MockTransport()); });
  assert.equal(await page.evaluate(() => OMM.mchoseUi.connected()), false);
  assert.equal(await page.evaluate(() => OMM.pollBattery()), true);
  assert.equal(await page.locator('#btn-export').isVisible(), true);

  // Logitech 매크로: 기존 매크로 표시, 녹화로 이어 붙이기, 빈 섹터에 기록하고 버튼이 그 섹터를 가리키는지
  await page.evaluate(async () => { const { MockTransport } = await import('/js/mock.js'); window.lt = new MockTransport('classic'); await OMM.connect(lt); });
  await page.getByRole('tab', { name: '버튼', exact: true }).click();
  const macroRow = page.locator('table.buttons tbody tr').nth(10);
  assert.match(await macroRow.locator('.btn-desc').innerText(), /매크로: Ctrl → C/);
  await macroRow.getByRole('button', { name: '매크로 편집' }).click();
  assert.equal(await page.locator('.macro-steps li').count(), 5);
  await page.locator('#macro-record').click();
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  assert.match(await page.locator('#macro-record').innerText(), /녹화 중지 \(4\)/);
  await page.locator('#macro-record').click();
  const steps = await page.evaluate(() => [...document.querySelectorAll('.macro-steps li')].map((li) => li.textContent));
  assert.ok(steps.some((s) => /↓ Shift/.test(s)) && steps.some((s) => /↑ A/.test(s)), steps.join(' | '));
  await shot('logitech-macro.png');
  assert.equal(await page.evaluate(() => OMM.logitech.isDirty()), true);
  // 다른 버튼을 빈 매크로로 바꾸면 저장을 막는다
  await page.locator('table.buttons tbody tr').nth(9).locator('select').first().selectOption('macro');
  await page.locator('#btn-save').click();
  assert.match(await page.evaluate(() => toastLog.join(' ')), /비어 있는 매크로/);
  await page.locator('table.buttons tbody tr').nth(9).locator('select').first().selectOption('disabled');
  await page.locator('#btn-save').click();
  assert.match(await page.locator('#confirm-body').innerText(), /실제 기기로 확인하지 않은/);
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.logitech.isDirty());
  const saved = await page.evaluate(async () => {
    const M = await import('/js/macro.js');
    const P = await import('/js/profile.js');
    const read = (n) => lt.sectors.get(n) ?? null;
    const binding = [...P.getBinding(lt.sectors.get(1), P.LAYOUTS.classic, 'buttons', 10)];
    return { binding, macro: M.readMacro(read, M.macroTarget(binding), 255), oldKept: M.readMacro(read, { sector: 5, offset: 0 }, 255).steps.length,
      button10: [...P.getBinding(lt.sectors.get(1), P.LAYOUTS.classic, 'buttons', 9)] };
  });
  assert.deepEqual(saved.binding, [0x00, 4, 0x00, 0x00]);
  assert.equal(saved.macro.error, null);
  assert.deepEqual(saved.macro.steps.slice(0, 5).map((s) => s.kind), ['key', 'key', 'delay', 'key', 'key']);
  assert.ok(saved.macro.steps.some((s) => s.kind === 'key' && s.down && s.usage === 0x04));
  assert.equal(saved.oldKept, 5);
  assert.deepEqual(saved.button10, [0xff, 0xff, 0xff, 0xff]);
  assert.match(await macroRow.locator('.btn-desc').innerText(), /Shift → A/);
  assert.doesNotMatch(await macroRow.locator('.btn-desc').innerText(), /저장 전/);
  // 백업에는 매크로 단계가 들어가고, 불러오면 저장 전 편집본이 된다(같은 내용이면 편집본을 만들지 않는다)
  const backup = await page.evaluate(async () => {
    let captured;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return orig.call(URL, blob); };
    OMM.logitech.exportBackup();
    URL.createObjectURL = orig;
    return JSON.parse(await captured.text());
  });
  assert.deepEqual(backup.macros.map((m) => [m.index, m.layer, m.button]), [[0, 'buttons', 10]]);
  await page.evaluate(async (b) => { await OMM.logitech.importBackup(new File([JSON.stringify(b)], 'b.json')); }, backup);
  assert.equal(await page.evaluate(() => OMM.logitech.isDirty()), false);
  await page.evaluate(async () => { ({ MockCompxDevice: window.MockCompxDevice } = await import('/js/mock-compx.js')); await OMM.connectCompx([new MockCompxDevice()]); });
  assert.equal(await page.evaluate(() => OMM.compxUi.connected()), true);
  assert.equal(await page.locator('#sidebar .profile').count(), 4);
  // 배터리 갱신: 깨어 있으면 새 값을 보이고, 절전 중이면 깨우지 않고 직전 값을 두며, 다른 작업 중에는 묻지 않는다.
  const batteryChip = () => page.locator('#device .chip[title="배터리"]').textContent();
  await page.evaluate(async () => { window.vgn = new MockCompxDevice(); await OMM.connectCompx([vgn]); vgn.battery = 60; });
  assert.match(await batteryChip(), /75%/);
  assert.equal(await page.evaluate(() => OMM.pollBattery()), true);
  assert.match(await batteryChip(), /60%/);
  await page.evaluate(() => { vgn.awake = false; vgn.battery = 40; });
  assert.equal(await page.evaluate(() => OMM.pollBattery()), false);
  assert.match(await batteryChip(), /60%/);
  assert.equal(await page.evaluate(() => vgn.online), false);
  await page.evaluate(() => { vgn.awake = true; OMM.state.busy = true; });
  assert.equal(await page.evaluate(() => OMM.pollBattery()), false);
  await page.evaluate(() => { OMM.state.busy = false; });
  assert.match(await batteryChip(), /60%/);
  await page.evaluate(async () => {
    window.atk = new MockCompxDevice({ vendorId: OMM.compx.VENDOR_ATK, productName: 'ATK X1 Pro Max', cid: 2, mid: 39 });
    await OMM.connectCompx([atk]);
  });
  assert.equal(await page.locator('#sidebar .profile').count(), 4);
  await page.locator('#sidebar .profile').nth(3).click();
  await page.waitForFunction(() => !OMM.state.busy && OMM.compxUi.state.extras.profile === 3);
  assert.equal(await page.evaluate(() => atk.profile), 3);
  assert.match(await page.locator('#sidebar .selected').innerText(), /프로필 4/);
  assert.equal(await page.evaluate(() => atk.writes.length), 0);
  await shot('atk-profiles.png');
  await page.evaluate(() => { OMM.compx.setScalar(OMM.compxUi.state.work, OMM.compx.FLASH.debounce, 8); OMM.ui.refresh(); });
  await page.locator('#sidebar .profile').first().click();
  await page.locator('#confirm button[value=cancel]').click();
  assert.equal(await page.evaluate(() => atk.profile), 3);
  assert.equal(await page.evaluate(() => OMM.compxUi.isDirty()), true);
  await page.evaluate(() => { OMM.compxUi.revert(); atk._originalHandle = atk._handle; atk._handle = function(p, r) { if (p[0] !== 0x0f) this._originalHandle(p, r); }; });
  await page.locator('#sidebar .profile').first().click();
  await page.waitForFunction(() => !OMM.state.busy);
  assert.equal(await page.evaluate(() => OMM.compxUi.state.extras.profile), 3);
  assert.match(await page.locator('#toasts').textContent(), /프로필 전환을 확인하지 않았습니다/);
  await page.evaluate(() => document.querySelector('#toasts').replaceChildren());

  await page.evaluate(async () => {
    const c = OMM.compx;
    window.a9 = new MockCompxDevice({ vendorId: c.VENDOR_ATK, productName: 'ATK A9 Ultra', cid: 2, mid: 87 });
    const model = c.modelFor(c.VENDOR_ATK, 2, 87);
    for (const bank of a9.banks) [400,800,1600,3200].forEach((dpi, i) => c.setDpi(bank, i, dpi, model));
    await OMM.connectCompx([a9]);
  });
  assert.equal(await page.locator('#editor h2').textContent(), 'ATK A9 Ultra');
  assert.equal(await page.locator('#editor .notice').count(), 0);
  await page.getByRole('tab', { name: '성능', exact: true }).click();
  assert.equal(await page.locator('#editor input[type=number]').first().isEnabled(), true);
  assert.equal(await page.evaluate(() => a9.writes.length), 0);
  assert.equal(await page.evaluate(() => OMM.compx.modelFor(OMM.compx.VENDOR_ATK, 1, 2).verified), false);
  await shot('a9-confirmed-ui.png');

  // ATK 매크로: 기존 매크로 표시, 녹화로 이어 붙이기, 반복 방식, 매크로를 먼저 기록한 뒤 버튼을 기록하는지
  await page.evaluate(async () => {
    const c = OMM.compx;
    window.a9m = new MockCompxDevice({ vendorId: c.VENDOR_ATK, productName: 'ATK A9 Ultra', cid: 2, mid: 87 }, { macro: true });
    const model = c.modelFor(c.VENDOR_ATK, 2, 87);
    for (const bank of a9m.banks) [400,800,1600,3200].forEach((dpi, i) => c.setDpi(bank, i, dpi, model));
    await OMM.connectCompx([a9m]);
    toastLog.length = 0;
  });
  await page.getByRole('tab', { name: '버튼', exact: true }).click();
  const atkRow = page.locator('table.buttons tbody tr').nth(4);
  assert.match(await atkRow.locator('.btn-desc').innerText(), /M1 · 매크로: Ctrl → C/);
  await atkRow.getByRole('button', { name: '매크로 편집' }).click();
  assert.equal(await page.locator('.macro-steps li').count(), 5);
  await page.locator('#macro-record').click();
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Shift');
  await page.locator('#macro-record').click();
  assert.match(await atkRow.locator('.btn-desc').innerText(), /Shift → A.*저장 전/);
  await page.getByRole('combobox', { name: '앞으로 매크로 반복 방식' }).selectOption('254');
  // 다른 버튼을 빈 매크로로 바꾸면 빈 칸(M2)을 쓰고, 비어 있으면 저장을 막는다
  await page.locator('table.buttons tbody tr').nth(3).locator('select').selectOption('macro');
  assert.match(await page.locator('table.buttons tbody tr').nth(3).locator('.btn-desc').innerText(), /^M2 /);
  await page.locator('#btn-save').click();
  assert.match(await page.evaluate(() => toastLog.join(' ')), /비어 있는 매크로/);
  await page.locator('table.buttons tbody tr').nth(3).locator('select').selectOption('3');
  await shot('atk-macro.png');
  await page.locator('#btn-save').click();
  assert.match(await page.locator('#confirm-body').innerText(), /실제 기기로 확인하지 않은/);
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.compxUi.isDirty());
  const atkSaved = await page.evaluate(async () => {
    const X = await import('/js/compx-macro.js');
    const c = OMM.compx;
    const slot = (n) => X.decodeSlot(a9m.flash.subarray(X.slotAddress(n) + X.COUNT_OFFSET, X.slotAddress(n) + 384));
    const order = a9m.writes.map(([address]) => address);
    return {
      key: c.decodeKey(a9m.flash, 4), back: c.decodeKey(a9m.flash, 3), m1: slot(0), m2empty: slot(1).empty,
      macroFirst: order.indexOf(X.slotAddress(0)) >= 0 && order.indexOf(X.slotAddress(0)) < order.findIndex((a) => a >= c.FLASH.keys && a < c.FLASH.keys + 24),
    };
  });
  assert.deepEqual(atkSaved.key, { cls: 6, param: 0x00fe });
  assert.deepEqual(atkSaved.back, { cls: 1, param: 0x0800 });
  assert.equal(atkSaved.m1.error, null);
  assert.ok(atkSaved.m1.steps.some((s) => s.kind === 'key' && s.down && s.usage === 0x04));
  assert.equal(atkSaved.m1.steps.filter((s) => s.kind === 'key').length, 8);
  assert.equal(atkSaved.m2empty, true);
  assert.equal(atkSaved.macroFirst, true);
  assert.doesNotMatch(await atkRow.locator('.btn-desc').innerText(), /저장 전/);
  // 백업에는 버튼에 걸린 매크로가 들어가고, 같은 내용을 불러오면 바뀐 것이 없다
  const atkBackup = await page.evaluate(async () => {
    let captured;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return orig.call(URL, blob); };
    OMM.compxUi.exportBackup();
    URL.createObjectURL = orig;
    return JSON.parse(await captured.text());
  });
  assert.deepEqual(atkBackup.macros.map((m) => m.slot), [0]);
  await page.evaluate(async (b) => { await OMM.compxUi.importBackup(new File([JSON.stringify(b)], 'b.json')); }, atkBackup);
  assert.equal(await page.evaluate(() => OMM.compxUi.isDirty()), false);
  await page.evaluate(async () => {
    window.mockMouse = makeMouse(0); mockMouse.profileNames = ['내 설정', '默认板载2', 'Profile 3'];
    await OMM.connectMchose([mockMouse]);
  });
  assert.equal(await page.locator('#sidebar .profile-name').first().textContent(), '내 설정');
  assert.equal(await page.locator('#sidebar .profile-name').nth(1).textContent(), '프로필 2');
  await page.locator('.mchose-unlock input').check();
  await page.locator('#sidebar .profile').nth(1).click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && OMM.mchoseUi.state.original.activeProfile === 2);
  assert.match(await page.locator('#sidebar .selected').innerText(), /프로필 2/);
  await page.getByRole('tab', { name: '성능', exact: true }).click();
  await shot('gomm-mchose-performance.png');
  await page.getByRole('tab', { name: '버튼', exact: true }).click();
  assert.equal(await page.locator('table.buttons select').count() > 0, true);
  await page.getByRole('tab', { name: '고급', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '기기 설정 다시 읽기' }).isVisible(), true);
  assert.equal(await page.locator('#editor a[href*=NOTICE]').count(), 0);
  await page.locator('#views [data-view=home]').click();
  assert.equal(await page.locator('.device-photo').getAttribute('alt'), 'MCHOSE K7 Ultra 공식 제품 사진');
  await page.locator('.device-photo').evaluate(img => img.decode());
  assert.equal(await page.locator('.device-photo-credit').count(), 0);
  const alpha = await page.locator('.device-photo').evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  });
  assert.equal(alpha, 0);
  await shot('gomm-device-home.png');
  await page.locator('.device-photo').dispatchEvent('error');
  assert.equal(await page.locator('.device-art-wrap svg').count(), 1);
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#views [data-view=config]').click();
  await page.getByRole('tab', { name: '성능', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot('gomm-mobile.png');
  await page.setViewportSize({ width: 1280, height: 1000 });

  // 데모: 가상 기기로 연결하고, 실제 기기 연결 경로와 같은 화면이 뜨는지
  await page.locator('#btn-disconnect').click();
  await page.locator('#views [data-view=home]').click();
  assert.equal(await page.locator('#demo-banner').isVisible(), false);
  for (const [kind, name] of [['logitech', 'GOMM Demo Mouse S'], ['atk', 'ATK A9 Ultra'], ['mchose', 'MCHOSE K7 Ultra'], ['vgn', 'VGN Demo Mouse']]) {
    if (await page.locator('#btn-disconnect').isVisible()) await page.locator('#btn-disconnect').click();
    await page.locator('#views [data-view=home]').click();
    await page.locator(`[data-demo=${kind}]`).click();
    await page.waitForFunction(() => !OMM.state.busy && OMM.state.demo);
    assert.match(await page.locator('#device').innerText(), new RegExp(`데모[\\s\\S]*${name.replace('+', '\\+')}`));
    assert.equal(await page.locator('#demo-banner').isVisible(), true);
  }

  // VGN 백업: 내보낸 뒤 기기 값을 바꿔 저장하고, 백업을 불러와 저장하면 원래 값으로 돌아오는지
  const exportFile = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export').click()]);
    return dl.path();
  };
  const saveNow = async () => {
    await page.locator('#btn-save').click();
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => !OMM.state.busy);
  };
  await page.locator('#views [data-view=config]').click();
  assert.equal(await page.locator('#btn-export').isVisible(), true);
  const vgnBackup = await exportFile();
  const vgnFirst = await page.evaluate(() => OMM.compx.parse(OMM.compxUi.state.orig).stages[0]);
  await page.evaluate(() => { const ui = OMM.compxUi; OMM.compx.setDpi(ui.state.work, 0, 1250); OMM.compx.setScalar(ui.state.work, OMM.compx.FLASH.debounce, 9); OMM.ui.refresh(); });
  await saveNow();
  assert.equal(await page.evaluate(() => OMM.compx.parse(OMM.compxUi.state.dev.dev.flash).stages[0]), 1250);
  await page.locator('#import-file').setInputFiles(vgnBackup);
  await page.waitForFunction(() => OMM.compxUi.isDirty());
  await saveNow();
  assert.deepEqual(await page.evaluate(() => { const m = OMM.compx.parse(OMM.compxUi.state.dev.dev.flash); return [m.stages[0], m.debounce]; }), [vgnFirst, 4]);
  // 다른 기종의 백업은 거부한다
  const vgnText = JSON.parse(await fs.readFile(vgnBackup, 'utf8'));
  await page.locator('#import-file').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...vgnText, mid: 99 })) });
  await page.waitForFunction(() => /맞지 않는 백업/.test(document.querySelector('#toasts').textContent));
  assert.equal(await page.evaluate(() => OMM.compxUi.isDirty()), false);

  // MCHOSE 백업: 편집 허용 전에는 불러오기가 막히고, 맞지 않는 값은 빼고 불러온다
  await page.locator('#btn-disconnect').click();
  await page.locator('#views [data-view=home]').click();
  await page.locator('[data-demo=mchose]').click();
  await page.waitForFunction(() => !OMM.state.busy && OMM.mchoseUi.connected());
  await page.locator('#views [data-view=config]').click();
  assert.equal(await page.locator('#btn-import').isDisabled(), true);
  await page.locator('.mchose-unlock input').check();
  const mchoseBackup = await exportFile();
  const mchoseText = JSON.parse(await fs.readFile(mchoseBackup, 'utf8'));
  assert.equal(mchoseText.type, 'gomm-mchose-backup');
  const altered = { ...mchoseText, settings: { ...mchoseText.settings, dpiStages: mchoseText.settings.dpiStages.map((d, i) => (i ? d : 1200)), pollingRateHz: 12345,
    buttonMappings: { ...mchoseText.settings.buttonMappings, Left: '오른쪽 클릭' } } };
  await page.locator('#import-file').setInputFiles({ name: 'm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(altered)) });
  await page.waitForFunction(() => OMM.mchoseUi.isDirty());
  assert.match(await page.evaluate(() => toastLog.join('\n')), /뺀 항목: 보고율/);
  assert.deepEqual(await page.evaluate(() => [OMM.mchoseUi.state.work.dpiStages[0], OMM.mchoseUi.state.work.buttonMappings.Left]), [1200, mchoseText.settings.buttonMappings.Left]);
  await saveNow();
  assert.equal(await page.evaluate(() => OMM.mchoseUi.state.original.dpiStages[0]), 1200);

  // DPI·각도 측정 계산: 10 cm에 1,600 DPI 마우스면 6,299 카운트, 오른쪽이 1° 올라가면 +1°
  const measured = await page.evaluate(() => {
    const counts = 1600 * 10 / 2.54, rad = Math.PI / 180;
    return [OMM.tester.measureResult(counts * Math.cos(rad), -counts * Math.sin(rad), 10), OMM.tester.measureResult(-counts * Math.cos(rad), counts * Math.sin(rad), 10)];
  });
  for (const r of measured) { assert.equal(Math.round(r.dpi), 1600); assert.equal(r.angle.toFixed(3), '1.000'); }
  await page.locator('#views [data-view=test]').click();
  assert.match(await page.locator('.measure-area').innerText(), /측정 시작/);

  // 영어: 화면 문구가 모두 번역되는지 (한글이 남아 있으면 번역표에 빠진 문구가 있다)
  await page.evaluate(() => OMM.setLang('en'));
  const hangul = /[가-힣]/;
  assert.doesNotMatch(await page.locator('#tester').innerText(), hangul);
  await page.locator('#views [data-view=home]').click();
  await page.locator('#btn-disconnect').click();
  // 언어 선택 상자의 「한국어」는 그 언어 이름이라 그대로 둔다.
  assert.doesNotMatch((await page.locator('#rail').innerText() + await page.locator('#welcome').innerText()).replace(/한국어/g, ''), hangul);
  for (const kind of ['logitech', 'vgn', 'atk', 'mchose']) {
    if (await page.locator('#btn-disconnect').isVisible()) await page.locator('#btn-disconnect').click();
    await page.locator('#views [data-view=home]').click();
    await page.locator(`[data-demo=${kind}]`).click();
    await page.waitForFunction(() => !OMM.state.busy && OMM.state.demo);
    for (const tab of await page.getByRole('tab').all()) {
      await tab.click();
      const text = await page.locator('#stage').innerText();
      // 사용자가 붙인 프로필 이름(재생한 실기기 데이터)은 번역 대상이 아니다.
      assert.doesNotMatch(text.replace(/내 설정/g, ''), hangul, `${kind} / ${await tab.innerText()}`);
    }
  }
  await shot('gomm-english.png');
  await page.evaluate(() => OMM.setLang('ko'));
  assert.deepEqual(errors, []);
  console.log('Browser: ATK profiles, rejection and dirty cancel; MCHOSE UTF-8 names, tabs, staged save; official image/fallback, mobile, Logitech/VGN regressions; demo devices, VGN/MCHOSE backup round-trip, DPI/angle math and full English UI passed.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
