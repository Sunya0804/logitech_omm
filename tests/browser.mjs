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
    const { CapturedMouse } = await import('/js/mock-mchose.js');
    window.captures = await (await fetch('/js/mock-mchose.json')).json();
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

  // 공장 상태의 형식 6 마우스(PRO X 2 진단 정보, 이슈 #1): CRC 없는 ROM 프로필을 보여 주고,
  // 사용자가 허용하면 첫 저장으로 CRC가 붙은 사용자 프로필과 프로필 목록을 만든다.
  await page.evaluate(async () => { const { MockTransport } = await import('/js/mock.js'); window.factory = new MockTransport('factory'); await OMM.connect(factory); });
  assert.equal(await page.evaluate(() => [OMM.logitech.state.layout?.id, OMM.logitech.canEdit()].join()), 'extendedBasic,false');
  assert.equal(await page.evaluate(() => OMM.logitech.state.profiles.filter((p) => p.source === 'rom' && p.raw).length), 3);
  assert.match(await page.locator('#editor .notice').first().innerText(), /공장 상태/);
  await page.locator('#editor .notice input[type=checkbox]').check();
  assert.equal(await page.evaluate(() => OMM.logitech.canEdit()), true);
  await page.evaluate(() => { const p = OMM.logitech.state.profiles[0]; p.raw[4] = 0x58; p.raw[6] = 0x58; OMM.ui.refresh(); }); // 첫 단계 800 → 856 DPI
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.logitech.isDirty());
  assert.equal(await page.evaluate(async () => {
    const P = await import('/js/profile.js');
    return [1, 2, 3, 0].map((s) => factory.sectors.has(s) && P.hasValidCrc(factory.sectors.get(s))).join() + ':' + factory.current;
  }), 'true,true,true,true:1');
  await page.evaluate(async () => { await OMM.connect(factory); });
  assert.equal(await page.evaluate(() => [OMM.logitech.state.crcTrusted, OMM.logitech.state.profiles[0].source].join()), 'true,user');

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
  // 버튼 수가 다르거나 이 기기의 DPI 범위로 읽히지 않는 백업은 받지 않는다
  const rejected = await page.evaluate(async (b) => {
    const P = await import('/js/profile.js');
    const L = OMM.logitech.state.layout;
    const raw = P.fromHex(b.profiles[0].data);
    raw.set([0xf0, 0xff], L.dpi); // 첫 DPI 단계를 65,520으로
    const bad = { ...b, profiles: [{ ...b.profiles[0], data: P.toHex(P.finalize(raw)) }] };
    const out = [];
    for (const f of [{ ...b, buttonCount: 99 }, bad]) {
      document.querySelector('#toasts').replaceChildren();
      await OMM.logitech.importBackup(new File([JSON.stringify(f)], 'b.json'));
      out.push(document.querySelector('#toasts').textContent);
    }
    return [...out, OMM.logitech.isDirty()];
  }, backup);
  assert.match(rejected[0], /호환되지 않는 백업/);
  assert.match(rejected[1], /쓸 수 없는 값/);
  assert.equal(rejected[2], false);
  // 지원 목록에 없는 ATK 기종: 진단 파일을 저장하면 「지원 요청」 이슈를 열지 묻고, 연결은 하지 않는다.
  await page.evaluate(async () => {
    ({ MockCompxDevice: window.MockCompxDevice } = await import('/js/mock-compx.js'));
    window.opened = []; window.realOpen = window.open; window.open = (url) => { window.opened.push(url); return null; };
    window.unknownDone = OMM.connectCompx([new MockCompxDevice({ vendorId: OMM.compx.VENDOR_ATK, productName: 'ATK Unknown', cid: 0x7e, mid: 0x7f })]);
  });
  const unknownSaved = page.waitForEvent('download');
  await page.locator('#confirm-ok').click();
  await unknownSaved;
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => window.opened.length === 1);
  const unknownIssue = new URL(await page.evaluate(() => window.opened[0]));
  assert.equal(unknownIssue.searchParams.get('title'), '[지원 요청] ATK Unknown');
  assert.match(unknownIssue.searchParams.get('body'), /기기 식별값: 126,127[\s\S]*연결 결과: ATK Unknown: 아직 지원하지 않는 기종/);
  await page.evaluate(async () => { await window.unknownDone; window.open = window.realOpen; });
  assert.equal(await page.evaluate(() => OMM.compxUi.connected()), false);
  await page.evaluate(async () => { await OMM.connectCompx([new MockCompxDevice()]); });
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
  // 편집하는 동안 마우스에서 프로필이 바뀌면 다른 프로필에 쓰지 않는다: 물어본 뒤 되돌려서 원래 프로필에 저장한다
  await page.evaluate(() => {
    atk._handle = atk._originalHandle;
    OMM.compx.setScalar(OMM.compxUi.state.work, OMM.compx.FLASH.debounce, 8); OMM.ui.refresh();
    atk.profile = 1; window.bank1 = Array.from(atk.banks[1]);
  });
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => /프로필이 4에서 2/.test(document.querySelector('#confirm-body')?.innerText || ''));
  await page.locator('#confirm button[value=cancel]').click();
  await page.waitForFunction(() => !OMM.state.busy);
  assert.equal(await page.evaluate(() => [atk.writes.length, atk.profile, OMM.compxUi.isDirty()].join()), '0,1,true');
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => /프로필이 4에서 2/.test(document.querySelector('#confirm-body')?.innerText || ''));
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.compxUi.isDirty());
  assert.equal(await page.evaluate(() => [atk.profile, atk.banks[3][OMM.compx.FLASH.debounce], atk.banks[1].every((v, i) => v === bank1[i])].join()), '3,8,true');
  // 프로필로 돌아오지 않으면 아무것도 쓰지 않는다
  await page.evaluate(() => {
    atk.writes.length = 0;
    OMM.compx.setScalar(OMM.compxUi.state.work, OMM.compx.FLASH.debounce, 4); OMM.ui.refresh();
    atk.profile = 0; atk._handle = function(p, r) { if (p[0] !== 0x0f) this._originalHandle(p, r); };
  });
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => /프로필이 4에서 1/.test(document.querySelector('#confirm-body')?.innerText || ''));
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && /돌아오지 않아 저장하지 않았습니다/.test(document.querySelector('#toasts').textContent));
  assert.equal(await page.evaluate(() => [atk.writes.length, OMM.compxUi.isDirty()].join()), '0,true');
  await page.evaluate(() => { atk._handle = atk._originalHandle; atk.profile = 3; OMM.compxUi.revert(); document.querySelector('#toasts').replaceChildren(); });

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
  // 진단 정보를 저장하면 어느 브랜드든 GitHub 이슈로 보낼지 묻고, 보내면 기기 이름과 식별 정보를 채운 이슈 작성 화면을 연다.
  const checkIssue = async (name, detail) => {
    await page.locator('#views [data-view=config]').click();
    await page.evaluate(() => { window.opened = []; window.open = (url) => { window.opened.push(url); return null; }; });
    const saved = page.waitForEvent('download');
    await page.locator('#btn-diagnostics').click();
    // Logitech은 메모리 전체를 읽기 전에 한 번 묻는다
    if (name === 'GOMM Demo Mouse S') await page.locator('#confirm-ok').click();
    await saved;
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => window.opened.length === 1);
    const url = new URL(await page.evaluate(() => window.opened[0]));
    assert.equal(url.origin + url.pathname, 'https://github.com/Sunya0804/logitech_omm/issues/new');
    assert.equal(url.searchParams.get('title'), `[진단] ${name}`);
    const body = url.searchParams.get('body');
    assert.ok(body.startsWith(`기기: ${name}\n`), body);
    assert.match(body, detail);
  };
  await page.locator('[data-demo=via]').click();
  await page.waitForFunction(() => !OMM.state.busy && OMM.state.demo);
  await checkIssue(await page.evaluate(() => OMM.viaUi.state.session.def.name), /USB ID: [0-9A-F]{4}:[0-9A-F]{4}\n프로토콜: VIA \d+/);
  const issueDetail = { logitech: /프로필 형식: /, atk: /USB ID: 373B:[0-9A-F]{4}\n기기 식별값: \d+,\d+[\s\S]*ATK HUB/, mchose: /USB ID: [0-9A-F]{4}:[0-9A-F]{4}\n제품군: [\s\S]*M HUB/, vgn: /USB ID: [0-9A-F]{4}:[0-9A-F]{4}\n기기 식별값: [\s\S]*VGN HUB/ };
  for (const [kind, name] of [['logitech', 'GOMM Demo Mouse S'], ['atk', 'ATK A9 Ultra'], ['mchose', 'MCHOSE K7 Ultra'], ['vgn', 'VGN Demo Mouse']]) {
    if (await page.locator('#btn-disconnect').isVisible()) await page.locator('#btn-disconnect').click();
    await page.locator('#views [data-view=home]').click();
    await page.locator(`[data-demo=${kind}]`).click();
    await page.waitForFunction(() => !OMM.state.busy && OMM.state.demo);
    assert.match(await page.locator('#device').innerText(), new RegExp(`데모[\\s\\S]*${name.replace('+', '\\+')}`));
    assert.equal(await page.locator('#demo-banner').isVisible(), true);
    await checkIssue(name, issueDetail[kind]);
  }

  // VGN 백업: 내보낸 뒤 기기 값을 바꿔 저장하고, 백업을 불러와 저장하면 원래 값으로 돌아오는지
  const exportFile = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-export').click()]);
    return dl.path();
  };
  const saveNow = async () => {
    await page.locator('#btn-save').click();
    await page.locator('#confirm-ok').click();
    // 확인 창은 닫힌 다음 틱에 저장을 시작하므로, busy만 보면 시작 전에 지나칠 수 있다. 변경이 비워질 때까지 기다린다.
    await page.waitForFunction(() => !OMM.state.busy && document.querySelector('#btn-save').disabled);
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

  // 리프트오프 거리(ATK Ultra 계열, 0.7~1.7 mm): 0.1 mm 단위로 직접 입력하고 ▲▼로 한 칸씩 옮긴다. 목록에 없는 값은 받지 않는다.
  // VGN처럼 낮음·중간·높음 단계로 된 기종은 버튼으로 고른다.
  assert.equal(await page.locator('[data-stepper="리프트오프 거리"]').count(), 0);
  await page.evaluate(async () => {
    const { MockCompxDevice } = await import('/js/mock-compx.js');
    const dev = new MockCompxDevice({ vendorId: OMM.compx.VENDOR_ATK, productName: 'ATK F1 LEVIATAN 2.0', cid: 1, mid: 13 });
    const model = OMM.compx.modelFor(dev.vendorId, 1, 13);
    for (const bank of dev.banks) [400, 800, 1600, 3200].forEach((dpi, i) => OMM.compx.setDpi(bank, i, dpi, model));
    await OMM.connectCompx([dev]);
  });
  await page.getByRole('tab', { name: '성능', exact: true }).click();
  const lodValue = () => page.evaluate(() => OMM.compx.parse(OMM.compxUi.state.work).lod);
  const lodInput = page.locator('[data-stepper="리프트오프 거리"] input');
  await lodInput.fill('1.3');
  await lodInput.press('Enter');
  assert.equal(await lodValue(), 7);
  assert.equal(await lodInput.inputValue(), '1.3');
  await page.getByRole('button', { name: '리프트오프 거리 올리기' }).click();
  assert.equal(await lodValue(), 8);
  assert.equal(await lodInput.inputValue(), '1.4');
  await lodInput.press('ArrowDown');
  assert.equal(await lodValue(), 7);
  await lodInput.fill('1.35');
  await lodInput.press('Enter');
  assert.match(await page.evaluate(() => toastLog.at(-1)), /0\.7~1\.7, 0\.1 단위/);
  assert.equal(await lodValue(), 7);
  await lodInput.fill('1.7');
  await lodInput.press('Enter');
  assert.equal(await page.getByRole('button', { name: '리프트오프 거리 올리기' }).isDisabled(), true);
  await page.locator('#btn-revert').click();
  assert.equal(await page.evaluate(() => OMM.compxUi.isDirty()), false);

  // ATK 센서 모드: CID 1 기종은 경기용 MAX까지 고를 수 있고, 주소 185·186(검사 바이트)에 저장한다.
  const modes = page.getByRole('group', { name: '센서 모드' });
  assert.deepEqual(await modes.locator('button').allInnerTexts(), ['기본', '경기용', '경기용 MAX']);
  await modes.getByRole('button', { name: '경기용 MAX' }).click();
  await saveNow();
  assert.deepEqual(await page.evaluate(() => Array.from(OMM.compxUi.state.dev.dev.flash.subarray(185, 187))), [2, 0x53]);
  // 센서 모드를 읽기 전에 만든 185바이트 백업도 불러온다. 센서 모드는 기기 값 그대로 둔다.
  const sensorBackup = JSON.parse(await fs.readFile(await exportFile(), 'utf8'));
  await page.locator('#import-file').setInputFiles({ name: 'old.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...sensorBackup, image: sensorBackup.image.slice(0, 370) })) });
  await page.waitForFunction(() => /불러왔습니다/.test(toastLog.at(-1)));
  assert.equal(await page.evaluate(() => OMM.compx.parse(OMM.compxUi.state.work).sensorMode), 2);

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
  // VIA: 제작사 파일 없이 직접 만든 정의와 가상 키보드로 저장 경계를 확인한다.
  await page.evaluate(() => OMM.setLang('ko'));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(async () => {
    const { MockViaDevice } = await import('/js/mock-via.js');
    const { demoDefinition } = await import('/js/via-demo.js');
    window.viaDef = demoDefinition();
    // 시험용 메뉴: 위험 설정, 실행하면 안 되는 동작, 키 코드, 지원하지 않는 항목.
    viaDef.menus[0].content[0].content.push(
      { label: 'Connection', type: 'dropdown', options: [['USB', 0], ['Wireless', 1]], content: ['connection', 2, 1] },
      { label: 'Factory reset', type: 'toggle', content: ['factory_reset', 2, 2] },
      { label: 'Shortcut', type: 'keycode', content: ['shortcut', 2, 3] });
    viaDef.menus.push('qmk_rgblight');
    viaDef.layouts.keys.push({ x: 15, y: 0, w: 1, h: 1, encoder: 0 });
    window.makeVia = (extra = {}) => new MockViaDevice({ vendorId: viaDef.vendorId, productId: viaDef.productId, productName: viaDef.name, rows: 5, cols: 16, layers: 3, macroCount: 4, macroBufferSize: 256, custom: { '1,1': [1] }, ...extra });
    window.vm = makeVia();
    await OMM.connectVia([vm], viaDef);
  });
  assert.equal(await page.locator('.via-key').count(), await page.evaluate(() => OMM.viaUi.state.session.keys().length + 1));
  assert.equal(await page.evaluate(() => vm.log.length), 0);
  await page.locator('.via-layers [data-layer="1"]').click();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.layer), 1);
  await page.locator('.via-layers [data-layer="0"]').click();
  await page.locator('.via-key[data-row="0"][data-col="0"]').click();
  await page.locator('#via-direct').fill('not-a-key');
  await page.getByRole('button', { name: '직접 입력', exact: true }).click();
  assert.match(await page.locator('.via-picker [role=alert]').innerText(), /읽을 수 없는/);
  assert.equal(await page.evaluate(() => OMM.viaUi.isDirty()), false);
  await page.locator('#via-direct').fill('LT(1, KC_SPC)');
  await page.getByRole('button', { name: '직접 입력', exact: true }).click();
  assert.equal(await page.evaluate(() => vm.log.length), 0);
  assert.equal(await page.locator('.via-key.changed').count(), 1);
  await saveNow();
  assert.equal(await page.evaluate(() => vm.log.some((p) => p[0] === 5)), true);
  assert.equal(await page.locator('.via-key[data-row="0"][data-col="0"]').innerText(), 'Space\nL1');
  assert.equal(await page.locator('.via-key[data-row="0"][data-col="0"]').getAttribute('title'), 'LT(1, KC_SPC)');
  // 키보드 입력과 위험 키 선택 확인. 취소하면 편집하지 않는다.
  await page.getByRole('button', { name: '키보드로 고르기', exact: true }).click();
  await page.keyboard.press('KeyC');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.keycode(0, 0, 0)), 6);
  await page.getByRole('button', { name: '특수', exact: true }).click();
  await page.locator('.via-code-grid .danger').first().click();
  assert.match(await page.locator('#confirm-body').innerText(), /재시작/);
  await page.locator('#confirm button[value=cancel]').click();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.keycode(0, 0, 0)), 6);
  await page.locator('#btn-revert').click();
  // 인코더의 두 방향은 별도로 선택·저장된다.
  await page.locator('.via-key[data-encoder="0"]').last().click();
  await page.locator('#via-direct').fill('KC_A');
  await page.getByRole('button', { name: '직접 입력', exact: true }).click();
  await saveNow();
  assert.equal(await page.evaluate(() => vm.encoders.get('0,0,1')), 4);
  await page.getByRole('tab', { name: '레이아웃', exact: true }).click();
  const countBefore = await page.locator('.via-key').count();
  await page.locator('[data-option="0"]').selectOption('1');
  assert.equal(await page.locator('.via-key').count(), countBefore + 1);
  await saveNow();
  assert.equal(await page.evaluate(() => vm.layoutOptions), 1);
  await page.getByRole('tab', { name: '조명 / 설정', exact: true }).click();
  assert.equal(await page.locator('[data-action="factory_reset"] button, [data-action="factory_reset"] input').count(), 0);
  assert.equal(await page.locator('[data-setting="brightness"]').count(), 1);
  await page.locator('[data-setting="enabled"] input').uncheck();
  assert.equal(await page.locator('[data-setting="brightness"]').count(), 0);
  await page.locator('[data-setting="connection"] select').selectOption('1');
  await page.locator('#btn-save').click();
  assert.match(await page.locator('#confirm-body').innerText(), /주의: Connection/);
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.viaUi.isDirty());
  assert.equal(await page.evaluate(() => { const cmds = vm.log.map((p) => p[0]); return cmds.lastIndexOf(7) < cmds.lastIndexOf(9); }), true);
  await page.getByRole('tab', { name: '매크로', exact: true }).click();
  await page.locator('.via-macros button').first().click();
  await page.getByRole('button', { name: '+ 글자', exact: true }).click();
  await page.locator('.macro-steps input[type=text]').fill('Hello VIA!');
  await page.locator('.macro-steps input[type=text]').blur();
  await saveNow();
  assert.equal(await page.evaluate(() => new TextDecoder().decode(vm.macroBuffer.slice(0, 10))), 'Hello VIA!');
  await page.locator('.macro-steps input[type=text]').fill('한글');
  await page.locator('.macro-steps input[type=text]').blur();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.macro(0).steps[0].text), 'Hello VIA!');
  // 텍스트 모드: 저장된 매크로를 VIA 식으로 보여 주고, 고친 식을 적용하면 단계가 된다. 잘못된 식은 바꾸지 않는다.
  await page.locator('#via-macro-mode-text').click();
  assert.equal(await page.locator('#via-macro-text').inputValue(), 'Hello VIA!');
  await page.locator('#via-macro-text').fill('Hi{KC_ENT}{50}{KC_LCTL,KC_C}');
  await page.locator('#via-macro-apply').click();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.macro(0).steps.map((s) => s.kind).join()), 'text,key,key,delay,key,key,key,key');
  await page.locator('#via-macro-text').fill('{NOT_A_KEY}');
  await page.locator('#via-macro-apply').click();
  assert.match(await page.locator('#toasts').textContent(), /NOT_A_KEY/);
  assert.equal(await page.locator('#via-macro-text').inputValue(), '{NOT_A_KEY}');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.macro(0).steps[0].text), 'Hi');
  await page.locator('#via-macro-mode-steps').click();
  assert.equal(await page.locator('.macro-steps input[type=text]').inputValue(), 'Hi');
  await page.evaluate(() => { OMM.viaUi.revert(); OMM.viaUi.state.macroText = false; document.querySelector('#toasts').replaceChildren(); });
  // 백업은 읽은 값만 내보내고, 새 연결에 불러오면 편집본이 된다.
  const viaDownload = page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const viaBackup = JSON.parse(await fs.readFile(await (await viaDownload).path(), 'utf8'));
  await page.evaluate(async () => { window.vm = makeVia(); await OMM.connectVia([vm], viaDef); });
  await page.locator('#import-file').setInputFiles({ name: 'via.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(viaBackup)) });
  await page.waitForFunction(() => OMM.viaUi.isDirty());
  assert.equal(await page.evaluate(() => vm.log.length), 0);
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.customValue('connection')), 0);
  await page.locator('#btn-revert').click();
  // 키 시험은 쓰지 않으며, 탭/앱 화면을 떠나면 질의를 멈춘다.
  await page.evaluate(() => {
    vm.matrix = [[0, 0]]; window.matrixReads = 0;
    const original = vm.sendReport.bind(vm);
    vm.sendReport = (id, p) => { if (p[0] === 2 && p[1] === 3) matrixReads++; return original(id, p); };
  });
  await page.getByRole('tab', { name: '키 시험', exact: true }).click();
  await page.waitForSelector('.via-key[data-row="0"][data-col="0"].pressed');
  // 키 시험 중에는 브라우저 단축키가 실행되지 않고, 다른 탭에서는 그대로 둔다
  const blocked = (key) => page.evaluate((k) => !window.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true })), key);
  assert.equal(await blocked('F5'), true);
  assert.equal(await blocked('F1'), true);
  await page.getByRole('tab', { name: '키맵', exact: true }).click();
  assert.equal(await blocked('F5'), false);
  const reads = await page.evaluate(() => matrixReads);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => matrixReads), reads);
  assert.doesNotMatch(await page.locator('#editor').innerText(), /false|undefined|\[object/);
  await page.evaluate(() => document.querySelector('#toasts').replaceChildren());
  await shot('via-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['키맵', '레이아웃', '조명 / 설정', '매크로', '키 시험']) {
    await page.getByRole('tab', { name, exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `VIA mobile ${name}`);
  }
  await page.getByRole('tab', { name: '키맵', exact: true }).click();
  await shot('via-mobile.png');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => OMM.setLang('en'));
  for (const name of ['Keymap', 'Layout', 'Lighting / Settings', 'Macro', 'Key tester']) {
    await page.getByRole('tab', { name, exact: true }).click();
    assert.doesNotMatch(await page.locator('#editor').innerText(), hangul);
  }
  await page.getByRole('tab', { name: 'Keymap', exact: true }).click();
  await shot('via-english.png');
  // 정의 파일이 없을 때 제작사 링크와 JSON 오류·기기 불일치·정상 파일 처리.
  await page.route('https://usevia.app/**', (route) => route.fulfill({ status: 404, body: '' }));
  // QK80 MK2는 사이트에 실린 정의 파일을 먼저 쓰고, 이 브라우저에 기억하지 않는다.
  await page.evaluate(async () => { const { MockViaDevice } = await import('/js/mock-via.js'); localStorage.clear(); window.vm = new MockViaDevice(); await OMM.connectVia([vm]); });
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), 'QK80 MK2');
  assert.match(await page.locator('.via-heading .hint').innerText(), /Bundled definition \(downloaded 2026-10-18\)/);
  assert.equal(await page.evaluate(() => [localStorage.length, vm.log.length].join()), '0,0');
  // ISO 옵션을 켜면 ISO 엔터를 두 조각으로 그린다
  await page.evaluate(() => { OMM.viaUi.state.session.setLayoutOption(1, 1); OMM.ui.refresh(); });
  assert.equal(await page.locator('.via-key.shaped .via-key-part').count(), 2);
  await page.evaluate(() => { OMM.viaUi.state.session.revert(); OMM.ui.refresh(); });
  // 키 고르기: 기본 키는 키보드 모양, 조합 칸으로 LT(1, KC_SPC)와 Ctrl+C를 만든다
  await page.evaluate(() => { OMM.viaUi.state.group = 'basic'; });
  await page.locator('.via-key[data-row="0"][data-col="0"]').click();
  assert.equal(await page.locator('.via-pick-board button[data-code="41"]').count(), 1);
  await page.locator('#via-combo-kind').selectOption('lt');
  await page.locator('[data-combo-layer="1"]').click();
  await page.locator('.via-pick-board button[data-code="44"]').click();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.keycode(0, 0, 0)), 0x412c);
  await page.locator('#via-combo-kind').selectOption('mods');
  await page.locator('[data-mod="1"]').check();
  await page.locator('.via-pick-board button[data-code="6"]').click();
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.keycode(0, 0, 0)), 0x0106);
  await shot('via-picker.png');
  // VIA 레이아웃 파일: 내보낸 것을 고쳐 불러오면 편집본에 들어간다
  const viaLayout = await page.evaluate(async () => { OMM.viaUi.revert(); const F = await import('/js/via-layout-file.js'); return F.exportViaLayout(OMM.viaUi.state.session); });
  assert.equal(viaLayout.layers[0][0], 'KC_A'); // 가상 키보드의 기본 키맵
  viaLayout.layers[0][0] = 'C(KC_C)';
  await page.locator('#via-layout-import').setInputFiles({ name: 'qk80.layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(viaLayout)) });
  await page.waitForFunction(() => OMM.viaUi.state.session.keycode(0, 0, 0) === 0x0106);
  assert.equal(await page.evaluate(() => vm.log.length), 0);
  await page.evaluate(() => OMM.viaUi.revert());
  await page.route('**/definitions/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(async () => { window.vm = new (await import('/js/mock-via.js')).MockViaDevice(); await OMM.connectVia([vm]); });
  assert.equal(await page.locator('.via-loader a').first().getAttribute('href'), 'https://cfg.qwertykeys.com/definitions/v3/1363889410.json');
  assert.equal(await page.locator('#btn-save').isDisabled(), true);
  await page.locator('#via-definition').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await page.waitForSelector('.via-loader [role=alert]');
  await page.locator('#via-definition').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(viaBackup)) });
  await page.waitForFunction(() => !OMM.state.busy);
  assert.equal(await page.evaluate(() => OMM.viaUi.connected() && !OMM.viaUi.state.session), true);
  const wrongDef = await page.evaluate(() => viaDef);
  await page.locator('#via-definition').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(wrongDef)) });
  await page.waitForFunction(() => !OMM.state.busy);
  assert.match(await page.locator('.via-loader [role=alert]').innerText(), /different keyboard/);
  const correctDef = { ...wrongDef, vendorId: 0x514b, productId: 0x4d02 };
  await page.locator('#via-definition').setInputFiles({ name: 'correct.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(correctDef)) });
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), correctDef.name);
  assert.equal(await page.evaluate(() => vm.log.length), 0);
  // 「정의 파일 바꾸기」 뒤에도 돌아갈 수 있고, 편집과 기억한 파일이 그대로 남는다
  await page.evaluate(() => { OMM.viaUi.state.session.setKeycode(0, 0, 0, 0x29); OMM.ui.refresh(); });
  await page.getByRole('button', { name: 'Change definition', exact: true }).click();
  assert.equal(await page.locator('#via-definition').count(), 1);
  assert.equal(await page.evaluate(() => localStorage.length), 1);
  await page.locator('#via-definition-back').click();
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => [OMM.viaUi.state.session.def.name, OMM.viaUi.isDirty()].join()), `${correctDef.name},true`);
  // 자동으로 찾지 못하면 알리고, 기억한 파일은 지우지 않는다
  await page.getByRole('button', { name: 'Change definition', exact: true }).click();
  await page.locator('#via-definition-auto').click();
  await page.waitForSelector('.via-loader [role=alert]');
  assert.match(await page.locator('.via-loader [role=alert]').innerText(), /could not find/i);
  assert.equal(await page.evaluate(() => localStorage.length), 1);
  await page.evaluate(() => localStorage.clear());
  // 같은 ID를 여러 키보드가 쓰면(Crush 80·RE:AL HX, 320F:5055) 자동으로 받지 않고 고르게 한다. 고른 파일은 기억해 다음부터 바로 연다.
  await page.unroute('**/definitions/**');
  const crushLike = { vendorId: 0x320f, productId: 0x5055, productName: 'Crush 80', rows: 8, cols: 16 };
  await page.evaluate(async (o) => { window.vm = makeVia(o); await OMM.connectVia([vm]); }, crushLike);
  await page.waitForSelector('.via-loader [data-choice]');
  assert.deepEqual(await page.locator('.via-loader [data-choice]').allInnerTexts(), ['WOBKEY Crush 80 (RGB)', 'WOBKEY Crush 80 (non-RGB)', 'archon RE:AL HX']);
  // 제품 이름 'Crush 80'과 맞는 두 후보만 강조된다
  assert.deepEqual(await page.locator('.via-loader [data-choice][data-matched]').allInnerTexts(), ['WOBKEY Crush 80 (RGB)', 'WOBKEY Crush 80 (non-RGB)']);
  assert.match(await page.locator('.via-choices .hint').innerText(), /reports \(Crush 80\)/);
  assert.equal(await page.evaluate(() => !OMM.viaUi.state.session && localStorage.length), 0);
  await page.locator('.via-loader [data-choice="definitions/archon/839864405.json"]').click();
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), 'RE:AL HX');
  assert.match(await page.locator('.via-heading .hint').innerText(), /Bundled definition \(downloaded 2026-10-23\)/);
  assert.equal(await page.evaluate(() => localStorage.length), 1);
  await page.locator('#btn-disconnect').click();
  await page.waitForFunction(() => !OMM.viaUi.connected());
  await page.evaluate(async (o) => { window.vm = makeVia(o); await OMM.connectVia([vm]); }, crushLike);
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), 'RE:AL HX');
  assert.match(await page.locator('.via-heading .hint').innerText(), /remembered in this browser/);
  await page.evaluate(() => localStorage.clear());
  // 제품 이름이 한 후보와만 맞으면(RE:AL HX) 고르지 않고 바로 연다. 기억하지는 않는다.
  await page.locator('#btn-disconnect').click();
  await page.waitForFunction(() => !OMM.viaUi.connected());
  await page.evaluate(async (o) => { window.vm = makeVia(o); await OMM.connectVia([vm]); }, { ...crushLike, productName: 'RE:AL HX' });
  await page.waitForSelector('.via-key');
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), 'RE:AL HX');
  assert.match(await page.locator('.via-heading .hint').innerText(), /Bundled definition \(downloaded 2026-10-23\)/);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  // 구형 프로토콜은 키맵만 막고 설정은 편집할 수 있다.
  await page.evaluate(async () => { window.vm = makeVia({ protocol: 11 }); await OMM.connectVia([vm], viaDef); });
  assert.equal(await page.locator('.via-key').first().isDisabled(), true);
  await page.getByRole('tab', { name: 'Lighting / Settings', exact: true }).click();
  assert.equal(await page.locator('[data-setting="enabled"] input').isEnabled(), true);
  assert.equal(await page.locator('[data-setting="shortcut"] button').isDisabled(), true);
  // Vial: 정의 파일은 키보드에서 읽는다. 탭 댄스·QMK 설정은 잠겨 있어도 저장하고, 매크로는 잠금을 푼 뒤에 저장한다.
  await page.evaluate(async () => {
    const { MockViaDevice } = await import('/js/mock-via.js');
    const { packed } = await import('/js/vial-demo.js');
    window.vv = new MockViaDevice({ vendorId: 0xfeed, productId: 0x0060, productName: 'Vial 60', rows: 5, cols: 15, macroCount: 4, macroBufferSize: 128,
      vial: { packed, tapDance: [{ onTap: 0x04, onHold: 0, onDoubleTap: 0, onTapHold: 0, term: 200 }], combos: [{ keys: [0, 0, 0, 0], output: 0 }], settings: { 7: [2, 200], 21: [4, 0] } } });
    await OMM.connectVia([vv]);
  });
  await page.waitForSelector('.via-lock');
  assert.match(await page.locator('.via-heading .hint').innerText(), /Vial 6/);
  assert.equal(await page.evaluate(() => OMM.viaUi.state.session.def.name), 'GOMM Vial 60');
  await page.getByRole('tab', { name: 'Tap dance & combos', exact: true }).click();
  await page.locator('[data-vial="tapDance:0:onHold"]').click();
  await page.locator('.via-pick-board button[data-code="225"]').click();
  await page.locator('[data-td="0"] input[type=number]').fill('180');
  await page.locator('[data-td="0"] input[type=number]').dispatchEvent('change');
  assert.deepEqual(await page.evaluate(() => OMM.viaUi.state.session.vialEntry('tapDance', 0)), { onTap: 0x04, onHold: 0xe1, onDoubleTap: 0, onTapHold: 0, term: 180 });
  await shot('vial-tapdance.png');
  await page.getByRole('tab', { name: 'QMK settings', exact: true }).click();
  await page.locator('[data-qsid="21"][data-bit="7"]').check();
  await page.locator('[data-qsid="7"]').fill('250');
  await page.locator('[data-qsid="7"]').dispatchEvent('change');
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.viaUi.isDirty());
  assert.deepEqual(await page.evaluate(() => [vv.vial.tapDance[0].onHold, vv.vial.tapDance[0].term, vv.vial.settings[21][1], vv.vial.settings[7][1]]), [0xe1, 180, 128, 250]);
  await page.getByRole('tab', { name: 'Key tester', exact: true }).click();
  assert.match(await page.locator('#editor .notice').last().innerText(), /Unlock the Vial keyboard/);
  // 매크로를 저장하려 하면 잠금 풀기 화면이 열리고, 정해진 키를 누르고 있으면 풀린다
  await page.evaluate(() => { OMM.viaUi.state.session.setMacro(0, [{ kind: 'text', text: 'hi' }]); OMM.ui.refresh(); });
  await page.locator('#btn-save').click();
  await page.waitForSelector('.via-unlock');
  assert.equal(await page.locator('.via-key.unlock-target').count(), 2);
  await shot('vial-unlock.png');
  await page.evaluate(() => { vv.matrix = [[0, 0], [0, 1]]; });
  await page.waitForFunction(() => !OMM.viaUi.state.unlocking && !OMM.viaUi.state.session.locked());
  await page.evaluate(() => { vv.matrix = null; });
  await page.locator('#btn-save').click();
  await page.locator('#confirm-ok').click();
  await page.waitForFunction(() => !OMM.state.busy && !OMM.viaUi.isDirty());
  assert.equal(await page.evaluate(() => new TextDecoder().decode(vv.macroBuffer.slice(0, 2))), 'hi');
  assert.equal(await page.evaluate(() => vv.log.some((p) => p[0] === 0xfe && [0x08, 0x0c].includes(p[1]))), false);
  await page.evaluate(() => OMM.connectDemo('vial'));
  assert.equal(await page.evaluate(() => OMM.viaUi.connected() && OMM.state.demo && OMM.viaUi.state.session.vialCounts.tapDance), 4);
  await page.evaluate(() => OMM.connectDemo('via'));
  assert.equal(await page.evaluate(() => OMM.viaUi.connected() && OMM.state.demo), true);
  // 기기 종류 나누기: 키보드를 연결하면 메뉴가 「키보드 설정」이 되고 마우스 테스트는 숨는다. 마우스로 바꾸면 돌아온다.
  assert.equal(await page.locator('#views [data-view=config]').innerText(), 'Keyboard settings');
  assert.equal(await page.locator('#views [data-view=test]').isVisible(), false);
  await page.locator('#btn-disconnect').click();
  await page.locator('#views [data-view=home]').click();
  assert.equal(await page.locator('.kind-card').count(), 2);
  await page.locator('.kind-card[data-kind=mouse] [data-demo=logitech]').click();
  await page.waitForFunction(() => !OMM.state.busy && OMM.logitech.connected());
  assert.equal(await page.locator('#views [data-view=config]').innerText(), 'Mouse settings');
  assert.equal(await page.locator('#views [data-view=test]').isVisible(), true);
  await page.locator('#btn-disconnect').click();
  assert.equal(await page.locator('#views [data-view=config]').innerText(), 'Device settings');
  console.log('Browser: VIA keymap/layers/encoder, staged writes, danger confirmation, layout, showIf/custom save, ASCII macro, backup, matrix polling, definition loading, protocol 11, demo, English and 390px passed.');
  await page.evaluate(() => OMM.setLang('ko'));
  assert.deepEqual(errors, []);
  console.log('Browser: ATK profiles, rejection and dirty cancel; MCHOSE UTF-8 names, tabs, staged save; official image/fallback, mobile, Logitech/VGN regressions; demo devices, VGN/MCHOSE backup round-trip, DPI/angle math and full English UI passed.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
