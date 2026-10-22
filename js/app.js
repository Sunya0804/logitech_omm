// 앱의 뼈대: 기기 연결과 브랜드별 화면 선택, 홈·상태 줄·저장 막대, 데모, 언어 전환.
// 브랜드별 화면(logitech-ui, compx-ui, mchose-ui)은 같은 모양의 함수 묶음을 내보낸다.
import * as C from './compx.js';
import * as logitech from './logitech-ui.js';
import * as compxUi from './compx-ui.js';
import * as mchoseUi from './mchose-ui.js';
import * as viaUi from './via-ui.js';
import { hasViaInterface } from './via.js';
import * as tester from './tester.js';
import { isRecording } from './macro-editor.js';
import { deviceImage } from './device-images.js';
import { t, num, translateDom, setLang, getLang, onLangChange, LANGS } from './i18n.js';
import { $, h, app, shell, toast, busy } from './ui.js';

const UIS = [logitech, compxUi, mchoseUi, viaUi];
const active = () => UIS.find((ui) => ui.connected()) || null;

// ---------- 연결 ----------

// 다른 기기와의 연결을 끊고 ui로 연결한다. 실패하면 그 화면의 상태도 비운다.
async function connectWith(ui, arg, message) {
  if (app.busy) return false; // 기기와 통신하는 중에 연결을 끊지 않는다
  await disconnect();
  const ok = await busy(message, (setMsg) => ui.connect(arg, setMsg));
  if (!ok) await ui.disconnect();
  render();
  if (ok) setView('config');
  return ok;
}

async function disconnect() {
  for (const ui of UIS) await ui.disconnect();
  app.demo = false;
}

// 기기 종류별 연결 창 필터. 키보드는 VIA 통신 칸이 있는 기기만 보인다.
const FILTERS = {
  mouse: () => [...logitech.filters, ...C.filters, ...mchoseUi.filters],
  keyboard: () => viaUi.filters,
};

// 기기 선택 창을 띄우고, 고른 기기의 제조사에 맞는 방식으로 연결한다.
// 마우스 창에도 같은 제조사의 키보드가 보일 수 있어서, VIA 통신 칸이 있으면 키보드로 연결한다.
async function requestConnect(kind = 'mouse') {
  try {
    const picked = await navigator.hid.requestDevice({ filters: FILTERS[kind]() });
    if (!picked.length) return;
    const vendor = picked[0].vendorId;
    const via = picked.some(hasViaInterface);
    if (kind === 'keyboard') return await connectWith(viaUi, picked, t('키보드 정보 읽는 중…'));
    // 제품 ID까지 아는 마우스 경로를 먼저 고른다. 제조사 ID만 같은 키보드는 VIA로 보낸다.
    if (mchoseUi.filters.some((f) => f.vendorId === vendor && (f.productId !== undefined ? picked.some((d) => d.productId === f.productId) : !via))) return await connectWith(mchoseUi, picked, t('MCHOSE 기기 읽는 중…'));
    if (C.VENDOR_IDS.includes(vendor) && !via) return await connectWith(compxUi, picked, t('기기 읽는 중…'));
    if (via) return await connectWith(viaUi, picked, t('키보드 정보 읽는 중…'));
    await connectWith(logitech, logitech.transportFor(picked), t('기기 검색 중…'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- 배터리 ----------

// 배터리 잔량은 1분마다 다시 읽는다. 다른 작업(읽기·저장) 중이거나 매크로를 녹화 중이면 건너뛴다.
// 각 화면의 refreshBattery는 마우스를 깨우지 않게 묻고, 절전 중이거나 응답이 없으면 직전 값을 그대로 둔다.
const BATTERY_POLL_MS = 60_000;

async function pollBattery() {
  const ui = active();
  if (!ui || app.demo || app.busy || app.background || isRecording()) return false;
  const job = ui.refreshBattery().catch(() => false);
  app.background = job;
  try {
    if (!(await job) || active() !== ui) return false;
  } finally {
    app.background = null;
  }
  // 편집 중인 입력을 다시 그리면 포커스를 잃으므로, 그때는 상태 줄과 홈 카드만 바꾼다.
  if ($('#editor').contains(document.activeElement)) {
    renderDeviceBar(ui);
    renderHome(ui);
  } else render();
  return true;
}

// ---------- 데모 ----------

// 실제 기기 없이 화면을 둘러보는 가상 기기. 모두 메모리 안에서만 동작하고 WebHID에 접근하지 않는다.
// MCHOSE는 실기기(K7 Ultra)에서 읽어 둔 응답을 재생한다.
async function connectDemo(kind) {
  try {
    if (kind === 'vial') {
      const { MockViaDevice } = await import('./mock-via.js');
      const { packed } = await import('./vial-demo.js');
      const dev = new MockViaDevice({ vendorId: 0xfeed, productId: 0x0060, productName: 'GOMM Vial 60', rows: 5, cols: 15, macroCount: 8, macroBufferSize: 512,
        vial: { packed, tapDance: Array.from({ length: 4 }, (_, i) => ({ onTap: i ? 0 : 0x29, onHold: i ? 0 : 0xe1, onDoubleTap: 0, onTapHold: 0, term: 200 })),
          combos: [{ keys: [0x09, 0x0a, 0, 0], output: 0x29 }, { keys: [0, 0, 0, 0], output: 0 }],
          keyOverrides: [{ trigger: 0x2a, replacement: 0x4c, layers: 0xffff, triggerMods: 0x22, negativeMods: 0, suppressedMods: 0x22, options: 0x87 }],
          settings: { 7: [2, 200], 2: [2, 50], 21: [4, 0], 3: [1, 0], 4: [2, 175] } } });
      await connectWith(viaUi, [dev], t('키보드 정보 읽는 중…'));
    } else if (kind === 'via') {
      const { MockViaDevice } = await import('./mock-via.js');
      const { demoDefinition } = await import('./via-demo.js');
      const json = demoDefinition();
      const dev = new MockViaDevice({ vendorId: json.vendorId, productId: json.productId, productName: json.name, rows: 5, cols: 16, custom: { '1,1': [1] } });
      await connectWith({ ...viaUi, connect: (devices, msg) => viaUi.connect(devices, msg, json) }, [dev], t('키보드 정보 읽는 중…'));
    } else if (kind === 'logitech') {
      const { MockTransport } = await import('./mock.js');
      await connectWith(logitech, new MockTransport('analog'), t('기기 검색 중…'));
    } else if (kind === 'mchose') {
      const { CapturedMouse } = await import('./mock-mchose.js');
      const captures = await (await fetch(new URL('./mock-mchose.json', import.meta.url))).json();
      await connectWith(mchoseUi, [new CapturedMouse(captures[0])], t('MCHOSE 기기 읽는 중…'));
    } else {
      const { MockCompxDevice } = await import('./mock-compx.js');
      const atk = kind === 'atk';
      const dev = atk ? new MockCompxDevice({ vendorId: C.VENDOR_ATK, productName: 'ATK A9 Ultra', cid: 2, mid: 87 }, { macro: true }) : new MockCompxDevice();
      // 가상 기기의 기본 DPI 기록은 VGN 방식이라, ATK A9 Ultra(10 단위 방식)는 그 방식으로 다시 쓴다.
      const model = C.modelFor(dev.vendorId, dev.identity.cid, dev.identity.mid);
      if (atk) for (const bank of dev.banks) [400, 800, 1600, 3200].forEach((dpi, i) => C.setDpi(bank, i, dpi, model));
      await connectWith(compxUi, [dev], t('기기 읽는 중…'));
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  app.demo = !!active();
  render();
}

// ---------- 화면 ----------

const VIEW_TITLES = { home: '홈', config: '기기 설정', test: '마우스 테스트' };
const CONFIG_TITLES = { mouse: '마우스 설정', keyboard: '키보드 설정' };
let view = 'home';

// 연결된 기기의 종류. 연결이 없으면 null.
const activeKind = () => { const ui = active(); return ui ? (ui.summary().kind === 'keyboard' ? 'keyboard' : 'mouse') : null; };
const viewTitle = (v) => t(v === 'config' ? CONFIG_TITLES[activeKind()] || VIEW_TITLES.config : VIEW_TITLES[v]);

// 왼쪽 메뉴를 연결된 기기 종류에 맞춘다: 설정 이름을 바꾸고, 키보드에는 마우스 테스트를 숨긴다.
function renderNav() {
  const config = document.querySelector('#views [data-view=config]');
  config.querySelector('span').textContent = viewTitle('config');
  config.setAttribute('aria-label', viewTitle('config'));
  document.querySelector('#views [data-view=test]').hidden = activeKind() === 'keyboard';
  if (view === 'test' && activeKind() === 'keyboard') setView('home');
  $('#page-title').textContent = viewTitle(view);
}

function setView(next) {
  if (next !== 'config') viaUi.suspend();
  view = next;
  document.body.dataset.view = next;
  for (const btn of document.querySelectorAll('#views button')) {
    const on = btn.dataset.view === next;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  $('#page-title').textContent = viewTitle(next);
  if (next === 'config') viaUi.resume();
}

function statusChips(sum) {
  const b = sum.battery;
  return [
    sum.dpi && h('span', { class: 'chip' }, `DPI ${num(sum.dpi)}`),
    sum.rate && h('span', { class: 'chip' }, `${num(sum.rate)} Hz`),
    sum.profileLabel && h('span', { class: 'chip' }, sum.profileLabel),
    b && h('span', { class: 'chip', title: t('배터리') },
      h('span', { class: 'battery' + (b.percent <= 20 ? ' low' : ''), 'aria-hidden': 'true' }, h('i', { style: `width:${Math.min(100, b.percent)}%` })),
      h('span', { class: 'sr-only' }, t('배터리') + ' '),
      `${b.percent}%`, b.charging && h('span', { title: t('충전 중'), 'aria-label': t('충전 중') }, ' ⚡')),
  ].filter(Boolean);
}

const MOUSE_ART = '<svg class="device-art" viewBox="0 0 200 300" aria-hidden="true">'
  + '<defs><linearGradient id="art-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cc9ff"/><stop offset="1" stop-color="#8b7bff"/></linearGradient></defs>'
  + '<rect x="32" y="14" width="136" height="272" rx="68" class="art-body"/>'
  + '<path d="M100 14v114M32 128h136" class="art-line"/>'
  + '<rect x="90" y="44" width="20" height="52" rx="10" class="art-wheel"/>'
  + '<rect x="16" y="132" width="16" height="40" rx="7" class="art-side"/><rect x="16" y="178" width="16" height="40" rx="7" class="art-side"/>'
  + '<path d="M72 236h56" class="art-glow"/></svg>';

// 키보드(VIA)용 그림: 키 3줄과 스페이스바
const KEYBOARD_ART = '<svg class="device-art keyboard" viewBox="0 0 200 120" aria-hidden="true">'
  + '<defs><linearGradient id="art-k" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4cc9ff"/><stop offset="1" stop-color="#8b7bff"/></linearGradient></defs>'
  + '<rect x="6" y="26" width="188" height="88" rx="12" class="art-body"/>'
  + '<rect x="18" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="34" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="50" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="66" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="82" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="98" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="114" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="130" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="146" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="162" y="40" width="13" height="13" rx="2" class="art-wheel"/><rect x="18" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="34" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="50" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="66" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="82" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="98" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="114" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="130" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="146" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="162" y="56" width="13" height="13" rx="2" class="art-wheel"/><rect x="18" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="34" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="50" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="66" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="82" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="98" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="114" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="130" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="146" y="72" width="13" height="13" rx="2" class="art-wheel"/><rect x="162" y="72" width="13" height="13" rx="2" class="art-wheel"/>'
  + '<rect x="50" y="90" width="100" height="13" rx="2" class="art-wheel"/>'
  + '<path d="M40 18h120" stroke="url(#art-k)" stroke-width="5" stroke-linecap="round" fill="none"/></svg>';

// 홈: 연결된 기기 카드와 "다른 기기 연결" 카드.
function renderHome(ui) {
  const root = $('#home-devices');
  if (!ui) return root.replaceChildren();
  const sum = ui.summary();
  const art = h('div', { class: 'device-art-wrap' });
  const drawing = sum.kind === 'keyboard' ? KEYBOARD_ART : MOUSE_ART;
  art.innerHTML = drawing;
  const photo = deviceImage(sum.name);
  if (photo) {
    const img = h('img', { src: photo.image, alt: t('{name} 공식 제품 사진', { name: sum.name }), class: 'device-photo',
      referrerpolicy: 'no-referrer', onerror: () => { art.innerHTML = drawing; } });
    art.replaceChildren(img);
  }
  root.replaceChildren(
    h('article', { class: 'device-card', 'aria-label': sum.name },
      h('div', { class: 'device-card-head' },
        h('div', null, h('h3', null, sum.name), h('p', { class: 'hint' }, sum.modeText)),
        h('span', { class: 'chip ok' }, t('연결됨'))),
      art,
      h('div', { class: 'device-chips' }, statusChips(sum)),
      h('button', { class: 'primary', onclick: () => setView('config') }, t('설정 열기'))),
    h('article', { class: 'device-card add' },
      h('h3', null, t('다른 기기 연결')),
      h('p', { class: 'hint' }, t('한 번에 한 기기만 연결됩니다. 새 기기를 고르면 지금 기기와의 연결은 끊어집니다.')),
      h('div', { class: 'welcome-actions' },
        h('button', { onclick: () => requestConnect('mouse'), disabled: !('hid' in navigator) }, t('+ 마우스')),
        h('button', { onclick: () => requestConnect('keyboard'), disabled: !('hid' in navigator) }, t('+ 키보드')))));
}

function renderDeviceBar(ui) {
  const bar = $('#device');
  if (!ui) return bar.replaceChildren();
  const sum = ui.summary();
  bar.replaceChildren(...[
    app.demo && h('span', { class: 'chip demo' }, t('데모')),
    h('strong', null, sum.name),
    ...statusChips(sum),
    ...(ui.deviceBarExtras?.() || []),
  ].filter(Boolean));
}

function renderActionBar() {
  const ui = active();
  if (!ui) return;
  const dirty = ui.isDirty();
  const editable = ui.canEdit();
  $('#dirty-count').textContent = (dirty && ui.dirtyText?.()) || (dirty ? t('저장되지 않은 변경이 있습니다') : t('변경 사항 없음'));
  $('#btn-save').disabled = !dirty || !editable;
  $('#btn-revert').disabled = !dirty;
  $('#btn-import').disabled = !editable;
}

function render() {
  const ui = active();
  const connected = !!ui;
  $('#home-hero').hidden = connected;
  $('#home-devices').hidden = !connected;
  $('#config-empty').hidden = connected;
  $('#workspace').hidden = !connected;
  $('#actionbar').hidden = !connected;
  $('#btn-disconnect').hidden = !connected;
  $('#demo-banner').hidden = !(connected && app.demo);
  renderNav();
  renderDeviceBar(ui);
  renderHome(ui);
  if (!ui) return;
  $('#sidebar').hidden = !ui.renderProfiles($('#sidebar'));
  $('#editor').classList.toggle('via-editor', ui === viaUi);
  ui.render($('#editor'));
  renderActionBar();
}

// MCHOSE 지원 목록(홈 화면 아래 접히는 칸)
function renderCatalog() {
  const root = $('#mchose-catalog');
  const open = root.open;
  root.replaceChildren(
    h('summary', null, t('MCHOSE 지원 목록 ({n}개 기종·연결 변형)', { n: mchoseUi.catalog.length })),
    h('p', { class: 'hint' }, t('목록에 있어도 기기 데이터를 확인한 뒤 편집합니다. K7 Ultra와 A7 V2 Ultra+는 설정 읽기를 확인했습니다.')),
    ...['A5 Gen1', 'V2', 'V3'].map((family) => h('p', null,
      h('strong', null, family + ': '),
      mchoseUi.catalog.filter((p) => p.family === family).map((p) => p.name + (p.readOnly ? ' ' + t('(읽기 전용)') : '')).join(', '))),
    h('a', { href: 'docs/mchose-support.md', target: '_blank', rel: 'noopener' }, t('지원 범위·검증 기록')));
  root.open = open;
}

function renderLangPicker() {
  $('#lang').replaceChildren(...LANGS.map(([id, label]) => h('option', { value: id, selected: id === getLang() }, label)));
}

// ---------- 초기화 ----------

function init() {
  shell.refresh = render;
  shell.refreshActions = renderActionBar;
  const supported = 'hid' in navigator;
  $('#unsupported').hidden = supported;
  for (const btn of document.querySelectorAll('.btn-connect')) {
    btn.disabled = !supported;
    btn.addEventListener('click', () => requestConnect(btn.dataset.kind));
  }
  for (const btn of document.querySelectorAll('#views button')) btn.addEventListener('click', () => setView(btn.dataset.view));
  for (const btn of document.querySelectorAll('[data-demo]')) btn.addEventListener('click', () => connectDemo(btn.dataset.demo));
  $('#btn-disconnect').addEventListener('click', async () => { await disconnect(); render(); });
  $('#btn-save').addEventListener('click', () => active()?.save());
  $('#btn-revert').addEventListener('click', () => active()?.revert());
  $('#btn-export').addEventListener('click', () => active()?.exportBackup());
  $('#btn-diagnostics').addEventListener('click', () => active()?.exportDiagnostics());
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) active()?.importBackup(file);
    e.target.value = '';
  });
  $('#lang').addEventListener('change', (e) => setLang(e.target.value));
  onLangChange(() => {
    $('#toasts').replaceChildren(); // 이전 언어로 뜬 알림은 지운다
    setView(view);
    renderCatalog();
    renderLangPicker();
    tester.relabel();
    render();
  });
  if (supported) {
    navigator.hid.addEventListener('disconnect', async (e) => {
      if (!UIS.some((ui) => ui.ownsDevice(e.device))) return;
      await disconnect();
      render();
      toast(t('기기 연결이 끊어졌습니다.'), 'error');
    });
  }
  window.addEventListener('beforeunload', (e) => {
    if (active()?.isDirty()) e.preventDefault();
  });
  translateDom();
  renderLangPicker();
  renderCatalog();
  tester.init(setView);
  setView(view);
  render();
  setInterval(pollBattery, BATTERY_POLL_MS);
}

// 개발·테스트용 손잡이: 콘솔과 tests/browser.mjs가 쓴다.
window.OMM = {
  state: app, compx: C, logitech, compxUi, mchoseUi, viaUi, tester, ui: { refresh: render },
  connect: (transport) => connectWith(logitech, transport, t('기기 검색 중…')),
  connectCompx: (devices) => connectWith(compxUi, devices, t('기기 읽는 중…')),
  connectMchose: (devices) => connectWith(mchoseUi, devices, t('MCHOSE 기기 읽는 중…')),
  connectVia: (devices, json) => connectWith({ ...viaUi, connect: (arg, msg) => viaUi.connect(arg, msg, json) }, devices, t('키보드 정보 읽는 중…')),
  connectDemo, setLang, pollBattery,
};
init();
