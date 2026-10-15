// MCHOSE 마우스 드라이버. M HUB(제조사 웹 드라이버)가 쓰는 세 가지 통신 방식을 다룬다.
//
//   A5 1세대  제조사 ID 0x2023. 64바이트 기능 리포트, [경로, 길이, 페이지, 명령, 데이터…]
//   V2        기능 리포트 0x11(명령 20바이트)·0x12(64바이트). 보내고 받는 바이트가 모두 비트 반전돼 있다.
//   V3        출력 리포트 0x4D로 보내고 입력 리포트로 답을 받는다. 2바이트 명령 번호와 XOR 검사값.
//
// 명령 번호와 바이트 위치는 M HUB의 동작, 그리고 OpenMouse(mouse-protocol)가 공개한 관찰 기록을
// 사실 정보로 참고했다. 코드는 가져오지 않았다.
//
// 드라이버는 상태를 한 번에 읽는 read()와, 화면에서 바뀐 항목을 받아 기기에 쓰는 apply()만 가진다.
// 같은 블록에 들어가는 변경은 한 번에 모아서 쓴다. 쓰기 결과의 확인은 saveChanges()가 다시 읽어서 한다.
import { MODELS, V2_BLUETOOTH, V3_LINKS, V3_PIDS, DOCK_PID } from './mchose-models.js';
import * as act from './mchose-actions.js';
import { t as tr } from './i18n.js';

const MCHOSE = 0x3837;
const MODES = ['Performance', 'eSports', 'Ultra'];
const SLEEP_OPTIONS = [0, 60, 120, 180, 300, 600, 1800];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytesOf = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const signed = v => (v << 24) >> 24;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const flat = list => (list || []).flatMap(c => [c, ...flat(c.children)]);
const rateLadder = max => [125, 500, 1000, 2000, 4000, 8000].filter(r => r <= max);
function need(ok, message) { if (!ok) throw new Error(message); }
function checkDpi(dpi, min, max) {
  need(isInt(dpi, min, max) && dpi % 50 === 0, tr('DPI는 {min}~{max} 사이의 50 단위여야 합니다.', { min, max: max.toLocaleString() }));
}

// 여러 요청이 기기에 동시에 나가지 않게 한 줄로 세운다.
class Lane {
  tail = Promise.resolve();
  run(task) { const next = this.tail.then(task, task); this.tail = next.catch(() => {}); return next; }
}

// 제품 문자열 안의 기종 이름. 긴 이름부터 맞춰 「A7 V3 Pro+」가 「A7 V3 Pro」로 잡히지 않게 한다.
function nameIn(productName, list) {
  const text = (productName || '').trim().toUpperCase();
  return text && [...list].sort((a, b) => b.name.length - a.name.length).find(m => text.includes(m.name.toUpperCase())) || null;
}
const bareName = productName => (productName || '').trim().replace(/^MCHOSE\s+/i, '').toUpperCase();
const ofFamily = family => MODELS.filter(m => m.family === family);
function labelled(productName) {
  const name = (productName || '').trim();
  return !name ? 'MCHOSE' : /^mchose/i.test(name) ? name : `MCHOSE ${name}`;
}

// 프로필 이름 응답: [번호, UTF-8 이름…, 0]. 잘못된 UTF-8이나 제어 문자는 이름으로 보지 않는다.
export function profileNameFrom(reply) {
  if (!reply || reply.length < 2) return null;
  const end = reply.indexOf(0, 1);
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(reply.subarray(1, end < 0 ? reply.length : end)).trim();
    return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
  } catch { return null; }
}

class Driver {
  constructor(device, family) { this.device = device; this.family = family; this.lane = new Lane(); }
  async open() { if (!this.device.opened) await this.device.open(); }
  async close() { if (this.device.opened) await this.device.close(); }
  getSleepOptions() { return SLEEP_OPTIONS; }
  getDebounceMaxMs() { return 20; }
  readStatus() { return this.open().then(() => this.read()); }
}

// ───────────────────────────── V2 ─────────────────────────────
//
// 설정 응답(0x67)의 배치:
//   0 프로필(0부터)  1 유선 링크 바이트  2 무선 링크 바이트 (위 4비트 보고율 순번, 아래 4비트 DPI 단계)
//   4~15 DPI 6단계(u16 LE)  16 사용 단계 수  17 센서 바이트  18 디바운스(ms)  19 절전(분)
//   20~43 버튼 6개 × [버튼 번호<<4 | 종류, 값 u24 BE]  49 센서 각도(부호 있는 바이트)
// 센서 바이트: 비트 0~1 리프트오프 순번, 2 리플 컨트롤, 3 각도 스냅, 4 모션 싱크, 6~7 성능 모드.
// 기록(0x57)은 읽은 응답 그대로에 명령 바이트만 앞에 붙인 형태라, 바꾸지 않는 바이트는 읽은 값을 돌려준다.
// 리프트오프·센서 옵션·성능 모드·각도는 0x42, 절전은 0x0a, 버튼은 0x52로 따로 쓴다.
const SHORT = { report: 0x11, width: 20 };
const LONG = { report: 0x12, width: 64 };
const V2_MODE_BITS = ['Performance', 'Performance', 'eSports', 'Ultra'];
const CONFIG_KEYS = ['pollingRateHz', 'activeDpiStage', 'dpiStages', 'debounceMs'];
const SENSOR_KEYS = ['liftOffDistance', 'motionSync', 'angleSnapping', 'rippleControl', 'powerMode', 'angleTuning'];
const SENSOR_BIT = { rippleControl: 0x04, angleSnapping: 0x08, motionSync: 0x10 };

function configLooksValid(c) {
  const stages = c[16];
  return c.length >= 50 && c[0] < 3 && isInt(stages, 1, 6) && (c[1] & 15) < stages && (c[2] & 15) < stages && c[18] <= 20;
}

class V2Driver extends Driver {
  constructor(device) { super(device, 'V2'); this.model = null; }

  // 유선이면 기기가 기종 고유 ID로 잡히고, 수신기·블루투스면 여러 기종이 함께 쓰는 ID로 잡힌다.
  get wired() { return ofFamily('V2').some(m => m.pid === this.device.productId); }
  get linkByte() { return this.wired ? 1 : 2; }

  rates() {
    const m = this.model, pid = this.device.productId;
    if (!m) return [];
    if (m.hosts) return m.hosts[pid] ? rateLadder(m.hosts[pid]) : [];
    return rateLadder(pid === V2_BLUETOOTH ? 1000 : m.maxRate);
  }
  liftOffs() { return (this.model?.lod ?? [0.7, 1, 2]).map(mm => `${mm} mm`); }

  async send(channel, tokens) {
    const body = new Uint8Array(64);
    for (let i = 0; i < channel.width; i++) body[i] = ~(tokens[i] ?? 0) & 0xff;
    await this.device.sendFeatureReport(channel.report, body);
  }
  // 모든 명령이 응답 버퍼 하나를 함께 쓰고, 기기가 다 채우기 전의 응답이 올 수 있다.
  // 그래서 명령 번호가 맞고 내용이 그럴듯한 응답이 두 번 연속 똑같이 올 때까지 다시 묻는다.
  ask(channel, tokens, plausible) {
    return this.lane.run(async () => {
      let previous = null;
      for (let round = 0; round < 20; round++) {
        await this.send(channel, tokens);
        await wait(90);
        let raw;
        try { raw = bytesOf(await this.device.receiveFeatureReport(channel.report)); } catch { continue; }
        if (raw.length < 3 || (raw[1] ^ 0xff) !== tokens[0]) continue;
        const reply = raw.slice(2).map(b => b ^ 0xff);
        if (!plausible(reply)) continue;
        if (previous && reply.every((b, i) => b === previous[i])) return reply;
        previous = reply;
      }
      return null;
    });
  }
  tell(channel, tokens, settleMs) {
    return this.lane.run(async () => { await this.send(channel, tokens); await wait(settleMs); });
  }

  async readConfig() {
    const c = await this.ask(LONG, [0x67], r => r.length >= 20 && isInt(le16(r, 4), 50, 42000));
    return c && configLooksValid(c) ? c : null;
  }
  async freshConfig() {
    const c = await this.readConfig();
    need(c, tr('마우스가 설정을 돌려주지 않았습니다.'));
    return c;
  }

  findModel(mousePid) {
    const list = ofFamily('V2'), key = bareName(this.device.productName);
    const exact = list.find(m => m.name.toUpperCase() === key);
    return { model: exact || list.find(m => m.pid === mousePid) || nameIn(this.device.productName, list), exact: !!exact };
  }

  async buttonLabels(c) {
    const out = {};
    for (const [i, name] of act.V2_BUTTONS.entries()) {
      const at = 20 + 4 * i, head = c[at], type = head & 15;
      out[name] = act.v2Describe(type, (c[at + 1] << 16) | (c[at + 2] << 8) | c[at + 3]);
      if (type !== 4) continue;
      // 매크로가 걸린 버튼은 0x63으로 매크로 이름을 읽을 수 있다: [버튼 번호, 길이, ASCII…]
      const index = head >> 4;
      const r = await this.ask(LONG, [0x63, index], d => d[0] === index);
      const size = r?.[1] ?? 0;
      if (size && size <= 20 && r.length >= 2 + size) {
        const macro = String.fromCharCode(...r.subarray(2, 2 + size)).trim();
        if (macro) out[name] = `매크로: ${macro}`;
      }
    }
    return out;
  }

  async read() {
    const filled = n => r => r.subarray(0, n).some(Boolean);
    const link = await this.ask(SHORT, [0x03], filled(7));
    const version = await this.ask(SHORT, [0x04], filled(2));
    const power = await this.ask(SHORT, [0x06], filled(11));
    const c = await this.readConfig();
    const { model, exact } = this.findModel(power ? le16(power, 2) : null);
    this.model = model;

    const rates = this.rates(), lods = this.liftOffs();
    const stages = c ? Array.from({ length: c[16] }, (_, i) => le16(c, 4 + 2 * i)) : [];
    const stage = c ? c[this.linkByte] & 15 : 0;
    const rate = c ? rates[c[this.linkByte] >> 4] ?? 0 : 0;
    const names = [];
    if (c) for (let i = 0; i < 3; i++) names.push(profileNameFrom(await this.ask(LONG, [0x68, i], r => r.length >= 2 && r[0] === i)) ?? '');
    const sensor = c?.[17] ?? 0;
    const ready = !!c && !!model && exact && (!model.hosts || !!model.hosts[this.device.productId]) && rate > 0
      && stages.every(d => isInt(d, 50, model.dpiMax));
    const ver = version?.[0] && version.length > version[0] ? String.fromCharCode(...version.subarray(1, 1 + version[0])) : null;

    return {
      brand: 'MCHOSE', family: 'V2',
      name: model ? `MCHOSE ${model.name}` : labelled(this.device.productName),
      connectionType: this.wired ? 'Wired' : 'Wireless',
      batteryPercent: power ? power[9] : null,
      batteryState: power ? (power[10] ? 'Charging' : 'Discharging') : 'Unknown',
      dpi: stages[stage] ?? 0,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? stage : undefined,
      pollingRateHz: rate,
      supportedPollingRates: rates.length ? rates : undefined,
      activeProfile: c ? c[0] + 1 : null,
      profileCount: c ? 3 : undefined,
      profileNames: c ? names : undefined,
      debounceMs: c ? c[18] : null,
      sleepTimeout: c ? c[19] * 60 : null,
      liftOffDistance: c ? lods[sensor & 3] ?? null : null,
      supportedLiftOffDistances: c ? lods : undefined,
      motionSync: c ? !!(sensor & SENSOR_BIT.motionSync) : null,
      angleSnapping: c ? !!(sensor & SENSOR_BIT.angleSnapping) : null,
      rippleControl: c ? !!(sensor & SENSOR_BIT.rippleControl) : null,
      powerMode: c ? V2_MODE_BITS[sensor >> 6] : undefined,
      powerModes: c ? MODES : undefined,
      angleTuning: c ? signed(c[49]) : null,
      buttonMappings: c ? await this.buttonLabels(c) : undefined,
      buttonOptions: c ? act.OPTIONS : undefined,
      firmware: ver ? [tr('수신기 {version}', { version: ver })] : [],
      ui: {
        settingsReady: ready,
        statusNote: link && !link[5] ? tr('수신기는 연결됐지만 마우스가 응답하지 않습니다. 마우스를 움직여 깨운 뒤 다시 읽으세요.') : null,
        dpiStageEditor: { minDpi: 50, maxDpi: model?.dpiMax ?? 26000, stepDpi: 50 },
      },
    };
  }

  async apply(keys, want) {
    const touched = new Set(keys.map(k => k.split('.')[0]));
    if (CONFIG_KEYS.some(k => touched.has(k))) await this.writeConfig(want);
    if (SENSOR_KEYS.some(k => touched.has(k))) await this.writeSensor(want, touched);
    if (touched.has('sleepTimeout')) {
      const minutes = Math.round(want.sleepTimeout / 60);
      need(isInt(minutes, 0, 255), tr('절전 시간이 범위를 벗어났습니다.'));
      // 절전은 반영이 느려 1.5초 기다린다.
      await this.tell(SHORT, [0x0a, minutes ? 1 : 0, minutes], 1500);
    }
    for (const key of keys.filter(k => k.startsWith('buttonMappings.'))) {
      const button = key.slice('buttonMappings.'.length), index = act.V2_BUTTONS.indexOf(button);
      const code = act.v2Encode(want.buttonMappings[button]);
      need(index >= 0 && code, tr('{button} 버튼에 쓸 수 없는 동작입니다.', { button }));
      const [type, value] = code;
      await this.tell(LONG, [0x52, index, 0, type, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff], 900);
    }
  }

  async writeConfig(want) {
    const c = Uint8Array.from(await this.freshConfig());
    const rate = this.rates().indexOf(want.pollingRateHz);
    need(rate >= 0, tr('이 연결에서는 {rate} Hz를 쓸 수 없습니다.', { rate: want.pollingRateHz }));
    need(isInt(want.activeDpiStage, 0, c[16] - 1), tr('현재 DPI 단계가 범위를 벗어났습니다.'));
    need(isInt(want.debounceMs, 0, 20), tr('디바운스는 0~20 ms입니다.'));
    c[this.linkByte] = (rate << 4) | want.activeDpiStage;
    want.dpiStages.forEach((dpi, i) => {
      checkDpi(dpi, 50, this.model?.dpiMax ?? 26000);
      c[4 + 2 * i] = dpi & 0xff;
      c[5 + 2 * i] = dpi >> 8;
    });
    c[18] = want.debounceMs;
    await this.tell(LONG, [0x57, ...c], 400);
  }

  // 0x42: [리프트오프 순번, 리플, 각도 스냅, 모션 싱크, 0, 0, 모드, 각도 사용, 각도].
  // 옵션 세 개는 0이 「그대로」, 1이 켬, 2가 끔. 모드도 0이 그대로. 리프트오프는 0번이 실제 단계라 늘 현재 값을 보낸다.
  // 이 명령은 반영이 가장 느려서, 너무 빨리 읽으면 이전 값이 돌아온다. 2초 기다리고 맞을 때까지 세 번까지 다시 보낸다.
  async writeSensor(want, touched) {
    const lod = this.liftOffs().indexOf(want.liftOffDistance);
    need(isInt(lod, 0, 3), tr('이 기종에서 쓸 수 없는 리프트오프 거리입니다.'));
    const toggle = key => touched.has(key) ? (want[key] ? 1 : 2) : 0;
    const mode = touched.has('powerMode') ? MODES.indexOf(want.powerMode) + 1 : 0;
    need(!touched.has('powerMode') || mode > 0, tr('알 수 없는 성능 모드입니다.'));
    const angle = touched.has('angleTuning') ? want.angleTuning : null;
    need(angle === null || isInt(angle, -30, 30), tr('센서 각도는 -30~30°입니다.'));
    const tokens = [0x42, lod, toggle('rippleControl'), toggle('angleSnapping'), toggle('motionSync'), 0, 0, mode,
      angle === null ? 0 : 1, angle === null ? 0 : angle & 0xff];

    const landed = c => {
      const s = c[17];
      return (s & 3) === lod && (angle === null || signed(c[49]) === angle)
        && (!mode || V2_MODE_BITS[s >> 6] === want.powerMode)
        && Object.entries(SENSOR_BIT).every(([key, bit]) => !touched.has(key) || !!(s & bit) === want[key]);
    };
    for (let round = 0; round < 3; round++) {
      await this.tell(SHORT, tokens, 2000);
      const c = await this.readConfig();
      if (c && landed(c)) return;
    }
  }

  async setProfile(number) {
    need(isInt(number, 1, 3), tr('프로필은 1~3입니다.'));
    await this.tell(SHORT, [0x58, number - 1], 600);
  }
}

// ───────────────────────────── V3 ─────────────────────────────
//
// 프레임(리포트 ID 0x4D 뒤 63바이트): [버전 1, 플래그, 데이터 길이, 명령 하위, 명령 상위, 업무 코드, 순번, 데이터…, 검사값]
// 플래그가 1이면 마지막에 1~(6+길이)번 바이트를 XOR한 검사값이 붙는다. 쓰기 명령 번호는 읽기 번호 + 0x0100이다.
// 쓰기는 모두 블록 통째로 바꾸므로, 방금 읽은 블록을 고쳐서 돌려보낸다.
//   0x0900 기기 정보   [VID, PID, 프로필 수, …, 10 연결 상태, 11 충전 중, 12 배터리 %]
//   0x0901 펌웨어      [대상(0=마우스)] → 2바이트
//   0x0002 설정        [0 프로필, 1 유선 링크, 2 무선 링크, 3 절전(분), 4 절전 모드, 5 센서, 6 각도, 7 왼쪽·8 오른쪽 디바운스, 나머지]
//   0x0003 DPI 표      [프로필, 축] → [프로필, 축, 단계 수, 현재 단계, Y축 분리, u16 LE × 6]
//   0x0001 버튼 표     [프로필, 0, 버튼 수] → 버튼마다 [종류, 값…] (값 길이는 종류에 따라 다름)
//   0x0009 리프트오프  [프로필] → [순번] (5단계 기종만)
// 쓰기 쪽 DPI 표는 [프로필, 축, Y축 분리, 단계 수, 현재 단계, …]로, 읽을 때와 순서가 다르다.
// 센서 바이트: 비트 0~1 성능 모드, 2 리플, 3 각도 스냅, 4 모션 싱크, 5~6 리프트오프 순번(3단계 이하 기종), 7 유리 표면.
// 링크 바이트의 보고율 칸은 기기 쪽 1번 자리를 건너뛴다(M HUB가 내지 않는 값). 그래서 화면 순번 n은 n>0일 때 n+1로 저장된다.
const V3_REPORT = 0x4d;
const V3_SENSOR_BIT = { rippleControl: 0x04, angleSnapping: 0x08, motionSync: 0x10 };
const V3_SETTINGS_KEYS = ['pollingRateHz', 'debounceMs', 'sleepTimeout', 'angleTuning', 'powerMode', 'motionSync', 'angleSnapping', 'rippleControl'];
const toChoice = stored => (stored > 1 ? stored - 1 : stored);
const toStored = choice => (choice > 0 ? choice + 1 : choice);

function xorSum(b, end) { let x = 0; for (let i = 1; i < end; i++) x ^= b[i]; return x; }

// 응답 하나를 분류한다. 명령 0·플래그 0·길이 0은 기기가 명령을 거절한 것이고,
// 데이터가 0xFF 한 바이트뿐이면 「잠시 뒤 다시」(수신기 뒤의 마우스가 아직 응답하지 못함)라는 뜻이다.
function classify(b, command) {
  if (b.length < 7) return null;
  const id = b[3] | (b[4] << 8), size = b[2];
  if (id === 0 && b[1] === 0 && size === 0) return { kind: 'refused' };
  if (id !== command || 7 + size > b.length) return null;
  if (b[1] === 1 && b[7 + size] !== xorSum(b, 7 + size)) return null;
  const data = b.slice(7, 7 + size);
  return data.length === 1 && data[0] === 0xff ? { kind: 'busy' } : { kind: 'data', data };
}

function parseButtons(data) {
  if (!data) return null;
  const out = {};
  let at = 0;
  for (const name of act.V3_BUTTONS) {
    if (at >= data.length) return null;
    const type = data[at], size = act.v3Width(type);
    if (at + 1 + size > data.length) return null;
    out[name] = { type, bytes: Array.from(data.subarray(at + 1, at + 1 + size)) };
    at += 1 + size;
  }
  return out;
}

class V3Driver extends Driver {
  constructor(device) { super(device, 'V3'); this.model = null; this.silent = false; this.asleep = false; }
  get wired() { return !V3_LINKS.includes(this.device.productId); }
  get linkByte() { return this.wired ? 1 : 2; }

  frame(command, data) {
    need(8 + data.length <= 63, tr('명령 데이터가 너무 깁니다.'));
    const b = new Uint8Array(63);
    b.set([1, 1, data.length, command & 0xff, command >> 8, 0, 0]);
    b.set(data, 7);
    b[7 + data.length] = xorSum(b, 7 + data.length);
    return b;
  }
  exchange(command, body) {
    return new Promise(resolve => {
      const finish = result => {
        clearTimeout(timer);
        this.device.removeEventListener('inputreport', listen);
        resolve(result);
      };
      const listen = e => { const r = classify(bytesOf(e.data), command); if (r) finish(r); };
      // 일부 명령은 펌웨어가 정확히 1초 뒤에 답하므로 그보다 넉넉히 기다린다.
      const timer = setTimeout(() => finish({ kind: 'timeout' }), 1500);
      this.device.addEventListener('inputreport', listen);
      this.device.sendReport(V3_REPORT, body).catch(() => finish({ kind: 'timeout' }));
    });
  }
  // 한 명령이 세 번 다 조용하면 그 뒤 명령도 답하지 않을 것으로 보고, 다음 상태 읽기 전까지 묻지 않는다.
  ask(command, data = []) {
    return this.lane.run(async () => {
      if (this.silent) return null;
      const body = this.frame(command, data);
      let timeouts = 0, busy = 0, heard = false;
      while (timeouts < 3) {
        const r = await this.exchange(command, body);
        if (r.kind === 'data') return r.data;
        if (r.kind === 'timeout') { timeouts++; continue; }
        heard = true;
        if (r.kind === 'refused') return null;
        this.asleep = true;
        if (++busy >= 2) return null;
        await wait(30);
      }
      if (!heard) this.silent = true;
      return null;
    });
  }
  tell(command, data) {
    const body = this.frame(command, data);
    return this.lane.run(async () => { await this.device.sendReport(V3_REPORT, body); await wait(400); });
  }

  findModel(mousePid) {
    // 0x0900이 알려 주는 ID는 다른 기종과 겹치는 일이 있어(A7 V3 Ultra+가 A5 V3 Ultra+의 ID를 보냄) 이름을 먼저 본다.
    const list = ofFamily('V3');
    return nameIn(this.device.productName, list) || list.find(m => m.pid === mousePid) || null;
  }
  async settings() { const s = await this.ask(0x0002); return s && s.length >= 9 ? s : null; }
  async dpiTable(profile) {
    const d = await this.ask(0x0003, [profile, 0]);
    if (!d || d.length < 17) return null;
    return { profile: d[0], axis: d[1], count: d[2], active: d[3], splitY: d[4] === 1 ? 1 : 0, stages: Array.from({ length: 6 }, (_, i) => le16(d, 5 + 2 * i)) };
  }
  async liftOffIndex(s) {
    if (!this.model?.lodCommand) return (s[5] >> 5) & 3;
    return (await this.ask(0x0009, [s[0]]))?.[0] ?? null;
  }
  rates() { return this.model ? rateLadder(this.model.maxRate) : []; }

  async read() {
    this.silent = false; this.asleep = false;
    const raw = await this.ask(0x0900);
    const info = raw && raw.length >= 14 ? raw : null;
    this.model = this.findModel(info ? le16(info, 2) : null);
    const s = await this.settings();
    const dpi = s ? await this.dpiTable(s[0]) : null;
    const buttons = s ? parseButtons(await this.ask(0x0001, [s[0], 0, act.V3_BUTTONS.length])) : null;
    const lod = s ? await this.liftOffIndex(s) : null;
    const fw = await this.ask(0x0901, [0]);
    const ver = fw && fw.length >= 2 && (fw[0] || fw[1]) ? ((fw[0] << 8) | fw[1]).toString(16) : null;

    const m = this.model, rates = this.rates();
    const stages = dpi ? dpi.stages.slice(0, dpi.count || 6) : [];
    const sensor = s?.[5] ?? 0;
    const lodText = m && lod !== null && m.lod[lod] !== undefined ? `${m.lod[lod]} mm` : null;
    const note = !s
      ? (this.asleep ? tr('수신기는 연결됐지만 마우스가 응답하지 않습니다. 마우스를 깨우거나 전원을 확인하세요.') : tr('마우스가 응답하지 않았습니다. 기종과 연결 방식을 알려 주세요.'))
      : (lodText ? tr('리프트오프 {value}.', { value: lodText }) + ' ' : '') + tr('이 세대의 설정 쓰기는 M HUB와 같은 명령을 쓰지만 실기기로 확인하지 않았습니다.');

    return {
      brand: 'MCHOSE', family: 'V3',
      name: m ? `MCHOSE ${m.name}` : labelled(this.device.productName),
      connectionType: this.wired ? 'Wired' : 'Wireless',
      batteryPercent: info ? info[12] : null,
      batteryState: info ? (info[11] ? 'Charging' : 'Discharging') : 'Unknown',
      dpi: dpi ? dpi.stages[dpi.active] ?? 0 : 0,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? dpi.active : undefined,
      pollingRateHz: s ? rates[toChoice(s[this.linkByte] >> 4)] ?? 0 : 0,
      supportedPollingRates: rates.length ? rates : undefined,
      activeProfile: s ? s[0] + 1 : null,
      profileCount: info?.[4] || undefined,
      debounceMs: s ? s[7] : null,
      sleepTimeout: s ? s[3] * 60 : null,
      // 리프트오프는 읽기만 한다(안내문에 표시). 이 세대의 리프트오프 쓰기는 아직 화면에 내지 않는다.
      liftOffDistance: lodText,
      motionSync: s ? !!(sensor & V3_SENSOR_BIT.motionSync) : null,
      angleSnapping: s ? !!(sensor & V3_SENSOR_BIT.angleSnapping) : null,
      rippleControl: s ? !!(sensor & V3_SENSOR_BIT.rippleControl) : null,
      angleTuning: s ? signed(s[6]) : null,
      powerMode: s ? MODES[sensor & 3] : undefined,
      powerModes: s ? MODES : undefined,
      buttonMappings: buttons ? Object.fromEntries(act.V3_BUTTONS.map(b => [b, act.v3Describe(b, buttons[b])])) : undefined,
      buttonOptions: buttons ? act.OPTIONS : undefined,
      firmware: ver ? [tr('펌웨어 {version}', { version: ver })] : [],
      ui: {
        settingsReady: !!s,
        statusNote: note,
        dpiStageEditor: m ? { minDpi: 200, maxDpi: m.dpiMax, stepDpi: 50 } : undefined,
      },
    };
  }

  async freshSettings() {
    this.silent = false;
    const s = await this.settings();
    need(s, tr('마우스가 설정을 돌려주지 않았습니다.'));
    return Array.from(s);
  }

  async apply(keys, want) {
    const touched = new Set(keys.map(k => k.split('.')[0]));
    need(!touched.has('liftOffDistance'), tr('이 기종의 리프트오프는 바꿀 수 없습니다.'));
    // 다른 블록을 먼저 쓴 뒤 버튼에서 막혀 일부만 저장되지 않도록, 쓰기 전에 버튼 동작부터 모두 확인한다.
    for (const key of keys.filter(k => k.startsWith('buttonMappings.'))) {
      const button = key.slice('buttonMappings.'.length);
      need(act.v3Encode(button, want.buttonMappings[button]), tr('{button} 버튼에는 「{action}」을(를) 쓸 수 없습니다.', { button, action: tr(want.buttonMappings[button]) }));
    }
    if (V3_SETTINGS_KEYS.some(k => touched.has(k))) await this.writeSettings(want, touched);
    if (touched.has('dpiStages') || touched.has('activeDpiStage')) await this.writeDpi(want);
    const buttons = keys.filter(k => k.startsWith('buttonMappings.')).map(k => k.slice('buttonMappings.'.length));
    if (buttons.length) await this.writeButtons(want, buttons);
  }

  async writeSettings(want, touched) {
    const s = await this.freshSettings();
    if (touched.has('pollingRateHz')) {
      const choice = this.rates().indexOf(want.pollingRateHz);
      need(choice >= 0, tr('이 기종은 {rate} Hz를 지원하지 않습니다.', { rate: want.pollingRateHz }));
      s[this.linkByte] = (toStored(choice) << 4) | (s[this.linkByte] & 15);
    }
    if (touched.has('sleepTimeout')) {
      const minutes = Math.round(want.sleepTimeout / 60);
      need(isInt(minutes, 0, 60), tr('절전 시간은 0~60분입니다.'));
      // 0분(끄기)일 때는 절전 모드 비트도 함께 켜 둬야 한다.
      s[3] = minutes;
      s[4] = (s[4] & ~1) | (minutes === 0 ? 1 : 0);
    }
    if (touched.has('debounceMs')) {
      need(isInt(want.debounceMs, 0, 20), tr('디바운스는 0~20 ms입니다.'));
      // 왼쪽·오른쪽 버튼 값을 따로 저장하지만 화면에는 하나만 있으므로 둘을 같이 바꾼다.
      s[7] = s[8] = want.debounceMs;
    }
    if (touched.has('angleTuning')) {
      need(isInt(want.angleTuning, -30, 30), tr('센서 각도는 -30~30°입니다.'));
      s[6] = want.angleTuning & 0xff;
    }
    if (touched.has('powerMode')) {
      const mode = MODES.indexOf(want.powerMode);
      need(mode >= 0, tr('알 수 없는 성능 모드입니다.'));
      s[5] = (s[5] & ~3) | mode;
    }
    for (const [key, bit] of Object.entries(V3_SENSOR_BIT)) {
      if (touched.has(key)) s[5] = want[key] ? s[5] | bit : s[5] & ~bit;
    }
    await this.tell(0x0102, s);
  }

  async writeDpi(want) {
    const s = await this.freshSettings();
    const t = await this.dpiTable(s[0]);
    need(t && isInt(t.count, 1, 6), tr('마우스가 DPI 표를 돌려주지 않았습니다.'));
    const stages = t.stages.slice();
    want.dpiStages.forEach((dpi, i) => {
      if (dpi === stages[i]) return;
      checkDpi(dpi, 200, this.model?.dpiMax ?? 26000);
      stages[i] = dpi;
    });
    need(isInt(want.activeDpiStage, 0, t.count - 1), tr('현재 DPI 단계가 범위를 벗어났습니다.'));
    await this.tell(0x0103, [t.profile, t.axis, t.splitY, t.count, want.activeDpiStage, ...stages.flatMap(v => [v & 0xff, v >> 8])]);
  }

  sameButton(button, a, b) {
    const x = act.v3Encode(button, a), y = act.v3Encode(button, b);
    return x && y ? x.type === y.type && x.bytes.join() === y.bytes.join() : a === b;
  }

  async writeButtons(want, changed) {
    const s = await this.freshSettings();
    const table = parseButtons(await this.ask(0x0001, [s[0], 0, act.V3_BUTTONS.length]));
    need(table, tr('마우스가 버튼 표를 돌려주지 않았습니다.'));
    for (const button of changed) {
      const entry = act.v3Encode(button, want.buttonMappings[button]);
      need(entry, tr('{button} 버튼에 쓸 수 없는 동작입니다.', { button }));
      table[button] = entry;
    }
    await this.tell(0x0101, [s[0], 0, act.V3_BUTTONS.length, ...act.V3_BUTTONS.flatMap(b => [table[b].type, ...table[b].bytes])]);
  }

  async setProfile(number) {
    const s = await this.freshSettings();
    need(isInt(number, 1, 16), tr('프로필 번호가 범위를 벗어났습니다.'));
    s[0] = number - 1;
    await this.tell(0x0102, s);
  }
}

// ───────────────────────────── A5 1세대 ─────────────────────────────
//
// 요청(64바이트): [0, 0, 경로 2, 응답 길이, 페이지, 명령, 데이터…]. 응답은 첫 바이트가 0xA1이고 페이지·명령이 같다.
// 페이지 0: 0x81 펌웨어, 0x83 배터리, 0x85 프로필(1부터), 0x87 절전(초, u16 BE), 0x88 디바운스
// 페이지 1: 0x80 보고율, 0x81 DPI 표, 0x82 현재 단계, 0x84 각도 스냅, 0x88 리프트오프, 0x89 모션 싱크, 0x8a 리플
// 쓰기는 같은 명령 번호에서 최상위 비트를 뗀 것(0x85 → 0x05)이다.
const A5_RATE_CODE = { 125: 0x08, 250: 0x04, 500: 0x02, 1000: 0x01 };
const A5_TOGGLE = { angleSnapping: 0x04, motionSync: 0x09, rippleControl: 0x0a };

class A5Driver extends Driver {
  constructor(device) {
    super(device, 'A5 Gen1');
    this.model = ofFamily('A5 Gen1').find(m => m.pid === device.productId) || null;
    // 기능 리포트 번호는 기기마다 달라서, 제조사 정의 컬렉션의 첫 기능 리포트를 쓴다.
    this.report = flat(device.collections).filter(c => c.usagePage >= 0xff00).flatMap(c => c.featureReports.map(r => r.reportId))[0] ?? 0;
  }
  get wired() { return !!this.model?.wired; }
  getSleepOptions() { return [0, 60, 120, 300, 600, 900, 1800]; }
  getDebounceMaxMs() { return 15; }
  rates() { return this.wired ? [125, 500, 1000] : [125, 250, 500, 1000]; }

  ask(page, command, size, data = []) {
    return this.lane.run(async () => {
      await this.open();
      const body = new Uint8Array(64);
      body.set([0, 0, 2, size, page, command]);
      body.set(data.slice(0, 57), 6);
      await this.device.sendFeatureReport(this.report, body);
      await wait(34);
      for (let round = 0; round < 8; round++) {
        let r = bytesOf(await this.device.receiveFeatureReport(this.report));
        if (r.length === 65 && r[0] === this.report) r = r.subarray(1);
        if (r[0] === 0xa1 && r[4] === page && r[5] === command) return r.slice(0, 64);
        if (round === 3) await this.device.sendFeatureReport(this.report, body);
        await wait(30);
      }
      throw new Error(tr('MCHOSE A5가 명령({command})에 답하지 않았습니다.', { command: `${page}:${command.toString(16)}` }));
    });
  }
  maybe(...args) { return this.ask(...args).catch(() => null); }

  async dpiTable(profile) {
    const t = await this.ask(1, 0x81, 10, [profile, 6]);
    const count = Math.min(6, Math.max(1, t[7] || 6));
    const stages = Array.from({ length: count }, (_, i) => (t[8 + 4 * i] << 8) | t[9 + 4 * i]);
    const a = await this.ask(1, 0x82, 2, [profile]);
    return { stages, active: Math.min(count, Math.max(1, a[7] || 1)) - 1 };
  }

  async read() {
    const fw = await this.maybe(0, 0x81, 16);
    const power = await this.maybe(0, 0x83, 2);
    const pr = await this.maybe(0, 0x85, 1);
    const profile = pr?.[6] || 1;
    const rate = await this.maybe(1, 0x80, 1);
    const dpi = await this.dpiTable(profile).catch(() => null);
    const sleep = await this.maybe(0, 0x87, 2);
    const debounce = await this.maybe(0, 0x88, 2, [profile]);
    const lod = await this.maybe(1, 0x88, 1);
    const toggles = {};
    for (const [key, cmd] of Object.entries(A5_TOGGLE)) toggles[key] = await this.maybe(1, 0x80 | cmd, 1);
    const rateHz = rate ? Number(Object.keys(A5_RATE_CODE).find(hz => A5_RATE_CODE[hz] === rate[6]) ?? 0) : 0;

    return {
      brand: 'MCHOSE', family: 'A5 Gen1',
      name: this.model ? `MCHOSE ${this.model.name}` : 'MCHOSE A5',
      connectionType: this.wired ? 'Wired' : 'Wireless',
      batteryPercent: power ? Math.min(100, power[7]) : null,
      batteryState: power ? (power[6] ? 'Charging' : 'Discharging') : 'Unknown',
      dpi: dpi ? dpi.stages[dpi.active] : 0,
      dpiStages: dpi?.stages,
      activeDpiStage: dpi?.active,
      pollingRateHz: rateHz,
      supportedPollingRates: this.rates(),
      activeProfile: pr ? profile : null,
      profileCount: pr ? 3 : undefined,
      debounceMs: debounce ? debounce[7] : null,
      sleepTimeout: sleep ? (sleep[6] << 8) | sleep[7] : null,
      liftOffDistance: lod ? (lod[6] === 2 ? 'High' : 'Low') : null,
      supportedLiftOffDistances: ['Low', 'High'],
      motionSync: toggles.motionSync ? toggles.motionSync[6] > 0 : null,
      angleSnapping: toggles.angleSnapping ? toggles.angleSnapping[6] > 0 : null,
      rippleControl: toggles.rippleControl ? toggles.rippleControl[6] > 0 : null,
      firmware: fw ? [tr('마우스 {version}', { version: [6, 7, 8, 9].map(i => String(fw[i]).padStart(2, '0')).join('.') })] : [],
      ui: {
        settingsReady: !!(dpi && rate),
        statusNote: null,
        dpiStageEditor: { minDpi: 50, maxDpi: 26000, stepDpi: 50 },
      },
    };
  }

  async apply(keys, want) {
    const touched = new Set(keys.map(k => k.split('.')[0]));
    const profile = want.activeProfile || 1;
    if (touched.has('pollingRateHz')) {
      need(this.rates().includes(want.pollingRateHz), tr('이 연결에서는 {rate} Hz를 쓸 수 없습니다.', { rate: want.pollingRateHz }));
      await this.ask(1, 0x00, 1, [A5_RATE_CODE[want.pollingRateHz]]);
    }
    if (touched.has('dpiStages') || touched.has('activeDpiStage')) {
      const stages = want.dpiStages;
      need(isInt(stages.length, 1, 6) && isInt(want.activeDpiStage, 0, stages.length - 1), tr('DPI 단계가 범위를 벗어났습니다.'));
      stages.forEach(dpi => checkDpi(dpi, 50, 26000));
      // 단계마다 X·Y 값을 같은 값으로 [상위, 하위, 상위, 하위] 순서로 쓴다.
      if (touched.has('dpiStages')) {
        const data = [profile, stages.length, ...stages.flatMap(d => [d >> 8, d & 0xff, d >> 8, d & 0xff])];
        await this.ask(1, 0x01, data.length, data);
      }
      await this.ask(1, 0x02, 2, [profile, want.activeDpiStage + 1]);
    }
    if (touched.has('sleepTimeout')) {
      const seconds = Math.round(want.sleepTimeout);
      need(isInt(seconds, 0, 0xffff), tr('절전 시간이 범위를 벗어났습니다.'));
      await this.ask(0, 0x07, 2, [seconds >> 8, seconds & 0xff]);
    }
    if (touched.has('debounceMs')) {
      need(isInt(want.debounceMs, 0, 15), tr('디바운스는 0~15 ms입니다.'));
      await this.ask(0, 0x08, 2, [profile, want.debounceMs]);
    }
    if (touched.has('liftOffDistance')) await this.ask(1, 0x08, 1, [want.liftOffDistance === 'High' ? 2 : 1]);
    for (const [key, cmd] of Object.entries(A5_TOGGLE)) {
      if (touched.has(key)) await this.ask(1, cmd, 1, [want[key] ? 1 : 0]);
    }
    need(!touched.has('buttonMappings') && !touched.has('powerMode') && !touched.has('angleTuning'), tr('이 기종에서 바꿀 수 없는 항목입니다.'));
  }

  async setProfile(number) {
    need(isInt(number, 1, 3), tr('프로필은 1~3입니다.'));
    await this.ask(0, 0x05, 1, [number]);
  }
}

// ───────────────────────────── 연결과 저장 ─────────────────────────────

export const filters = [
  { vendorId: MCHOSE, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x2023, usagePage: 0xffff },
  { vendorId: 0x5253, productId: 0x1020, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x5253, productId: 0x1021, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x41e4, productId: 0x1101, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x41e4, productId: 0x1102, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x0bda, productId: 0x4762, usagePage: 0xff01, usage: 1 },
];
export const catalog = MODELS.map(({ family, name, pid, readOnly }) => ({ family, name, productId: pid, readOnly }));

const configChannel = d => flat(d.collections).some(c => c.usagePage === 0xff01 && c.usage === 1);

export function createClient(devices) {
  // 일부 수신기는 다른 제조사 ID로 잡힌다. 이때는 제품 이름이 기종표와 정확히 같고,
  // 그 수신기 ID가 그 기종의 연결 목록에 있고, V2 설정 리포트(0x11·0x12)가 모두 있을 때만 V2로 연다.
  const foreign = devices.find(d => {
    const m = ofFamily('V2').find(x => x.name.toUpperCase() === bareName(d.productName));
    return d.vendorId !== MCHOSE && m?.hosts?.[d.productId]
      && filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId)
      && flat(d.collections).some(c => c.usagePage === 0xff01 && c.usage === 1
        && [0x11, 0x12].every(id => c.featureReports.some(r => r.reportId === id)));
  });
  if (foreign) return new V2Driver(foreign);

  const a5 = devices.find(d => d.vendorId === 0x2023 && ofFamily('A5 Gen1').some(m => m.pid === d.productId)
    && flat(d.collections).some(c => c.usagePage === 0xffff && c.featureReports.length));
  if (a5) return new A5Driver(a5);
  // V2와 V3는 같은 컬렉션을 쓰므로 V3로 알려진 ID만 V3로 보낸다. MagDock(충전 독)과 펌웨어 업데이트 컬렉션은 열지 않는다.
  const v3 = devices.find(d => d.vendorId === MCHOSE && V3_PIDS.includes(d.productId) && configChannel(d));
  if (v3) return new V3Driver(v3);
  const v2 = devices.find(d => d.vendorId === MCHOSE && d.productId !== DOCK_PID && !V3_PIDS.includes(d.productId) && configChannel(d));
  if (v2) return new V2Driver(v2);
  throw new Error(tr('지원하는 MCHOSE 설정 인터페이스가 없습니다. MagDock·펌웨어 업데이트 인터페이스는 마우스 설정 대상이 아닙니다.'));
}

const FIELDS = ['pollingRateHz', 'activeDpiStage', 'debounceMs', 'sleepTimeout', 'liftOffDistance',
  'motionSync', 'angleSnapping', 'rippleControl', 'powerMode', 'angleTuning'];

export function editableSnapshot(s) {
  return Object.fromEntries([...FIELDS, 'dpiStages', 'buttonMappings', 'activeProfile'].map(key => [key, s[key] ?? null]));
}

// 화면의 편집본과 원본을 비교해 바뀐 항목 이름(「dpiStages.0」처럼 칸 번호 포함)을 돌려준다.
export function changes(before, after) {
  const keys = FIELDS.filter(key => after[key] !== before[key]);
  (after.dpiStages || []).forEach((dpi, i) => { if (dpi !== before.dpiStages?.[i]) keys.push(`dpiStages.${i}`); });
  for (const [button, action] of Object.entries(after.buttonMappings || {})) {
    if (action === before.buttonMappings?.[button]) continue;
    if (button === 'Left') throw new Error(tr('왼쪽 버튼은 기본 클릭을 유지합니다.'));
    keys.push(`buttonMappings.${button}`);
  }
  return keys;
}

const valueAt = (s, key) => key.split('.').reduce((v, part) => v?.[part], s);

// 저장 직전에 다시 읽어 화면이 보던 상태와 같은지 확인하고, 쓴 뒤에 다시 읽어 바뀐 항목을 하나씩 대조한다.
export async function saveChanges(client, before, desired) {
  const keys = changes(before, desired);
  const fresh = await client.readStatus();
  need(fresh.ui?.settingsReady && knownStatus(fresh) && fresh.name === before.name && fresh.connectionType === before.connectionType, tr('기기 또는 편집 가능 상태가 바뀌었습니다. 다시 연결해 주세요.'));
  need(JSON.stringify(editableSnapshot(fresh)) === JSON.stringify(editableSnapshot(before)), tr('기기 설정이 외부에서 바뀌었습니다. 다시 읽은 뒤 수정해 주세요.'));
  if (keys.length) await client.apply(keys, desired);
  const back = await client.readStatus();
  // V3는 버튼의 원래 동작(오른쪽 버튼의 「오른쪽 클릭」 등)과 「기본값」이 같은 바이트라, 버튼은 기록 바이트로 비교한다.
  const same = (key, a, b) => key.startsWith('buttonMappings.') && client.sameButton
    ? client.sameButton(key.slice('buttonMappings.'.length), a, b) : a === b;
  const failed = keys.filter(key => !same(key, valueAt(back, key), valueAt(desired, key)));
  need(back.activeProfile === before.activeProfile && !failed.length,
    tr('기록 후 검증에 실패했습니다: {items}', { items: failed.join(', ') || tr('프로필 변경') }));
  return back;
}

export function knownStatus(s) {
  return catalog.some(m => !m.readOnly && s.name === `MCHOSE ${m.name}`);
}
