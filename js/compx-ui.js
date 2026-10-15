// VGN·ATK(compx.js) 기기의 설정 화면. 기기에서 읽은 플래시 이미지의 사본을 고치고,
// 「기기에 저장」을 누르면 바뀐 바이트만 기록한 뒤 다시 읽어 대조한다.
import * as C from './compx.js';
import { t, num } from './i18n.js';
import { h, choice, toast, busy, ask, download, tabs, tabPanel, tile, field, app, shell } from './ui.js';

const DIAG_LENGTH = 256;

// stageLimit: 연결했을 때 기기가 쓰고 있던 DPI 단계 수. 펌웨어가 몇 단계까지 받는지 알 수 없어 그보다 늘리지 않는다.
// model: 기종별 선택지와 범위 (compx.js의 MODELS)
// unlock: 실기기로 확인하지 못한 기종에서 사용자가 편집을 허용했는지
const cx = { dev: null, info: null, model: null, extras: null, orig: null, work: null, stageLimit: 0, tab: 'overview', unlock: false };
const deviceName = () => cx.model.model || cx.dev.name;
const maxRate = () => Math.min(cx.info.maxRate, cx.model.maxRate);

export const filters = C.filters;
export const state = cx;
export const connected = () => !!cx.work;
export const canEdit = () => connected() && (cx.model.verified !== false || cx.unlock);
export const isDirty = () => connected() && C.diffRuns(cx.orig, cx.work).length > 0;
export const ownsDevice = (device) => !!cx.dev && cx.dev.devices.includes(device);

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
// 기종표의 [값, 표시] 목록을 화면 언어로 바꾼다.
const translated = (options) => options.map(([v, label]) => [v, t(label)]);

// 새 기종 지원을 위한 읽기 전용 정보: USB 식별값과 인터페이스, 그리고 가능하면 기기 식별값과 설정 메모리.
async function collectDiagnostics(devices, dev) {
  const first = devices[0];
  const diag = {
    type: 'omm-web-compx-diagnostics', version: 1, exportedAt: new Date().toISOString(),
    vendorId: first.vendorId.toString(16).padStart(4, '0'), productId: first.productId.toString(16).padStart(4, '0'),
    productName: first.productName,
    interfaces: devices.map((d) => d.collections.map((c) => ({
      usagePage: c.usagePage.toString(16), usage: c.usage.toString(16),
      input: c.inputReports.map((r) => r.reportId), output: c.outputReports.map((r) => r.reportId), feature: c.featureReports.map((r) => r.reportId),
    }))),
  };
  if (!dev.dev) return diag;
  try {
    diag.identity = dev.info || await dev.identify();
    await dev.withControl(async () => {
      diag.flash = toHex(await dev.readFlash(0, DIAG_LENGTH));
      diag.extras = await dev.readExtras();
    });
  } catch (e) {
    diag.error = e.message;
  }
  return diag;
}

// 지원하지 않는 기기를 고른 경우: 진단 파일을 저장할지 묻고, 연결은 하지 않는다.
async function offerDiagnostics(devices, dev, reason) {
  const ok = await ask(t('지원하지 않는 기종'), [
    reason,
    t('이 기종을 지원 목록에 추가하는 데 필요한 진단 정보를 파일로 저장할 수 있습니다. 기기에서 값을 읽기만 하고 아무것도 쓰지 않습니다.'),
  ], t('진단 파일 저장'));
  if (ok) download(await collectDiagnostics(devices, dev), 'diagnostics', devices[0].productName || 'device');
  throw new Error(reason);
}

export async function exportDiagnostics() {
  let diag;
  const done = await busy(t('진단 정보 읽는 중…'), async () => { diag = await collectDiagnostics(cx.dev.devices, cx.dev); });
  if (done) download(diag, 'diagnostics', deviceName());
}

export async function connect(devices) {
  const dev = new C.CompxDevice(devices);
  if (!dev.dev) {
    await offerDiagnostics(devices, dev, t('{name}: 설정용 인터페이스(리포트 8)가 없는 기종이라 아직 지원하지 않습니다.', { name: devices[0].productName || t('이 기기') }));
  }
  cx.dev = dev;
  await dev.open();
  cx.info = await dev.identify();
  cx.model = C.modelFor(dev.vendorId, cx.info.cid, cx.info.mid);
  if (!cx.model) {
    await offerDiagnostics(devices, dev, t('{name}: 아직 지원하지 않는 기종입니다 (식별값 {id}). 기종에 따라 DPI 저장 방식이 달라서 확인된 기종만 연결합니다.',
      { name: dev.name, id: `${cx.info.cid},${cx.info.mid}` }));
  }
  const { image, extras } = await dev.withControl(async () => ({
    image: await dev.readFlash(0, C.IMAGE_LENGTH),
    extras: await dev.readExtras(),
  }));
  // 읽은 값이 이 구조로 말이 되는지 확인한다. 아니면 다른 구조의 기기이므로 건드리지 않는다.
  const m = C.parse(image, cx.model);
  const sane = C.RATES.includes(m.rate) && m.stageCount >= 1 && m.stageCount <= m.maxStages && m.currentStage < m.stageCount
    && (!cx.model.lod || cx.model.lod.some(([v]) => v === m.lod)) && image[C.FLASH.reportRate + 1] === C.check(image[C.FLASH.reportRate]);
  if (!sane) throw new Error(t('{name}: 설정 데이터가 알려진 구조와 맞지 않아 지원하지 않는 기기입니다.', { name: dev.name }));
  Object.assign(cx, { extras, orig: image, work: image.slice(), stageLimit: m.stageCount, tab: 'overview', unlock: false });
}

export async function disconnect() {
  if (cx.dev) await cx.dev.close().catch(() => {});
  Object.assign(cx, { dev: null, info: null, model: null, extras: null, orig: null, work: null, unlock: false });
}

// 프로필마다 설정 이미지가 따로 있으므로, 바꾼 뒤 이미지를 다시 읽는다.
async function switchProfile(index) {
  if (!canEdit() || !cx.model.profiles || cx.extras.profile === null || app.busy) return;
  if (index === cx.extras.profile) return;
  if (isDirty()) {
    const ok = await ask(t('프로필 전환'), [t('저장하지 않은 변경 사항이 있습니다. 프로필을 바꾸면 이 변경 사항은 사라집니다.')], t('버리고 전환'));
    if (!ok) return;
  }
  const done = await busy(t('프로필 전환 중…'), () => cx.dev.withControl(async () => {
    await cx.dev.setProfile(index);
    const image = await cx.dev.readFlash(0, C.IMAGE_LENGTH);
    const extras = await cx.dev.readExtras();
    Object.assign(cx, { extras, orig: image, work: image.slice(), stageLimit: C.parse(image, cx.model).stageCount });
    if (extras.profile !== index) throw new Error(t('기기가 프로필 전환을 확인하지 않았습니다. 현재 상태를 다시 읽었습니다.'));
  }));
  if (done) toast(t('프로필 {n}(으)로 전환했습니다.', { n: cx.extras.profile + 1 }), 'ok');
  shell.refresh();
}

// 프로필 카드 줄. 프로필 전환을 지원하지 않는 기기에서는 false를 돌려주고 아무것도 그리지 않는다.
export function renderProfiles(root) {
  if (cx.extras.profile === null || !cx.model.profiles) {
    root.replaceChildren();
    return false;
  }
  root.replaceChildren(...[...Array(C.PROFILE_COUNT).keys()].map((i) => h('button', {
    type: 'button', disabled: !canEdit(), 'aria-pressed': String(i === cx.extras.profile),
    class: 'profile' + (i === cx.extras.profile ? ' selected' : ''),
    onclick: () => switchProfile(i),
  },
    h('span', { class: 'profile-main' },
      h('span', { class: 'profile-name' }, t('프로필 {n}', { n: i + 1 })),
      h('span', { class: 'profile-sub' }, i === cx.extras.profile ? t('사용 중') : t('눌러서 전환'))))));
  return true;
}

// 홈 카드와 상태 줄에 쓰는 요약 (기기에 저장된 값 기준)
export function summary() {
  const m = C.parse(cx.orig, cx.model);
  return {
    name: deviceName(),
    modeText: cx.info.wired ? t('유선 연결') : t('무선 연결'),
    dpi: m.stages[m.currentStage], rate: m.rate,
    profileLabel: cx.extras.profile !== null ? t('프로필 {n}', { n: cx.extras.profile + 1 }) : null,
    battery: cx.extras.battery,
  };
}

export function revert() {
  cx.work.set(cx.orig);
  shell.refresh();
}

export async function save() {
  const runs = C.diffRuns(cx.orig, cx.work);
  if (!runs.length || !canEdit()) return;
  const m = C.parse(cx.work, cx.model);
  if (!m.keys.some((k) => k.cls === 1 && k.param === 0x0100)) {
    return toast(t('왼쪽 클릭이 어느 버튼에도 할당되어 있지 않습니다. 한 버튼에는 왼쪽 클릭을 남겨 두세요.'), 'error');
  }
  const ok = await ask(t('기기에 저장'), [
    t('변경된 설정을 {name}의 메모리에 씁니다.', { name: deviceName() }),
    t('쓰는 동안 기기를 분리하거나 전원을 끄지 마세요.'),
  ], t('저장'));
  if (!ok) return;
  const done = await busy(t('저장 중…'), () => cx.dev.withControl(async () => {
    for (const run of runs) await cx.dev.writeFlash(run.address, run.bytes);
    const back = await cx.dev.readFlash(0, C.IMAGE_LENGTH);
    // 실제로 기록된 상태를 기준으로 삼는다. 기기가 받아들이지 않은 값은 변경 사항으로 남는다.
    cx.orig = back;
    if (C.diffRuns(back, cx.work).length) throw new Error(t('일부 값이 기기에 반영되지 않았습니다. 화면에 남은 변경 사항을 확인하세요.'));
  }));
  if (done) toast(t('저장했습니다.'), 'ok');
  shell.refresh();
}

// ---------- 백업 ----------

// 지금 프로필에 저장된 설정 이미지를 파일로 남긴다. 불러올 때는 화면에서 편집할 수 있는 값만 옮기고,
// 그 밖의 바이트는 기기에서 읽은 값을 그대로 둔다. 기록은 「기기에 저장」을 눌러야 한다.
const BACKUP_TYPE = 'gomm-compx-backup';
const fromHex = (hex) => Uint8Array.from(String(hex).match(/../g) || [], (b) => parseInt(b, 16));

export function exportBackup() {
  download({
    type: BACKUP_TYPE, version: 1, device: deviceName(), exportedAt: new Date().toISOString(),
    vendorId: cx.dev.vendorId, cid: cx.info.cid, mid: cx.info.mid, profile: cx.extras.profile, image: toHex(cx.orig),
  }, 'settings', deviceName());
  if (isDirty()) toast(t('기기에 저장된 설정을 내보냈습니다. 저장하지 않은 편집 내용은 들어 있지 않습니다.'), 'ok');
}

// 백업 이미지에서 옮길 [주소, 바이트 수] 목록. 값이 하나뿐인 항목은 검사 바이트까지 2바이트다.
function backupRanges(m, cur) {
  const F = C.FLASH;
  const pair = (a) => [a, 2];
  const ranges = [pair(F.reportRate), pair(F.stageCount), pair(F.currentStage), [F.dpi, 4 * m.stageCount],
    [F.keys, 4 * C.BUTTON_NAMES.length], pair(F.debounce), pair(F.motionSync), pair(F.angleSnap), pair(F.ripple),
    pair(F.sleep), pair(F.performanceTime)];
  if (cx.model.lod) ranges.push(pair(F.lod));
  if (cx.model.lighting && m.hasDpiLight && cur.hasDpiLight) ranges.push([F.dpiColor, 4 * m.stageCount], [F.dpiLightMode, 8]);
  return ranges;
}

function checkBackup(b) {
  if (b.type !== BACKUP_TYPE || typeof b.image !== 'string') throw new Error(t('GOMM VGN·ATK 설정 백업 파일이 아닙니다.'));
  if (b.vendorId !== cx.dev.vendorId || b.cid !== cx.info.cid || b.mid !== cx.info.mid) {
    throw new Error(t('이 기종과 맞지 않는 백업입니다 ({device}).', { device: b.device || t('알 수 없는 기기') }));
  }
  const img = fromHex(b.image);
  if (img.length !== C.IMAGE_LENGTH) throw new Error(t('백업 데이터가 손상되었습니다.'));
  const m = C.parse(img, cx.model);
  const cur = C.parse(cx.work, cx.model);
  const F = C.FLASH;
  const scalars = [F.reportRate, F.stageCount, F.currentStage, F.debounce, F.motionSync, F.angleSnap, F.ripple, F.sleep, F.performanceTime];
  const stages = m.stages.slice(0, m.stageCount);
  const problems = [
    !scalars.every((a) => img[a + 1] === C.check(img[a])) && '검사 바이트',
    !(C.RATES.includes(m.rate) && m.rate <= maxRate()) && '보고율',
    !(m.stageCount >= 1 && m.stageCount <= Math.min(cx.stageLimit, cur.maxStages) && m.currentStage < m.stageCount) && 'DPI 단계 수',
    !stages.every((d) => d !== null && d >= cx.model.dpiMin && d <= cx.model.dpiMax) && 'DPI 값',
    // 선택지에 없더라도 이 기기에 지금 저장돼 있는 값과 같으면 받는다 (화면에서 「기타」로 보이는 값).
    cx.model.lod && !(cx.model.lod.some(([v]) => v === m.lod) || m.lod === cur.lod) && '리프트오프 거리',
    !(cx.model.debounce.includes(m.debounce) || m.debounce === cur.debounce) && '디바운스',
    !(cx.model.sleep.some(([v]) => v === m.sleep) || m.sleep === cur.sleep) && '자동 절전',
    ![F.motionSync, F.angleSnap, F.ripple].every((a) => img[a] <= 1) && '센서 설정',
    cx.model.lighting && m.hasDpiLight && !m.dpiColors.slice(0, m.stageCount).every(Boolean) && '표시등 색',
    !m.keys.some((k) => k.cls === 1 && k.param === 0x0100) && '왼쪽 클릭',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(t('이 기기에 맞지 않는 값이 있어 불러오지 않았습니다: {items}', { items: problems.map((p) => t(p)).join(', ') }));
  }
  return { img, m, cur };
}

export async function importBackup(file) {
  try {
    if (!canEdit()) throw new Error(t('편집을 허용한 뒤에 불러올 수 있습니다.'));
    const b = JSON.parse(await file.text());
    const { img, m, cur } = checkBackup(b);
    for (const [address, length] of backupRanges(m, cur)) cx.work.set(img.subarray(address, address + length), address);
    toast(b.profile !== null && b.profile !== cx.extras.profile
      ? t('설정을 불러왔습니다 (프로필 {n}에서 내보낸 백업). 「기기에 저장」을 눌러야 기기에 반영됩니다.', { n: b.profile + 1 })
      : t('설정을 불러왔습니다. 「기기에 저장」을 눌러야 기기에 반영됩니다.'), 'ok');
  } catch (e) {
    toast(e instanceof SyntaxError ? t('백업 파일을 읽지 못했습니다.') : e.message, 'error');
  }
  shell.refresh();
}

// ---------- 화면 ----------

function edited(rerender = true) {
  shell.refreshActions();
  if (rerender) render(document.querySelector('#editor'));
}

const scalar = (address) => (v) => { C.setScalar(cx.work, address, v); edited(); };
const toggle = (title, desc, checked, address) => h('label', { class: 'hits-toggle' },
  h('div', null, h('div', { class: 'hits-title' }, title), h('div', { class: 'hits-desc' }, desc)),
  h('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => scalar(address)(e.target.checked ? 1 : 0) }));
// 목록에 없는 값이 저장돼 있으면 그대로 보여 주는 선택지를 덧붙인다.
const withCurrent = (options, current) => (options.some(([v]) => v === current) ? options : [...options, [current, t('기타 ({value})', { value: current })]]);

function renderOverview(m) {
  const b = cx.extras.battery;
  return h('div', null,
    h('div', { class: 'stat-grid' },
      tile(t('현재 DPI'), m.stages[m.currentStage] ? num(m.stages[m.currentStage]) : '–', t('{count}단계 중 {n}단계', { count: m.stageCount, n: m.currentStage + 1 })),
      tile(t('보고율'), m.rate ? `${num(m.rate)} Hz` : '–', cx.info.wired ? t('유선') : t('무선')),
      tile(t('배터리'), b ? `${b.percent}%` : '–', b && b.charging ? t('충전 중') : null),
      tile(t('디바운스'), `${m.debounce} ms`, null)),
    h('p', { class: 'hint' }, t('값을 바꾸려면 위의 「성능」과 「버튼」 탭을 여세요. 변경 내용은 「기기에 저장」을 누르기 전까지 기기에 기록되지 않습니다.')));
}

function renderPerformance(m) {
  const rates = C.RATES.filter((r) => r <= maxRate()).map((r) => [C.encodeRate(r), r >= 1000 ? `${r / 1000}K` : String(r)]);
  const setStageCount = (n) => {
    C.setScalar(cx.work, C.FLASH.stageCount, n);
    if (m.currentStage >= n) C.setScalar(cx.work, C.FLASH.currentStage, n - 1);
    edited();
  };
  const step = cx.model.dpiStep || C.DPI_STEP;
  const rows = m.stages.slice(0, m.stageCount).map((dpi, i) => {
    const stageName = t('{n}단계', { n: i + 1 });
    const number = h('input', {
      type: 'number', min: cx.model.dpiMin, max: cx.model.dpiMax, step, value: dpi, 'aria-label': t('{stage} DPI', { stage: stageName }),
      onchange: (e) => { C.setDpi(cx.work, i, C.snapDpi(Number(e.target.value) || cx.model.dpiMin, cx.model), cx.model); edited(); },
    });
    return h('div', { class: 'dpi-row' },
      h('span', { class: 'dpi-idx' }, stageName),
      h('input', {
        type: 'range', min: cx.model.dpiMin, max: Math.max(cx.model.dpiMax, dpi), step, value: dpi, 'aria-label': t('{stage} DPI 슬라이더', { stage: stageName }),
        oninput: (e) => { const v = C.snapDpi(Number(e.target.value), cx.model); C.setDpi(cx.work, i, v, cx.model); number.value = v; edited(false); },
      }),
      number,
      h('label', null, h('input', { type: 'radio', name: 'cx-stage', checked: i === m.currentStage, onchange: () => scalar(C.FLASH.currentStage)(i) }), ' ' + t('현재')));
  });
  return h('div', null,
    field(t('보고율'), 'Hz', choice(t('보고율'), withCurrent(rates, cx.work[C.FLASH.reportRate]), cx.work[C.FLASH.reportRate], false, scalar(C.FLASH.reportRate))),
    cx.model.lod
      ? field(t('리프트오프 거리'), null, choice(t('리프트오프 거리'), withCurrent(translated(cx.model.lod), m.lod), m.lod, false, scalar(C.FLASH.lod)))
      : field(t('리프트오프 거리'), null, choice(t('리프트오프 거리'), [[m.lod, t('저장 값 {value}', { value: m.lod })]], m.lod, true, () => {})),
    h('p', { class: 'hint field-desc' }, cx.model.lod
      ? t('마우스를 들어 올렸을 때 추적이 멈추는 높이입니다.')
      : t('마우스를 들어 올렸을 때 추적이 멈추는 높이입니다. 이 기종은 저장 값이 뜻하는 거리가 확인되지 않아 바꿀 수 없습니다.')),
    h('h3', null, t('DPI 단계 ({min}~{max})', { min: num(cx.model.dpiMin), max: num(cx.model.dpiMax) })),
    rows,
    h('div', { class: 'row-actions' },
      h('button', { disabled: m.stageCount >= Math.min(cx.stageLimit, m.maxStages), onclick: () => setStageCount(m.stageCount + 1) }, t('+ 단계 추가')),
      h('button', { class: 'ghost', disabled: m.stageCount <= 1, onclick: () => setStageCount(m.stageCount - 1) }, t('마지막 단계 빼기'))),
    h('h3', null, t('센서')),
    h('div', { class: 'toggle-list' },
      toggle(t('모션 싱크'), t('센서 판독을 보고 주기에 맞춥니다.'), m.motionSync, C.FLASH.motionSync),
      toggle(t('각도 스냅'), t('직선에 가까운 움직임을 곧게 보정합니다.'), m.angleSnap, C.FLASH.angleSnap),
      toggle(t('리플 컨트롤'), t('높은 DPI에서 생기는 미세한 떨림을 줄입니다.'), m.ripple, C.FLASH.ripple)));
}

function renderButtons(m) {
  const debounce = cx.model.debounce.map((v) => [v, String(v)]);
  return h('div', null,
    field(t('디바운스'), 'ms', choice(t('디바운스'), withCurrent(debounce, m.debounce), m.debounce, false, scalar(C.FLASH.debounce))),
    h('p', { class: 'hint field-desc' }, t('클릭 뒤 이 시간 동안은 같은 버튼의 추가 입력을 무시합니다. 더블클릭(채터링)이 생기면 값을 올리고, 반응을 빠르게 하려면 낮춥니다.')),
    h('table', { class: 'buttons' },
      h('thead', null, h('tr', null, [t('버튼'), t('현재 동작'), t('바꿀 동작')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, m.keys.map((key, i) => {
        const known = C.KEY_ACTIONS.findIndex(([cls, param]) => cls === key.cls && param === key.param);
        const name = t(C.BUTTON_NAMES[i]);
        return h('tr', null,
          h('th', { class: 'btn-idx', scope: 'row' }, name),
          h('td', { class: 'btn-desc' }, keyLabel(key)),
          h('td', null, h('select', {
            'aria-label': t('{button} 바꿀 동작', { button: name }),
            onchange: (e) => { const [cls, param] = C.KEY_ACTIONS[Number(e.target.value)]; C.setKey(cx.work, i, cls, param); edited(); },
          },
            known < 0 && h('option', { value: -1, selected: true, disabled: true }, keyLabel(key)),
            C.KEY_ACTIONS.map(([, , label], idx) => h('option', { value: idx, selected: idx === known }, t(label))))));
      }))));
}

// 버튼 동작 이름. 표에 없는 값은 원래 바이트를 보여 준다.
function keyLabel(key) {
  const known = C.KEY_ACTIONS.find(([cls, param]) => cls === key.cls && param === key.param);
  return known ? t(known[2]) : t('기타 ({value})', { value: `${key.cls}:0x${key.param.toString(16).padStart(4, '0')}` });
}

const toHexColor = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHexColor = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16));

// DPI 표시등: DPI 단계를 바꿀 때 켜지는 작은 등의 동작과 단계별 색
function renderLighting(m) {
  if (!m.hasDpiLight) return h('p', { class: 'empty' }, t('이 기기에서는 표시등 설정을 읽을 수 없습니다.'));
  const light = m.dpiLight;
  const levels = [...Array(C.BRIGHTNESS.length).keys()].map((i) => [i + 1, String(i + 1)]);
  const speeds = [...Array(C.DPI_LIGHT_SPEED_MAX).keys()].map((i) => [i + 1, String(i + 1)]);
  const off = light.kind === 'off';
  return h('div', null,
    field(t('DPI 표시등'), null, choice(t('DPI 표시등'), translated(C.DPI_LIGHT), light.kind, false, (kind) => { C.setDpiLightKind(cx.work, kind); edited(); })),
    h('p', { class: 'hint field-desc' }, t('DPI 단계를 알려 주는 표시등입니다. 끄면 배터리를 조금 아낄 수 있습니다.')),
    field(t('밝기'), null, choice(t('밝기'), light.brightness ? levels : [[0, t('기타')], ...levels], light.brightness, off,
      (level) => scalar(C.FLASH.dpiLightBrightness)(C.BRIGHTNESS[level - 1]))),
    field(t('숨쉬기 속도'), null, choice(t('숨쉬기 속도'), withCurrent(speeds, light.speed), light.speed, light.kind !== 'breathing', scalar(C.FLASH.dpiLightSpeed))),
    h('h3', null, t('단계별 색')),
    h('div', { class: 'color-list' }, m.stages.slice(0, m.stageCount).map((dpi, i) => {
      const color = m.dpiColors[i];
      return h('label', { class: 'color-item' },
        h('input', {
          type: 'color', value: color ? toHexColor(color) : '#000000', disabled: !color, 'aria-label': t('{n}단계 색', { n: i + 1 }),
          onchange: (e) => { C.setDpiColor(cx.work, i, fromHexColor(e.target.value)); edited(); },
        }),
        h('span', null, h('b', null, t('{n}단계', { n: i + 1 })), h('small', null, `${num(dpi)} DPI`)));
    })),
    h('p', { class: 'hint' }, t('본체 조명(RGB)이 있는 기종의 조명 효과는 아직 지원하지 않습니다.')));
}

function renderAdvanced(m) {
  // 절전 시간은 두 주소(절전, 성능 모드 시간)에 같은 값으로 저장된다.
  const setSleep = (v) => { C.setScalar(cx.work, C.FLASH.sleep, v); C.setScalar(cx.work, C.FLASH.performanceTime, v); edited(); };
  const info = [
    [t('기기'), deviceName()],
    [t('연결 장치 이름'), cx.dev.name],
    [t('연결'), cx.info.wired ? t('유선') : t('무선 (수신기)')],
    [t('최대 보고율'), `${num(maxRate())} Hz`],
    [t('펌웨어'), [cx.extras.firmware && t('마우스 {version}', { version: cx.extras.firmware }),
      cx.extras.dongleFirmware && t('수신기 {version}', { version: cx.extras.dongleFirmware })].filter(Boolean).join(', ') || t('알 수 없음')],
    [t('기기 식별값'), t('CID 0x{cid} · MID 0x{mid} · 종류 {type}', { cid: cx.info.cid.toString(16), mid: cx.info.mid.toString(16), type: cx.info.type })],
  ];
  return h('div', null,
    field(t('자동 절전'), null, choice(t('자동 절전'), withCurrent(translated(cx.model.sleep), m.sleep), m.sleep, false, setSleep)),
    h('p', { class: 'hint field-desc' }, t('이 시간 동안 움직임이 없으면 마우스가 절전 상태로 들어갑니다.')),
    h('h3', null, t('기기 정보')),
    h('table', { class: 'info' }, info.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v)))));
}

export function render(root) {
  const m = C.parse(cx.work, cx.model);
  const tabList = [['overview', t('개요')], ['performance', t('성능')], ['buttons', t('버튼')], cx.model.lighting && ['lighting', t('조명')], ['advanced', t('고급')]].filter(Boolean);
  if (cx.tab === 'lighting' && !cx.model.lighting) cx.tab = 'overview';
  const body = cx.tab === 'performance' ? renderPerformance(m) : cx.tab === 'buttons' ? renderButtons(m)
    : cx.tab === 'lighting' ? renderLighting(m) : cx.tab === 'advanced' ? renderAdvanced(m) : renderOverview(m);
  // 확인하지 못한 기종은 편집을 허용하기 전까지 값을 보여 주기만 한다.
  if (!canEdit()) for (const el of body.querySelectorAll('input, select, button')) el.disabled = true;
  const notice = cx.model.verified === false && h('div', { class: 'notice' }, h('label', null,
    h('input', { type: 'checkbox', checked: cx.unlock, onchange: (e) => { cx.unlock = e.target.checked; if (!cx.unlock) cx.work.set(cx.orig); shell.refresh(); } }),
    ' ' + t('이 기종({name})은 실제 기기로 확인하지 못했고, ATK HUB의 기종표에 따라 해석했습니다. 화면의 DPI 단계·보고율·디바운스·버튼 값이 ATK HUB와 같은 것을 확인했고, 편집을 허용합니다. 값이 다르면 체크하지 말고 「진단 정보 내보내기」로 저장한 파일을 보내 주세요.', { name: deviceName() })));
  root.replaceChildren(...[
    notice,
    h('div', { class: 'editor-head' }, h('h2', null, deviceName())),
    tabs(tabList, cx.tab, (id) => { cx.tab = id; render(root); }, t('기기 설정 항목')),
    tabPanel(cx.tab, body)].filter(Boolean));
}
