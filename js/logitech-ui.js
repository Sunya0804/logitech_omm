// Logitech G(HID++ 2.0 온보드 프로필, 기능 0x8100) 기기의 설정 화면.
// 프로필 섹터를 읽어 사본을 고치고, 「기기에 저장」을 누르면 섹터를 쓴 뒤 다시 읽어 대조한다.
import * as P from './profile.js';
import * as K from './keys.js';
import * as M from './macro.js';
import { stopRecording, macroSummary, macroEditor as editorPanel } from './macro-editor.js';
import { MODE, FEATURE, HidppError, Hidpp, OnboardProfiles, WebHidTransport } from './hidpp.js';
import { t, num } from './i18n.js';
import { $, h, toast, ask, busy, download, choice, tabs, tabPanel, tile, field, shell } from './ui.js';

// 실기기로 읽어 본 프로필 형식: 4는 PRO X Wireless, 5는 G502 X PLUS, 7은 PRO X 2 DEX. 1~3은 같은 구조다.
// 8(SUPERSTRIKE)은 직접 읽어 보지는 못했지만 공개된 실기기 덤프와 구조가 일치한다.
// 나머지(6, 10)는 공식 OMM의 구조 정보만 따른 것이라 사용자가 동의해야 편집을 연다.
const DEVICE_VERIFIED_FORMATS = [1, 2, 3, 4, 5, 7, 8];
const LAYOUT_NAMES = {
  classic: '기본 구조', classicDpiY: '기본 구조 + 세로 DPI', extendedBasic: '확장 구조', extended: '확장 구조', analog: '확장 구조 + HITS',
};
const LOD_LEVELS = [[1, '낮음'], [2, '중간'], [3, '높음']];
const BUNNY_HOP_MS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const ANALOG_BUTTON_NAMES = ['좌클릭', '우클릭'];
const EXTENDED_RATE_INDEXES = [0, 1, 2, 3, 4, 5, 6]; // 값 = 인덱스, 125 << i Hz
const DEFAULT_DPI_RANGE = { min: 100, max: 25600, step: 50 };
const ROM_BASE = 0x0100;
// 기기가 아날로그 버튼의 단계 수를 알려 주지 않을 때 쓰는 값 (PRO X2 SUPERSTRIKE의 G HUB 기준)
const DEFAULT_ANALOG_CAPS = { actuationMax: 10, hapticMax: 5, rtMax: 5 };
const ISSUE_URL = 'https://github.com/Sunya0804/logitech_omm/issues/new';
// 해석할 수 있는 매크로 형식 번호 (js/macro.js)
const MACRO_FORMAT = 1;

export const filters = WebHidTransport.filters;

const st = {
  transport: null, hidpp: null, op: null,
  name: '', battery: null, desc: null, dpiRange: DEFAULT_DPI_RANGE, rateIndexes: null, analogCaps: null, layout: null,
  profiles: [], dirValid: false, crcTrusted: false,
  current: 0, mode: MODE.ONBOARD,
  selected: 0, tab: 'overview', layer: 'buttons', unlock: false,
  // macroSectors: 읽어 둔 매크로 섹터(번호 → 바이트), macroEdit: 편집 중인 매크로 {index, layer, i}
  macroSectors: new Map(), macroEdit: null,
};

// ---------- 연결 / 읽기 ----------

export const transportFor = (devices) => new WebHidTransport(devices);

export async function connect(transport, setMsg) {
  if (transport instanceof WebHidTransport && !transport.out) throw new Error(t('선택한 기기에서 HID++ 인터페이스(리포트 0x11)를 찾지 못했습니다.'));
  await transport.open();
  st.transport = transport;
  const hidpp = (st.hidpp = new Hidpp(transport));
  if (!(await hidpp.probe())) {
    throw new Error(t('HID++ 2.0 기기가 응답하지 않습니다. 무선 기기라면 전원이 켜져 있는지 확인하세요.'));
  }
  st.name = (await hidpp.getName()) || transport.name || t('Logitech 기기');
  const featIdx = await hidpp.getFeature(FEATURE.ONBOARD_PROFILES);
  if (!featIdx) throw new Error(t('{name}: 온보드 메모리(HID++ 0x8100)를 지원하지 않는 기기입니다.', { name: st.name }));
  st.op = new OnboardProfiles(hidpp, featIdx);
  st.battery = await hidpp.getBattery().catch(() => null);
  st.dpiRange = (await hidpp.getDpiRange().catch(() => null)) || DEFAULT_DPI_RANGE;
  st.rateIndexes = await hidpp.getReportRateIndexes().catch(() => null);
  st.analogCaps = await hidpp.getAnalogCapabilities().catch(() => null);
  hidpp.onEvent = (idx, fn, params) => {
    if (idx !== featIdx || fn !== 0) return;
    st.current = (params[0] << 8) | params[1];
    renderProfiles($('#sidebar'));
  };
  await loadProfiles(setMsg || (() => {}));
}

// 배터리 잔량만 다시 읽는다. 연결할 때 잔량을 읽지 못한 기기는 묻지 않는다. 새 값을 받았으면 true.
export async function refreshBattery() {
  const hidpp = st.hidpp;
  if (!hidpp || !st.battery) return false;
  const battery = await hidpp.getBattery({ timeout: 1000 }).catch(() => null);
  if (!battery || st.hidpp !== hidpp) return false;
  st.battery = battery;
  return true;
}

export async function disconnect() {
  stopRecording();
  if (st.transport) await st.transport.close().catch(() => {});
  Object.assign(st, { transport: null, hidpp: null, op: null, desc: null, layout: null, profiles: [], selected: 0, unlock: false, macroSectors: new Map(), macroEdit: null });
}

async function loadProfiles(setMsg) {
  const op = st.op;
  const d = (st.desc = await op.getDescription());
  st.mode = await op.getMode();
  st.crcTrusted = false;

  // CRC가 맞는 섹터만 돌려준다. 맞는 섹터를 하나라도 읽으면 CRC 구현이 이 기기와 일치함이 확인된다.
  const readValid = async (sector) => {
    try {
      const data = await op.readSector(sector, d.sectorSize);
      if (!P.hasValidCrc(data)) return null;
      st.crcTrusted = true;
      return data;
    } catch (e) {
      if (e instanceof HidppError) return null;
      throw e;
    }
  };

  setMsg(t('프로필 목록 읽는 중…'));
  const dirSector = await readValid(0x0000);
  const dir = dirSector && P.parseDirectory(dirSector, d.profileCount);
  st.dirValid = !!dir;

  const profiles = [];
  for (let i = 0; i < d.profileCount; i++) {
    setMsg(t('프로필 {n}/{total} 읽는 중…', { n: i + 1, total: d.profileCount }));
    const entry = dir && dir[i];
    let source = 'user';
    let sector = entry ? entry.sector : i + 1;
    let raw = entry ? await readValid(sector) : null;
    if (!raw) {
      // 사용자 영역이 비어 있으면 기기는 ROM(공장 초기값) 프로필을 쓴다.
      source = 'rom';
      sector = ROM_BASE + (i < d.profileCountOob ? i + 1 : 1);
      raw = await readValid(sector);
    }
    const enabled = entry ? entry.enabled : !dir && i < Math.max(1, d.profileCountOob);
    // pending: 저장 전인 매크로 편집본 ('층:버튼' → 단계들)
    profiles.push({ index: i, sector, source, raw, orig: raw && raw.slice(), enabled: !!raw && enabled, origEnabled: !!raw && enabled, pending: new Map() });
  }
  st.profiles = profiles;
  const sample = profiles.find((p) => p.raw);
  st.layout = sample ? P.detectLayout(sample.raw, d.profileFormatId, d.buttonCount, st.dpiRange) : null;
  await loadMacros(setMsg);
  st.current = await op.getCurrentProfile();
  if (st.selected >= profiles.length) st.selected = 0;
  const cur = profiles.findIndex(isCurrent);
  if (cur >= 0) st.selected = cur;
}

// ---------- 매크로 ----------

const macroSupported = () => layoutKnown() && st.desc.macroFormatId === MACRO_FORMAT;
const macroKey = (layer, i) => `${layer}:${i}`;
const layers = () => (st.desc.hasGShift ? ['buttons', 'gshift'] : ['buttons']);
const buttonCountOf = (layer) => Math.min(st.desc.buttonCount, layer === 'gshift' ? st.layout.maxGShift : st.layout.maxButtons);

// 프로필 데이터 raw에 걸려 있는 매크로 위치들: [{layer, i, sector, offset}]
function macroTargets(raw) {
  const out = [];
  if (!raw) return out;
  for (const layer of layers()) {
    for (let i = 0; i < buttonCountOf(layer); i++) {
      const target = M.macroTarget(P.getBinding(raw, st.layout, layer, i));
      if (target) out.push({ layer, i, ...target });
    }
  }
  return out;
}

// 매크로가 들어갈 수 있는 섹터: 디렉터리(0)와 프로필 섹터를 뺀 사용자 영역
const isProfileSector = (n) => n === 0 || st.profiles.some((p) => p.source === 'user' && p.sector === n) || (n >= 1 && n <= st.desc.profileCount);
const macroSectorOk = (n) => n > 0 && n < st.desc.sectorCount && !isProfileSector(n);

// 버튼 할당이 가리키는 매크로를 읽어 둔 섹터들로 해석한다.
function storedMacro(target) {
  if (!macroSectorOk(target.sector)) return { steps: [], sectors: [], error: 'sector', editable: false };
  return M.readMacro((n) => (macroSectorOk(n) ? st.macroSectors.get(n) ?? null : null), target, st.desc.sectorSize);
}

// 모든 프로필의 매크로가 쓰는 섹터를 읽는다 (점프로 이어지는 섹터 포함).
async function loadMacros(setMsg) {
  st.macroSectors = new Map();
  if (!macroSupported()) return;
  const tried = new Set();
  for (const p of st.profiles) {
    for (const target of macroTargets(p.raw)) {
      for (let r = storedMacro(target); r.error === 'unreadable' && !tried.has(r.missing); r = storedMacro(target)) {
        tried.add(r.missing);
        if (!macroSectorOk(r.missing)) break;
        setMsg(t('매크로 읽는 중…'));
        try {
          st.macroSectors.set(r.missing, await st.op.readSector(r.missing, st.desc.sectorSize));
        } catch (e) {
          if (!(e instanceof HidppError)) throw e;
          break;
        }
      }
    }
  }
}

// 새 매크로를 기록할 빈 섹터 count개. 어느 프로필(저장 전·후 모두)도 쓰지 않고 내용이 모두 0xFF인 섹터만 고른다.
async function freeMacroSectors(count, setMsg) {
  const used = new Set();
  for (const p of st.profiles) {
    for (const raw of [p.raw, p.orig]) for (const target of macroTargets(raw)) storedMacro(target).sectors.concat(target.sector).forEach((n) => used.add(n));
  }
  const free = [];
  for (let n = st.desc.profileCount + 1; n < st.desc.sectorCount && free.length < count; n++) {
    if (used.has(n) || !macroSectorOk(n)) continue;
    setMsg(t('빈 공간 찾는 중…'));
    const data = await st.op.readSector(n, st.desc.sectorSize).catch((e) => { if (e instanceof HidppError) return null; throw e; });
    if (data && data.every((b) => b === 0xff)) free.push(n);
  }
  if (free.length < count) throw new Error(t('매크로를 기록할 빈 공간이 기기에 없습니다. 매크로 수를 줄여 보세요.'));
  return free;
}

const sameSteps = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 매크로 편집본을 정한다. 기기에 저장된 것과 같아지면 편집본을 지운다.
function setPending(p, layer, i, steps) {
  const key = macroKey(layer, i);
  const target = M.macroTarget(P.getBinding(p.raw, st.layout, layer, i));
  const stored = target && storedMacro(target);
  if (stored && stored.editable && sameSteps(stored.steps, steps)) p.pending.delete(key);
  else p.pending.set(key, steps);
}

// 버튼에 걸린 매크로의 지금 단계들 (편집본이 있으면 편집본). 해석할 수 없으면 null.
function currentMacro(p, layer, i) {
  const pending = p.pending.get(macroKey(layer, i));
  if (pending) return { steps: pending, editable: true, error: null, pending: true };
  const target = M.macroTarget(P.getBinding(p.raw, st.layout, layer, i));
  return target ? { ...storedMacro(target), pending: false } : null;
}

// ---------- 상태 판정 ----------

export const connected = () => !!st.desc;
export const ownsDevice = (device) => !!st.transport?.devices?.includes(device);
const isCurrent = (p) => (st.current & 0xff) === p.index + 1;
const profileDirty = (p) => !!p.raw && (!P.sameData(p.raw, p.orig) || p.enabled !== p.origEnabled || p.pending.size > 0);
const needsSectorWrite = (p) => !!p.raw && (p.source !== 'user' || p.sector !== p.index + 1 || !P.sameData(p.raw, p.orig));
const layoutKnown = () => !!st.layout;
const formatVerified = () => layoutKnown() && DEVICE_VERIFIED_FORMATS.includes(st.desc.profileFormatId);
export const canEdit = () => st.crcTrusted && layoutKnown() && (formatVerified() || st.unlock);
export const isDirty = () => st.profiles.some(profileDirty);
export const dirtyText = () => {
  const n = st.profiles.filter(profileDirty).length;
  return n ? t('저장되지 않은 변경: 프로필 {n}개', { n }) : null;
};

function profileTitle(p) {
  const name = p.raw && layoutKnown() ? P.parse(p.raw, st.layout).name : '';
  return name || t('프로필 {n}', { n: p.index + 1 });
}

// ---------- 기기에 쓰는 동작 ----------

export async function save() {
  const dirty = st.profiles.filter(profileDirty);
  if (!dirty.length || !canEdit()) return;
  if (!st.profiles.some((p) => p.enabled)) return toast(t('최소 한 개의 프로필은 사용 상태여야 합니다.'), 'error');
  const macros = st.profiles.flatMap((p) => [...p.pending].map(([key, steps]) => ({ p, key, steps })));
  if (macros.some((m) => !m.steps.length)) return toast(t('비어 있는 매크로가 있습니다. 단계를 넣거나 버튼에 다른 동작을 지정하세요.'), 'error');
  stopRecording();
  const ok = await ask(t('기기에 저장'), [
    t('{profiles}의 변경 내용을 {name}의 온보드 메모리에 씁니다.', { profiles: dirty.map(profileTitle).join(', '), name: st.name }),
    t('쓰는 동안 기기를 분리하거나 전원을 끄지 마세요. 저장 전에 「백업 내보내기」로 현재 상태를 보관해 두는 것을 권장합니다.'),
    macros.length && t('매크로 기록은 아직 실제 기기로 확인하지 않은 기능입니다. 저장한 뒤 그 버튼을 눌러 동작을 확인하고, 이상하면 버튼에 다른 동작을 지정해 저장하세요.'),
  ].filter(Boolean), t('저장'));
  if (!ok) return;

  let reloadFailed = false;
  let liveFailed = false;
  const done = await busy(t('저장 중…'), async (setMsg) => {
    const { op } = st;
    const writeVerified = async (sector, data, label) => {
      setMsg(t('{label} 쓰는 중…', { label }));
      await op.writeSector(sector, data);
      const back = await op.readSector(sector, data.length);
      if (P.toHex(back) !== P.toHex(data)) throw new Error(t('{label}: 기록 후 검증에 실패했습니다. 다시 저장해 보세요.', { label }));
    };

    // 매크로는 빈 섹터에 먼저 기록하고, 그다음 버튼 할당이 그 섹터를 가리키게 해 프로필과 함께 쓴다.
    // 기존 매크로 섹터는 다른 버튼이나 프로필이 함께 쓸 수 있어 덮어쓰지 않는다.
    if (macros.length) {
      const free = await freeMacroSectors(macros.length, setMsg);
      for (const [n, { p, key, steps }] of macros.entries()) {
        const data = M.encodeMacro(steps, st.desc.sectorSize);
        await writeVerified(free[n], data, t('매크로'));
        st.macroSectors.set(free[n], data);
        const [layer, i] = key.split(':');
        P.setBinding(p.raw, st.layout, layer, Number(i), M.macroBinding(free[n]));
        p.pending.delete(key);
      }
    }

    const sectorWrites = st.profiles.filter(needsSectorWrite);
    const dirChanged = !st.dirValid || sectorWrites.some((p) => p.source !== 'user' || p.sector !== p.index + 1)
      || st.profiles.some((p) => p.enabled !== p.origEnabled);

    for (const p of sectorWrites) {
      await writeVerified(p.index + 1, P.finalize(p.raw), profileTitle(p));
      Object.assign(p, { source: 'user', sector: p.index + 1, orig: p.raw.slice() });
    }
    if (dirChanged) {
      await writeVerified(0x0000, P.buildDirectory(st.desc.sectorSize, st.profiles.map((p) => p.enabled)), t('프로필 목록'));
      st.dirValid = true;
      st.profiles.forEach((p) => (p.origEnabled = p.enabled));
    }

    // 현재 프로필을 다시 지정해야 기기가 새 내용을 불러온다. 호스트 모드에서는 온보드 프로필이
    // 쓰이지 않아 기기가 이 명령을 거부하므로 건너뛴다. 온보드 모드로 바꾸면 그때 불러온다.
    if (st.mode !== MODE.ONBOARD) return;
    const active = st.profiles.find((p) => isCurrent(p) && p.enabled) || st.profiles.find((p) => p.enabled);
    try {
      await op.setCurrentProfile(active.index + 1);
      st.current = active.index + 1;
      // HITS 값은 프로필을 다시 불러오는 것만으로 바로 바뀌는지 확인되지 않아, 현재 값으로도 직접 적용한다.
      const L = st.layout;
      if (L.analog && active.raw) {
        try {
          for (let i = 0; i < L.analog.count; i++) await st.hidpp.setAnalogLive(i, P.analogBytes(active.raw, L, i));
        } catch (e) {
          if (!(e instanceof HidppError)) throw e;
          liveFailed = true;
        }
      }
    } catch (e) {
      // 기록과 검증은 이미 끝났으므로 저장 실패로 취급하지 않는다.
      if (!(e instanceof HidppError)) throw e;
      reloadFailed = true;
    }
  });
  if (done && st.mode !== MODE.ONBOARD) toast(t('저장했습니다. 기기가 호스트 모드라서, 온보드 메모리 모드로 바꿔야 적용됩니다.'), 'ok');
  else if (done && liveFailed) toast(t('저장했습니다. HITS 값을 바로 적용하지는 못했으니, 마우스를 껐다 켜면 적용됩니다.'), 'ok');
  else if (done && reloadFailed) toast(t('저장했습니다. 기기가 프로필 다시 불러오기를 거부했으니, 마우스를 껐다 켜면 적용됩니다.'), 'ok');
  else if (done) toast(t('저장했습니다.'), 'ok');
  shell.refresh();
}

export function revert() {
  stopRecording();
  st.macroEdit = null;
  for (const p of st.profiles) {
    if (p.raw) p.raw.set(p.orig);
    p.enabled = p.origEnabled;
    p.pending.clear();
  }
  shell.refresh();
}

async function activate(p) {
  await busy(t('프로필 전환 중…'), async () => {
    await st.op.setCurrentProfile(p.sector);
    st.current = await st.op.getCurrentProfile();
  });
  shell.refresh();
}

async function setMode(mode) {
  await busy(t('모드 변경 중…'), async () => {
    await st.op.setMode(mode);
    st.mode = await st.op.getMode();
    st.current = await st.op.getCurrentProfile();
  });
  shell.refresh();
}

// ---------- 백업 ----------

export function exportBackup() {
  const { desc } = st;
  download({
    type: 'omm-web-backup', version: 1, device: st.name, exportedAt: new Date().toISOString(),
    profileFormatId: desc.profileFormatId, sectorSize: desc.sectorSize,
    profiles: st.profiles.map((p) => ({ index: p.index, enabled: p.enabled, data: p.raw ? P.toHex(P.finalize(p.raw.slice())) : null })),
    // 매크로는 기기마다 들어 있는 섹터가 달라서, 버튼별로 단계만 담는다 (한 섹터 형식, 위치 0부터).
    macros: macroSupported() ? st.profiles.filter((p) => p.raw).flatMap((p) => layers().flatMap((layer) =>
      [...Array(buttonCountOf(layer)).keys()].map((i) => {
        const m = currentMacro(p, layer, i);
        return m && m.editable && m.steps.length
          ? { index: p.index, layer, button: i, data: P.toHex(M.encodeMacro(m.steps, st.desc.sectorSize)) } : null;
      }))).filter(Boolean) : [],
  }, 'profiles', st.name);
}

// 새 기기 지원을 위한 읽기 전용 덤프: 기능 목록과 온보드 메모리의 모든 섹터.
export async function exportDiagnostics() {
  const ok = await ask(t('진단 정보 내보내기'), [
    t('기기의 기능 목록과 온보드 메모리 전체(프로필, 버튼 할당, 매크로 포함)를 읽어 파일로 저장합니다. 기기에는 아무것도 쓰지 않습니다.'),
    t('매크로에 입력해 둔 문구가 있다면 파일에 그대로 들어가니, 공유하기 전에 확인하세요.'),
  ], t('내보내기'));
  if (!ok) return;
  let diag;
  const done = await busy(t('진단 정보 읽는 중…'), async (setMsg) => {
    const { hidpp, op, desc } = st;
    const hex4 = (n) => n.toString(16).padStart(4, '0');
    const descRaw = P.toHex(await hidpp.request(op.idx, 0x0));
    const sectors = {};
    const romCount = Math.max(1, desc.profileCountOob);
    const numbers = [...Array(desc.sectorCount).keys(), ...Array.from({ length: romCount }, (_, i) => ROM_BASE + i + 1)];
    for (const n of numbers) {
      setMsg(t('섹터 0x{sector} 읽는 중…', { sector: hex4(n) }));
      try {
        sectors[hex4(n)] = P.toHex(await op.readSector(n, desc.sectorSize));
      } catch (e) {
        if (!(e instanceof HidppError)) throw e;
        sectors[hex4(n)] = `error: ${e.message}`;
      }
    }
    // 아날로그 버튼 기능(0x1B0C)이 있으면 값 범위가 담긴 첫 번째 조회 응답을 그대로 남긴다.
    const analogIdx = await hidpp.getFeature(FEATURE.ANALOG_BUTTONS);
    const analogCaps = analogIdx ? P.toHex(await hidpp.request(analogIdx, 0x0).catch(() => [])) : null;
    diag = {
      type: 'omm-web-diagnostics', version: 1, exportedAt: new Date().toISOString(),
      device: st.name, deviceIndex: hidpp.devIdx,
      features: (await hidpp.getFeatureList()).map((f) => `${f.index}:${hex4(f.id)}`),
      onboard: { ...desc, descriptionRaw: descRaw, mode: st.mode, currentProfile: hex4(await op.getCurrentProfile()) },
      dpiRange: st.dpiRange, reportRateIndexes: st.rateIndexes, analogCapabilities: analogCaps,
      detectedLayout: st.layout ? st.layout.id : null,
      sectors,
    };
  });
  if (!done) return;
  download(diag, 'diagnostics', st.name);
  const send = await ask(t('진단 정보 보내기'), [
    t('진단 파일을 저장했습니다. 이 기기를 지원 목록에 추가할 수 있도록 GitHub 이슈로 보내시겠어요?'),
    t('GitHub 계정이 필요합니다. 열리는 이슈 작성 화면에 방금 저장한 파일을 끌어다 놓고 등록하면 됩니다. 이슈는 누구나 볼 수 있습니다.'),
  ], t('이슈 작성 화면 열기'));
  if (!send) return;
  // 이슈 본문은 개발자가 읽으므로 한국어로 둔다.
  const body = [
    `기기: ${diag.device}`,
    `프로필 형식: ${diag.onboard.profileFormatId} (${diag.detectedLayout || '알 수 없는 구조'})`,
    '',
    '아래에 진단 파일(.json)을 끌어다 놓아 첨부해 주세요.', // i18n-ignore
    '',
    '추가로 알려 줄 내용(잘못 표시되는 값, G HUB에서 바꾼 설정 등):', // i18n-ignore
  ].join('\n');
  window.open(`${ISSUE_URL}?title=${encodeURIComponent(`[진단] ${diag.device}`)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
}

export async function importBackup(file) {
  try {
    const b = JSON.parse(await file.text());
    if (b.type !== 'omm-web-backup' || !Array.isArray(b.profiles)) throw new Error(t('GOMM 웹 백업 파일이 아닙니다.'));
    if (b.profileFormatId !== st.desc.profileFormatId || b.sectorSize !== st.desc.sectorSize) {
      throw new Error(t('이 기기와 호환되지 않는 백업입니다 ({device}).', { device: b.device || t('알 수 없는 기기') }));
    }
    const loaded = b.profiles.filter((e) => st.profiles[e.index] && e.data).map((e) => {
      const data = P.fromHex(e.data);
      if (data.length !== st.desc.sectorSize || !P.hasValidCrc(data)) throw new Error(t('프로필 {n}의 백업 데이터가 손상되었습니다.', { n: e.index + 1 }));
      return [st.profiles[e.index], data, !!e.enabled];
    });
    // 매크로: 이 기기에서 해석할 수 있는 것만 편집본으로 옮긴다. 저장할 때 빈 섹터에 새로 기록된다.
    const macros = (macroSupported() && Array.isArray(b.macros) ? b.macros : []).flatMap((e) => {
      const p = loaded.find(([q]) => q.index === e.index)?.[0];
      if (!p || !layers().includes(e.layer) || !Number.isInteger(e.button) || e.button < 0 || e.button >= buttonCountOf(e.layer)) return [];
      const data = P.fromHex(String(e.data));
      if (data.length !== st.desc.sectorSize || !P.hasValidCrc(data)) throw new Error(t('프로필 {n}의 백업 데이터가 손상되었습니다.', { n: e.index + 1 }));
      const m = M.readMacro((n) => (n === 0 ? data : null), { sector: 0, offset: 0 }, data.length);
      return m.error || !m.editable || !m.steps.length ? [] : [[p, e.layer, e.button, m.steps]];
    });
    for (const [p, data, enabled] of loaded) {
      if (p.raw) p.raw.set(data);
      else Object.assign(p, { raw: data, orig: new Uint8Array(data.length), source: 'rom' });
      p.enabled = enabled;
      p.pending.clear();
    }
    for (const [p, layer, i, steps] of macros) setPending(p, layer, i, steps);
    st.macroEdit = null;
    toast(t('프로필 {n}개를 불러왔습니다. 「기기에 저장」을 눌러야 기기에 반영됩니다.', { n: loaded.length }), 'ok');
  } catch (e) {
    toast(e instanceof SyntaxError ? t('백업 파일을 읽지 못했습니다.') : e.message, 'error');
  }
  shell.refresh();
}

// ---------- 요약 ----------

// 기기에 저장돼 있는 프로필의 요약: 기본 DPI, 보고율(Hz), DPI 단계 수. 읽을 수 없으면 null.
function profileSummary(p) {
  if (!p || !p.orig || !layoutKnown()) return null;
  const L = st.layout;
  const m = P.parse(p.orig, L);
  const stages = m.dpi.filter(Boolean);
  const stage = m.dpi[m.defaultDpi] || stages[0];
  const r = m.reportRates[0];
  const rate = !L.reportRate.length ? null : L.rateUnit === 'ms' ? (r ? Math.round(1000 / r) : null) : 125 << r;
  return { dpi: stage ? stage.x : null, rate, stages: stages.length };
}

const formatHz = (hz) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));

// 홈 카드와 상태 줄에 쓰는 요약
export function summary() {
  const cur = st.profiles.find(isCurrent);
  const sum = profileSummary(cur) || {};
  return {
    name: st.name, modeText: st.mode === MODE.ONBOARD ? t('온보드 메모리 모드') : t('호스트 모드'),
    dpi: sum.dpi, rate: sum.rate, profileLabel: cur ? profileTitle(cur) : null, battery: st.battery,
  };
}

// 상태 줄에 덧붙이는 모드 선택
export function deviceBarExtras() {
  return [h('label', { class: 'chip' }, t('모드') + ' ',
    h('select', { onchange: (e) => setMode(Number(e.target.value)) },
      h('option', { value: MODE.ONBOARD, selected: st.mode === MODE.ONBOARD }, t('온보드 메모리')),
      h('option', { value: MODE.HOST, selected: st.mode !== MODE.ONBOARD }, t('호스트(소프트웨어)'))))];
}

// ---------- 화면 ----------

export function renderProfiles(root) {
  const romActive = st.current >= ROM_BASE;
  const select = (p) => { st.selected = p.index; shell.refresh(); };
  root.replaceChildren(
    h('h2', null, t('프로필')),
    ...st.profiles.map((p) => h('div', {
      class: 'profile' + (p.index === st.selected ? ' selected' : '') + (p.enabled ? '' : ' off'),
      role: 'button', tabindex: '0', 'aria-pressed': String(p.index === st.selected),
      onclick: () => select(p),
      onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(p); } },
    },
      h('div', { class: 'profile-main' },
        h('span', { class: 'profile-name' }, profileTitle(p), profileDirty(p) && h('span', { class: 'dot', title: t('저장되지 않은 변경'), 'aria-label': t('저장되지 않은 변경') })),
        h('span', { class: 'profile-sub' },
          !p.raw ? t('읽을 수 없음') : [
            isCurrent(p) ? (romActive ? t('사용 중 (ROM)') : t('사용 중')) : p.enabled ? t('사용') : t('사용 안 함'),
            p.source === 'rom' ? t(' · 초기값') : '',
          ].join(''))),
      h('input', {
        type: 'checkbox', class: 'switch', title: t('프로필 사용'), 'aria-label': t('{name} 사용', { name: profileTitle(p) }),
        checked: p.enabled, disabled: !p.raw || !canEdit(),
        onclick: (e) => e.stopPropagation(),
        onkeydown: (e) => e.stopPropagation(),
        onchange: (e) => { p.enabled = e.target.checked; shell.refresh(); },
      }))),
  );
  return true;
}

// 편집으로 값이 바뀐 뒤 호출. 포커스를 잃지 않도록 편집 영역은 필요할 때만 다시 그린다.
function touched(rerenderEditor) {
  renderProfiles($('#sidebar'));
  shell.refreshActions();
  if (rerenderEditor) render($('#editor'));
}

export function render(root) {
  const p = st.profiles[st.selected];
  const notices = [];
  if (!st.crcTrusted) {
    notices.push(t('기기에서 체크섬이 맞는 프로필을 하나도 읽지 못했습니다. 안전을 위해 편집과 저장을 막았습니다.'));
  } else if (!layoutKnown()) {
    notices.push(t('이 기기의 프로필 형식({format})은 알려진 어떤 구조로도 해석되지 않아 편집할 수 없습니다.', { format: st.desc.profileFormatId }));
  } else if (!formatVerified()) {
    notices.push(h('label', null,
      h('input', { type: 'checkbox', checked: st.unlock, onchange: (e) => { st.unlock = e.target.checked; shell.refresh(); } }),
      ' ' + t('이 기기의 프로필 형식({format})은 실제 기기로 확인하지 못했습니다. 값이 잘못 해석될 수 있음을 이해하고 편집을 허용합니다. 먼저 백업을 내보내세요.', { format: st.desc.profileFormatId })));
  }
  if (st.mode !== MODE.ONBOARD) {
    notices.push(t('기기가 호스트 모드입니다. 온보드 프로필은 온보드 메모리 모드에서만 적용됩니다. G HUB가 실행 중이면 기기를 호스트 모드로 되돌리니 먼저 종료하세요.'));
  }

  const hasAnalog = layoutKnown() && st.layout.analog !== null;
  const tabList = [['overview', t('개요')], ['dpi', t('성능')], ['buttons', t('버튼')], hasAnalog && ['analog', t('HITS 구성')], ['info', t('고급')]].filter(Boolean);
  if (st.tab === 'analog' && !hasAnalog) st.tab = 'overview';
  if (st.tab !== 'buttons') stopRecording(); // 녹화는 매크로 편집 칸이 보일 때만
  const body = st.tab === 'info' ? renderInfo(p)
    : !p.raw ? h('p', { class: 'empty' }, t('이 프로필은 기기에서 읽을 수 없습니다.'))
    : !layoutKnown() ? h('p', { class: 'empty' }, t('알 수 없는 프로필 형식입니다.'))
    : st.tab === 'overview' ? renderOverview(p)
    : st.tab === 'dpi' ? renderDpi(p) : st.tab === 'analog' ? renderAnalog(p) : renderButtons(p);

  root.replaceChildren(
    ...notices.map((n) => h('div', { class: 'notice' }, n)),
    h('div', { class: 'editor-head' },
      h('h2', null, profileTitle(p)),
      // 기기에 저장된 상태 그대로인 프로필만 바로 전환할 수 있다.
      p.raw && !isCurrent(p) && p.origEnabled && !profileDirty(p) && st.mode === MODE.ONBOARD
        && h('button', { onclick: () => activate(p) }, t('이 프로필로 전환'))),
    tabs(tabList, st.tab, (id) => { st.tab = id; render(root); }, t('기기 설정 항목')),
    tabPanel(st.tab, body),
  );
}

// 기기가 지원하는 DPI 값으로 맞춘다. 구간마다 간격이 다를 수 있다.
function snapDpi(v) {
  const { min, max, step, segments } = st.dpiRange;
  v = Math.min(max, Math.max(min, v));
  const seg = (segments || []).find((s) => v <= s.to);
  return seg ? Math.min(seg.to, seg.from + Math.round((v - seg.from) / seg.step) * seg.step)
    : Math.min(max, Math.round((v - min) / step) * step + min);
}

// 개요: 프로필 이름과, 지금 편집 중인 값의 요약.
function renderOverview(p) {
  const ro = !canEdit();
  const L = st.layout;
  const m = P.parse(p.raw, L);
  const stages = m.dpi.filter(Boolean);
  const def = m.dpi[m.defaultDpi] || stages[0];
  const r = m.reportRates[0];
  const rate = !L.reportRate.length ? null : L.rateUnit === 'ms' ? (r ? Math.round(1000 / r) : null) : 125 << r;
  return h('div', null,
    L.name !== null && field(t('프로필 이름'), null, h('input', {
      type: 'text', maxlength: P.NAME_CHARS, value: m.name, placeholder: t('프로필 {n}', { n: p.index + 1 }), disabled: ro,
      oninput: (e) => { P.setName(p.raw, L, e.target.value); touched(false); },
      onchange: () => render($('#editor')),
    })),
    h('div', { class: 'stat-grid' },
      tile(t('기본 DPI'), def ? num(def.x) : '–', t('{n}단계 중', { n: stages.length })),
      tile(t('보고율'), rate ? `${num(rate)} Hz` : '–', L.reportRate[0] && t(L.reportRate[0].label)),
      tile(t('버튼'), String(Math.min(st.desc.buttonCount, L.maxButtons)), st.desc.hasGShift ? t('G-Shift 지원') : null),
      tile(t('상태'), isCurrent(p) ? t('사용 중') : p.enabled ? t('사용') : t('사용 안 함'), p.source === 'rom' ? t('초기값') : null)),
    h('p', { class: 'hint' }, t('값을 바꾸려면 위의 「성능」과 「버튼」 탭을 여세요. 변경 내용은 「기기에 저장」을 누르기 전까지 기기에 기록되지 않습니다.')));
}

// 보고율 바이트마다 버튼 묶음을 하나씩 만든다 (확장 구조는 무선/유선이 따로 있다).
function reportRateFields(p, m, ro) {
  const L = st.layout;
  const base = L.rateUnit === 'ms' ? [[8, '125'], [4, '250'], [2, '500'], [1, '1K']]
    : (st.rateIndexes || EXTENDED_RATE_INDEXES).map((i) => [i, formatHz(125 << i)]);
  return L.reportRate.map((r, index) => {
    const cur = m.reportRates[index];
    const options = base.some(([v]) => v === cur) ? base : [...base, [cur, t('기타 ({value})', { value: cur })]];
    const label = r.label ? t('보고율 · {link}', { link: t(r.label) }) : t('보고율');
    return field(label, 'Hz', choice(label, options, cur, ro, (v) => { P.setReportRate(p.raw, L, index, v); touched(true); }));
  });
}

// 버니합(BHOP) 시간. 저장 값은 ms / 10이고 0은 끔. G HUB에서는 100~1000 ms 범위다.
function bunnyHopField(p, m, ro) {
  const options = [[0, t('끔')], ...BUNNY_HOP_MS.map((ms) => [ms / 10, String(ms)])];
  if (!options.some(([v]) => v === m.bunnyHop)) {
    options.unshift([m.bunnyHop, m.bunnyHop === 0xff ? t('설정 안 됨') : t('기타 ({value})', { value: m.bunnyHop * 10 })]);
  }
  return [
    field(t('버니합 (BHOP)'), 'ms', choice(t('버니합'), options, m.bunnyHop, ro, (v) => { P.setBunnyHop(p.raw, st.layout, v); touched(true); })),
    h('p', { class: 'hint field-desc' }, t('휠 스크롤에 점프를 할당해 쓰는 게임을 위한 휠 설정입니다. 의도하지 않은 휠 움직임 때문에 점프가 엉뚱한 타이밍에 입력되는 것을 줄여 줍니다. 휠로 점프하지 않는다면 「끔」으로 두면 됩니다.')),
  ];
}

function renderDpi(p) {
  const ro = !canEdit();
  const L = st.layout;
  const { min, max, step } = st.dpiRange;
  const m = P.parse(p.raw, L);
  const slots = m.dpi.map((entry, slot) => ({ entry, slot })).filter((s) => s.entry);
  const stages = slots.map((s) => ({ ...s.entry }));
  let def = Math.max(0, slots.findIndex((s) => s.slot === m.defaultDpi));
  let shift = Math.max(0, slots.findIndex((s) => s.slot === m.shiftDpi));
  const commit = (rerender) => { P.setDpi(p.raw, L, stages, def, shift); touched(rerender); };
  const setStage = (i, v) => { stages[i].x = stages[i].y = v; };
  const lodLevels = LOD_LEVELS.map(([v, label]) => [v, t(label)]);

  const rows = stages.map((stage, i) => {
    const stageName = t('{n}단계', { n: i + 1 });
    const number = h('input', {
      type: 'number', min, max, step, value: stage.x, disabled: ro, 'aria-label': t('{stage} DPI', { stage: stageName }),
      onchange: (e) => { setStage(i, snapDpi(Number(e.target.value) || min)); commit(true); },
    });
    return h('div', { class: 'dpi-row' },
      h('span', { class: 'dpi-idx' }, stageName),
      h('input', {
        type: 'range', min, max, step, value: stage.x, disabled: ro, 'aria-label': t('{stage} DPI 슬라이더', { stage: stageName }),
        oninput: (e) => { setStage(i, snapDpi(Number(e.target.value))); number.value = stages[i].x; commit(false); },
      }),
      number,
      h('label', null, h('input', { type: 'radio', name: 'dpi-def', checked: i === def, disabled: ro, onchange: () => { def = i; commit(false); } }), ' ' + t('기본')),
      h('label', null, h('input', { type: 'radio', name: 'dpi-shift', checked: i === shift, disabled: ro, onchange: () => { shift = i; commit(false); } }), ' ' + t('시프트')),
      L.lodEditable && h('span', { class: 'lod' }, h('small', null, 'LOD'),
        choice(t('{stage} 리프트오프 거리', { stage: stageName }), lodLevels.some(([v]) => v === stage.lod) ? lodLevels : [...lodLevels, [stage.lod, t('기타 ({value})', { value: stage.lod })]],
          stage.lod, ro, (v) => { stages[i].lod = v; commit(true); }, 'small')),
      h('button', {
        class: 'ghost', title: t('단계 삭제'), 'aria-label': t('{stage} 삭제', { stage: stageName }), disabled: ro || stages.length <= 1,
        onclick: () => {
          stages.splice(i, 1);
          const fix = (idx) => (idx === i ? 0 : idx > i ? idx - 1 : idx);
          def = fix(def);
          shift = fix(shift);
          commit(true);
        },
      }, '✕'));
  });

  return h('div', null,
    reportRateFields(p, m, ro),
    m.bunnyHop !== null && bunnyHopField(p, m, ro),
    h('h3', null, t('DPI 단계 ({min}~{max})', { min: num(min), max: num(max) })),
    rows,
    h('button', {
      disabled: ro || stages.length >= P.DPI_SLOTS,
      onclick: () => { stages.push({ ...stages[stages.length - 1] }); commit(true); },
    }, t('+ 단계 추가')),
    h('p', { class: 'hint' }, t('시프트: 「DPI 시프트」 버튼을 누르고 있는 동안 적용되는 단계입니다.')),
    (L.dpiEntrySize === 5 || L.dpiY !== null) && h('p', { class: 'hint' }, t('가로·세로 DPI는 같은 값으로 설정됩니다.')
      + (L.lodEditable ? ' ' + t('LOD는 마우스를 들어 올렸을 때 추적이 멈추는 높이(리프트오프 거리)입니다.')
        : L.dpiEntrySize === 5 ? ' ' + t('리프트오프 거리는 이 프로필 형식에서 지원 단계가 확인되지 않아 기존 값을 유지합니다.') : '')),
    !L.reportRate.length && h('p', { class: 'hint' }, t('이 프로필 형식의 보고율은 값의 표현이 확인되지 않아 편집하지 않습니다.')));
}

function renderButtons(p) {
  const ro = !canEdit();
  const L = st.layout;
  const hasGShift = st.desc.hasGShift;
  const layer = hasGShift ? st.layer : 'buttons';
  const count = Math.min(st.desc.buttonCount, layer === 'gshift' ? L.maxGShift : L.maxButtons);

  const row = (i) => {
    const buttonName = t('버튼 {n}', { n: i + 1 });
    const bytes = P.getBinding(p.raw, L, layer, i);
    const a = P.decodeBinding(bytes);
    const key = macroKey(layer, i);
    const macro = currentMacro(p, layer, i); // 매크로가 걸려 있거나 매크로로 바꾸는 중이면 그 단계들
    const kind = macro ? 'macro' : a.kind;
    const apply = (action) => { p.pending.delete(key); P.setBinding(p.raw, L, layer, i, P.encodeBinding(action)); touched(true); };
    const openMacro = () => { st.macroEdit = { index: p.index, layer, i }; render($('#editor')); };
    const editable = ['mouse', 'key', 'consumer', 'special', 'disabled', ...(macroOk ? ['macro'] : [])];
    const kinds = [['mouse', t('마우스 버튼')], ['key', t('키보드')], ['consumer', t('미디어')], ['special', t('특수 기능')], ['disabled', t('사용 안 함')],
      macroOk && ['macro', t('매크로')]].filter(Boolean);
    if (!editable.includes(kind)) kinds.push([kind, kind === 'macro' ? t('매크로 (편집 불가)') : t('기타 (편집 불가)')]);
    const defaults = {
      mouse: { kind: 'mouse', mask: 1 }, key: { kind: 'key', mods: 0, usage: 0 },
      consumer: { kind: 'consumer', usage: 0xcd }, special: { kind: 'special', code: 0x05 }, disabled: { kind: 'disabled' },
    };

    let detail = null;
    if (kind === 'macro') {
      detail = macroOk && h('button', { disabled: ro, 'aria-label': t('{button} 매크로 편집', { button: buttonName }), onclick: openMacro }, t('매크로 편집'));
    } else if (a.kind === 'mouse') {
      const bit = Math.max(0, Math.log2(a.mask & -a.mask) | 0);
      detail = h('select', { disabled: ro, 'aria-label': t('{button} 마우스 버튼', { button: buttonName }), onchange: (e) => apply({ kind: 'mouse', mask: 1 << Number(e.target.value) }) },
        [...Array(16).keys()].map((b) => h('option', { value: b, selected: b === bit }, K.mouseButtonName(b))));
    } else if (a.kind === 'special' || a.kind === 'consumer') {
      const table = a.kind === 'special' ? K.SPECIALS : K.CONSUMER;
      const cur = a.kind === 'special' ? a.code : a.usage;
      const codes = Object.keys(table).map(Number);
      if (!codes.includes(cur)) codes.push(cur);
      detail = h('select', {
        disabled: ro, 'aria-label': t('{button} 기능', { button: buttonName }),
        onchange: (e) => apply(a.kind === 'special' ? { kind: 'special', code: Number(e.target.value) } : { kind: 'consumer', usage: Number(e.target.value) }),
      }, codes.map((c) => h('option', { value: c, selected: c === cur }, K.describe(a.kind === 'special' ? { kind: 'special', code: c } : { kind: 'consumer', usage: c }))));
    } else if (a.kind === 'key') {
      const keyLabel = a.usage ? K.keyName(0, a.usage) : t('키 지정');
      detail = h('span', { class: 'key-edit' },
        K.MODIFIERS.map(([bit, name]) => h('label', null,
          h('input', {
            type: 'checkbox', checked: !!(a.mods & (bit | (bit << 4))), disabled: ro,
            onchange: (e) => apply({ kind: 'key', usage: a.usage, mods: e.target.checked ? a.mods | bit : a.mods & ~(bit | (bit << 4)) }),
          }), ' ' + name)),
        h('button', {
          disabled: ro, class: 'capture', 'aria-label': t('{button} 키 지정: {key}', { button: buttonName, key: keyLabel }),
          onclick: (e) => { e.target.textContent = t('키를 누르세요…'); e.target.classList.add('armed'); },
          onblur: (e) => { e.target.textContent = keyLabel; e.target.classList.remove('armed'); },
          onkeydown: (e) => {
            if (!e.target.classList.contains('armed')) return;
            e.preventDefault();
            if (K.MODIFIER_CODES.includes(e.code)) return;
            const usage = K.CODE_TO_USAGE[e.code];
            if (!usage) return toast(t('지원하지 않는 키입니다: {code}', { code: e.code }), 'error');
            const mods = (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
            apply({ kind: 'key', mods, usage });
          },
        }, keyLabel));
    }

    return h('tr', null,
      h('th', { class: 'btn-idx', scope: 'row' }, buttonName),
      h('td', { class: 'btn-desc' }, kind === 'macro' ? macroSummary(macro) : K.describe(a, bytes)),
      h('td', null, h('select', {
        disabled: ro, 'aria-label': t('{button} 종류', { button: buttonName }),
        onchange: (e) => {
          if (e.target.value !== 'macro') return apply(defaults[e.target.value]);
          p.pending.set(key, []);
          openMacro();
          touched(false);
        },
      }, kinds.map(([k, label]) => h('option', { value: k, selected: k === kind, disabled: !editable.includes(k) }, label)))),
      h('td', null, detail));
  };
  const macroOk = macroSupported();
  const edit = st.macroEdit;
  const editing = macroOk && edit && edit.index === p.index && edit.layer === layer && edit.i < count;
  if (!editing) stopRecording();

  return h('div', null,
    hasGShift && h('div', { class: 'segmented', role: 'group', 'aria-label': t('버튼 층') },
      [['buttons', t('기본')], ['gshift', 'G-Shift']].map(([id, label]) => h('button', {
        type: 'button', class: id === layer ? 'active' : '', 'aria-pressed': String(id === layer), onclick: () => { st.layer = id; render($('#editor')); },
      }, label))),
    h('table', { class: 'buttons' },
      h('thead', null, h('tr', null, [t('버튼'), t('현재 동작'), t('종류'), t('설정')].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, [...Array(count).keys()].map(row))),
    editing && macroEditor(p, layer, edit.i, ro),
    h('p', { class: 'hint' }, t('버튼 번호는 기기 내부 순서입니다. 보통 1=왼쪽, 2=오른쪽, 3=휠 클릭 순이며 나머지는 기기마다 다릅니다.')));
}

// 매크로 편집 칸. 바꾼 내용은 편집본(p.pending)에 두고 「기기에 저장」 때 기록한다.
function macroEditor(p, layer, i, ro) {
  const title = t('{button} 매크로', { button: t('버튼 {n}', { n: i + 1 }) });
  return editorPanel({
    title, max: M.capacity(st.desc.sectorSize), readOnly: ro,
    current: () => currentMacro(p, layer, i),
    onChange: (next) => { setPending(p, layer, i, next); touched(true); },
    onClose: () => { st.macroEdit = null; render($('#editor')); },
    rerender: () => render($('#editor')),
    notice: t('이 매크로에는 GOMM이 표시할 수 없는 명령이 있습니다. 새로 녹화하면 기존 매크로를 대신합니다.'),
  });
}

// 아날로그 버튼(작동점, 래피드 트리거, 클릭 햅틱). 허용 범위는 기기가 알려 주는 단계 수를 따르고
// (공식 OMM 기준 작동점 1~단계 수, 래피드 트리거 1~단계 수, 햅틱 0~단계 수), 읽지 못하면 기본 범위를 쓴다.
function renderAnalog(p) {
  const caps = st.analogCaps || DEFAULT_ANALOG_CAPS;
  const ro = !canEdit();
  const L = st.layout;
  // 설정 한 줄: 이름과 설명, 현재 값, 그 아래 슬라이더와 양 끝 눈금.
  const setting = (title, desc, value, min, max, disabled, onInput) => {
    const out = h('output', null, String(value));
    // 저장된 값이 범위를 벗어나 있어도 그대로 보여 준다.
    const lo = Math.min(min, value);
    const hi = Math.max(max, value);
    return h('div', { class: 'hits-setting' + (disabled ? ' disabled' : '') },
      h('div', { class: 'hits-head' },
        h('div', null, h('div', { class: 'hits-title' }, title), h('div', { class: 'hits-desc' }, desc)),
        out),
      h('input', {
        type: 'range', min: lo, max: hi, step: 1, value, disabled, 'aria-label': title,
        oninput: (e) => { out.textContent = e.target.value; onInput(Number(e.target.value)); touched(false); },
      }),
      h('div', { class: 'hits-scale' }, h('span', null, String(lo)), h('span', null, String(hi))));
  };
  const cards = [...Array(L.analog.count).keys()].map((i) => {
    const a = P.getAnalog(p.raw, L, i);
    const set = (patch) => P.setAnalog(p.raw, L, i, Object.assign(a, patch));
    return h('section', { class: 'hits-card' },
      h('h3', null, t('버튼 {n}', { n: i + 1 }), ANALOG_BUTTON_NAMES[i] && h('span', null, t(ANALOG_BUTTON_NAMES[i]))),
      setting(t('작동점'), t('클릭이 입력되는 깊이'), a.actuation, 1, caps.actuationMax, ro, (v) => set({ actuation: v })),
      h('label', { class: 'hits-toggle' },
        h('div', null, h('div', { class: 'hits-title' }, t('래피드 트리거')), h('div', { class: 'hits-desc' }, t('버튼을 떼기 시작하면 바로 입력 해제'))),
        h('input', { type: 'checkbox', class: 'switch', checked: a.rtEnabled, disabled: ro, onchange: (e) => { set({ rtEnabled: e.target.checked }); touched(true); } })),
      setting(t('래피드 트리거 민감도'), a.rtEnabled ? t('입력 해제·재입력에 필요한 이동 거리') : t('래피드 트리거를 켜면 조절할 수 있습니다'),
        a.rtSensitivity, 1, caps.rtMax, ro || !a.rtEnabled, (v) => set({ rtSensitivity: v })),
      setting(t('클릭 햅틱 강도'), t('클릭할 때의 진동 세기 (0은 끔)'), a.haptic, 0, caps.hapticMax, ro, (v) => set({ haptic: v })));
  });
  return h('div', null,
    h('div', { class: 'hits-grid' }, cards),
    h('p', { class: 'hint' }, t('일반적으로 버튼 1이 좌클릭, 버튼 2가 우클릭입니다.') + ' ' + (st.analogCaps
      ? t('범위는 기기가 알려 준 단계 수입니다.')
      : t('기기에서 범위를 읽지 못해 기본 범위(PRO X2 SUPERSTRIKE 기준)를 적용했습니다.'))));
}

function renderInfo(p) {
  const d = st.desc;
  const rows = [
    [t('기기'), st.name],
    [t('프로필 형식'), `${d.profileFormatId} · ${!layoutKnown() ? t('알 수 없는 구조') : t(LAYOUT_NAMES[st.layout.id])}${formatVerified() ? '' : ' ' + t('(미검증)')}`],
    [t('메모리 모델 / 매크로 형식'), `${d.memoryModelId} / ${d.macroFormatId}`],
    [t('프로필 수 (초기 활성)'), `${d.profileCount} (${d.profileCountOob})`],
    [t('버튼 수'), d.buttonCount],
    [t('섹터'), t('{count}개 × {size}바이트', { count: d.sectorCount, size: d.sectorSize })],
    [t('G-Shift / DPI 시프트'), `${d.hasGShift ? t('지원') : t('미지원')} / ${d.hasDpiShift ? t('지원') : t('미지원')}`],
    [t('프로필 목록(디렉터리)'), st.dirValid ? t('정상') : t('비어 있음 (ROM 프로필 사용 중)')],
    [t('선택한 프로필 위치'), t('섹터 0x{sector} ({area})', { sector: p.sector.toString(16).padStart(4, '0'), area: p.source === 'rom' ? 'ROM' : t('사용자 영역') })],
  ];
  return h('table', { class: 'info' }, rows.map(([k, v]) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, String(v)))));
}

export const state = st;
