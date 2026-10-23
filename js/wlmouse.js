// WLMouse 마우스. 설정은 기능 보고서 0번으로 64바이트 요청을 보내고 같은 보고서로 답을 읽는다.
// 통신 규격은 OpenMouse(@openmouse/protocol 0.45.2, AGPL-3.0)가 공개한 사실을 참고해 이 파일에서 새로 작성했다.
// 출처와 확인 범위: docs/razer-wlmouse.md
//
// 요청: [0]=0, [2]=대상(0 수신기·1 수신기가 아는 짝 마우스·2 마우스), [3]=인자 길이, [4]=페이지, [5]=명령, [6..]=인자
// 답:   [0]=상태(0xa1 성공·0xa2 지원하지 않음·0xa0/0xa3 처리 중), [3]=길이, [4]=페이지, [5]=명령, [6..]=값
// Windows는 답 앞에 보고서 번호 0을 붙여 주기도 해서, 한 칸 밀린 답도 받는다.
// 읽기 명령은 0x80 비트가 켜져 있고, 쓰기는 그 비트를 끈 같은 번호다. 프로필 설정은 첫 인자로 프로필 번호를 받는다.
import { t } from './i18n.js';
import { statusSaver } from './status-save.js';

export const VENDOR_WLMOUSE = 0x36a7;
const REPORT_ID = 0;
const LENGTH = 64;
const OK = 0xa1, UNSUPPORTED = 0xa2;
const TARGET = { dongle: 0, paired: 1, mouse: 2 };
const PAGE = { device: 0, profile: 1, buttons: 3 };

// 제품 ID: [이름, 무선 여부]. 1K 수신기(0xa882)는 어느 마우스와 짝이든 같은 ID라, 짝 마우스의 ID를 따로 묻는다.
const RECEIVER = '1K receiver';
export const PRODUCTS = new Map([
  [0xa860, ['Beast G', true]], [0xa861, ['Beast G', false]], [0xa863, ['Huan', true]], [0xa864, ['Huan', false]],
  [0xa866, ['Beast Miao', true]], [0xa867, ['Beast Miao', false]], [0xa868, ['Beast Mini Pro', true]], [0xa869, ['Beast Mini Pro', false]],
  [0xa870, ['Beast X Pro', true]], [0xa871, ['Beast X Pro', false]], [0xa872, ['Strider', true]], [0xa873, ['Strider', false]],
  [0xa874, ['Ying', true]], [0xa875, ['Ying', false]], [0xa878, ['Sword X', true]], [0xa879, ['Sword X', false]],
  [0xa880, ['Beast Max', true]], [0xa881, ['Beast Max', false]], [0xa882, [RECEIVER, true]],
  [0xa883, ['Beast X', true]], [0xa884, ['Beast X', false]], [0xa885, ['Beast Mini', true]], [0xa886, ['Beast Mini', false]],
]);
// OpenMouse가 실기기로 확인한 기종(Beast X·Beast Mini·Beast X Pro·Sword X·Beast Max). 나머지는 같은 규격을 쓴다고만 알려져 있다.
export const VERIFIED = new Set(['Beast X', 'Beast Mini', 'Beast X Pro', 'Sword X', 'Beast Max']);
// Beast X 4K는 같은 보고서를 가졌지만 이 규격에 답하지 않고 다른 방식(보고서 4번)을 쓴다.
const OTHER_PROTOCOL = new Set([0xa887]);
const RATE_LIMIT = new Map([[0xa882, 1000]]);

// 보고율 값: 같은 1000 Hz가 두 값(0x01·0x10)으로 올 수 있다. 쓸 때는 앞의 값을 쓴다.
const RATES = [[0x08, 125], [0x04, 250], [0x02, 500], [0x01, 1000], [0x10, 1000], [0x20, 2000], [0x40, 4000], [0x80, 8000]];
// 리프트오프: 0x80 비트가 켜져 있으면 0.1 mm 단위, 아니면 mm 단위
const LIFT_OFF = [[0x87, '0.7 mm'], [0x01, '1 mm'], [0x02, '2 mm']];
const SLEEP = [30, 60, 120, 300, 600, 1800];
const DPI = { min: 50, max: 30000, step: 50, stages: 6 };
const DEBOUNCE_MAX = 15;
const ANGLE_LIMIT = 30;

// 프로필 설정 [읽기 명령, 쓰기 명령, 페이지]
const SETTING = {
  pollingRateHz: [0x80, 0x00, PAGE.profile], dpiStages: [0x81, 0x01, PAGE.profile], activeDpiStage: [0x82, 0x02, PAGE.profile],
  angleSnapping: [0x84, 0x04, PAGE.profile], liftOffDistance: [0x88, 0x08, PAGE.profile], motionSync: [0x89, 0x09, PAGE.profile],
  rippleControl: [0x8a, 0x0a, PAGE.profile], hyperMode: [0x8b, 0x0b, PAGE.profile], turboMode: [0x93, 0x13, PAGE.profile],
  angleTuning: [0x94, 0x14, PAGE.profile], sleepTimeout: [0x87, 0x07, PAGE.device], debounceMs: [0x88, 0x08, PAGE.device],
};
const FLAGS = ['angleSnapping', 'motionSync', 'rippleControl', 'hyperMode', 'turboMode'];
const FIELDS = ['pollingRateHz', 'activeDpiStage', 'liftOffDistance', 'debounceMs', 'sleepTimeout', 'angleTuning', ...FLAGS];

class Unsupported extends Error {}

const hasReport0 = (c) => c.featureReports.some((r) => r.reportId === REPORT_ID) || (c.children || []).some(hasReport0);
const isConfig = (d) => d.vendorId === VENDOR_WLMOUSE && d.collections.some(hasReport0);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex2 = (n) => n.toString(16).padStart(2, '0');

export function encodeRequest(target, page, command, args = []) {
  const p = new Uint8Array(LENGTH);
  p[2] = target; p[3] = args.length; p[4] = page; p[5] = command;
  p.set(args.slice(0, LENGTH - 6), 6);
  return p;
}
// 답에서 값 부분을 꺼낸다. 처리 중이거나 다른 명령의 답이면 null, 지원하지 않는 명령이면 Unsupported.
export function decodeReply(reply, page, command) {
  for (const o of [0, 1]) {
    if (reply[4 + o] !== page || reply[5 + o] !== command) continue;
    if (reply[o] === UNSUPPORTED) throw new Unsupported(`page ${hex2(page)} command ${hex2(command)}`);
    if (reply[o] !== OK) continue;
    return reply.slice(6 + o, 6 + o + Math.min(reply[3 + o], LENGTH - 6 - o));
  }
  return null;
}
export const decodeStages = (v) => Array.from({ length: Math.min(v[1] || 0, Math.floor((v.length - 2) / 4)) },
  (_, i) => ({ x: (v[2 + i * 4] << 8) | v[3 + i * 4], y: (v[4 + i * 4] << 8) | v[5 + i * 4] }));
export function decodeLiftOff(value) {
  const named = LIFT_OFF.find(([v]) => v === value);
  if (named) return named[1];
  if (!value) return null;
  return `${value & 0x80 ? (value & 0x7f) / 10 : value} mm`;
}

export class WLMouseDriver {
  family = 'WLMouse';
  constructor(device) { this.device = device; this.queue = Promise.resolve(); this.pairedId = null; }
  async open() { if (!this.device.opened) await this.device.open(); }
  async close() { if (this.device.opened) await this.device.close(); }
  get productId() { return this.pairedId ?? this.device.productId; }
  get wireless() { return PRODUCTS.get(this.device.productId)?.[1] ?? /receiver|dongle/i.test(this.device.productName || ''); }
  model() { return PRODUCTS.get(this.productId)?.[0] ?? null; }
  name() {
    const m = this.model();
    return m ? (m === RECEIVER ? t('WLMouse 1K 수신기') : `WLMouse ${m}`) : (this.device.productName || 'WLMouse');
  }
  maxRate() {
    const known = RATE_LIMIT.get(this.device.productId);
    if (known) return known;
    const marker = /(\d+)\s*K\b/i.exec(this.device.productName || '');
    return marker ? Number(marker[1]) * 1000 : 8000;
  }
  rates() { return [...new Set(RATES.map(([, hz]) => hz))].filter((hz) => hz <= this.maxRate()); }
  getDebounceMaxMs() { return DEBOUNCE_MAX; }
  getSleepOptions() { return SLEEP; }

  // 요청은 한 번에 하나씩. 처리 중이면 같은 요청을 다시 보내며, 절전 중인 마우스를 깨우도록 점점 길게 기다린다.
  request(target, page, command, args = [], attempts = 12) {
    const run = this.queue.then(() => this.exchange(target, page, command, args, attempts));
    this.queue = run.catch(() => {});
    return run;
  }
  async exchange(target, page, command, args, attempts) {
    await this.open();
    const packet = encodeRequest(target, page, command, args);
    for (let i = 0; i < attempts; i++) {
      await this.device.sendFeatureReport(REPORT_ID, packet);
      await delay(30);
      const view = await this.device.receiveFeatureReport(REPORT_ID);
      const value = decodeReply(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), page, command);
      if (value) return value;
      await delay(i < 3 ? 30 : 300);
    }
    throw new Error(t('마우스가 응답하지 않습니다 (페이지 {page}, 명령 {command}). 절전 중이거나 수신 범위 밖일 수 있습니다.', { page: hex2(page), command: hex2(command) }));
  }
  read(key, profile, extra = []) {
    const [command, , page] = SETTING[key];
    return this.request(TARGET.mouse, page, command, [profile, ...extra]);
  }
  write(key, profile, values) {
    const [, command, page] = SETTING[key];
    return this.request(TARGET.mouse, page, command, [profile, ...values]);
  }
  // 이 기종에 없는 설정은 「지원하지 않음」으로 답한다. 그때는 null로 두어 화면에서 감춘다.
  async optional(promise) {
    try { return await promise; } catch (e) { if (e instanceof Unsupported) return null; throw e; }
  }
  async activeProfile() {
    const r = await this.optional(this.request(TARGET.mouse, PAGE.device, 0x85, []));
    return r ? Math.max(1, r[0]) : 1;
  }
  async readBattery() {
    try {
      const r = await this.request(TARGET.mouse, PAGE.device, 0x83, [], 3);
      return r[1] <= 100 ? { percent: r[1], charging: r[0] === 1 } : null;
    } catch { return null; }
  }

  async readStatus() {
    const fw = await this.request(TARGET.mouse, PAGE.device, 0x81, []);
    const dongle = this.wireless ? await this.optional(this.request(TARGET.dongle, PAGE.device, 0x81, [], 2)).catch(() => null) : null;
    if (this.wireless && this.pairedId === null) {
      const r = await this.optional(this.request(TARGET.paired, PAGE.device, 0x8b, [0x02], 2)).catch(() => null);
      const id = r && r.length >= 6 ? (r[4] << 8) | r[5] : null;
      if (id && PRODUCTS.has(id)) this.pairedId = id;
    }
    const battery = await this.readBattery();
    const profile = await this.activeProfile();
    const stages = decodeStages(await this.read('dpiStages', profile, [DPI.stages]));
    if (!stages.length) throw new Error(t('마우스가 DPI 단계를 알려 주지 않았습니다.'));
    this.lastStages = stages.map((s) => s.x);
    const active = Math.min(Math.max((await this.read('activeDpiStage', profile))[1], 1), stages.length) - 1;
    const rateCode = (await this.read('pollingRateHz', profile))[1];
    const rate = RATES.find(([v]) => v === rateCode)?.[1] ?? null;
    const lod = decodeLiftOff((await this.read('liftOffDistance', profile))[1]);
    const flag = async (key) => { const r = await this.optional(this.read(key, profile)); return r ? r[1] === 1 : null; };
    const flags = {};
    for (const key of FLAGS) flags[key] = await flag(key);
    const angle = await this.optional(this.read('angleTuning', profile));
    const debounce = await this.optional(this.read('debounceMs', profile));
    const sleep = await this.optional(this.read('sleepTimeout', profile));
    const sleepSeconds = sleep ? (sleep[1] << 8) | sleep[2] : 0;
    const version = (label, r) => (r && r.length >= 4 ? `${label} ${r[2]}.${r[3]}` : null);
    const model = this.model();
    return {
      brand: 'WLMouse', family: this.family, name: this.name(), model, productId: this.productId,
      connectionType: this.wireless ? 'Wireless' : 'Wired',
      batteryPercent: battery?.percent ?? null, batteryState: battery?.charging ? 'Charging' : 'Discharging',
      dpi: stages[active].x, dpiStages: stages.map((s) => s.x), dpiStagesY: stages.map((s) => s.y), activeDpiStage: active,
      pollingRateHz: rate, supportedPollingRates: this.rates(),
      liftOffDistance: lod, supportedLiftOffDistances: LIFT_OFF.map(([, v]) => v),
      ...flags,
      angleTuning: angle ? (angle[1] > 0x7f ? angle[1] - 0x100 : angle[1]) : null,
      debounceMs: debounce ? debounce[1] : null,
      sleepTimeout: sleepSeconds && sleepSeconds < 0xff00 ? sleepSeconds : null,
      activeProfile: profile, profileCount: null,
      firmware: [version(t('마우스'), fw), version(t('수신기'), dongle)].filter(Boolean),
      ui: { settingsReady: true, dpiStageEditor: { minDpi: DPI.min, maxDpi: DPI.max, stepDpi: DPI.step },
        statusNote: model && !VERIFIED.has(model) && model !== RECEIVER ? '이 기종은 같은 통신 규격을 쓴다고 알려져 있지만 아직 실기기로 확인된 적이 없습니다.' : null },
    };
  }

  // 바뀐 항목만 기록한다. DPI 단계는 한 번에 통째로 쓴다(세로 DPI가 따로 설정돼 있으면 그대로 둔다).
  async apply(keys, desired) {
    const profile = await this.activeProfile();
    if (keys.some((k) => k.startsWith('dpiStages.'))) {
      const stages = desired.dpiStages.map((x, i) => {
        const y = desired.dpiStagesY?.[i];
        const oldX = this.lastStages?.[i]; // 기록 직전에 읽은 가로 DPI
        return [x, y != null && oldX != null && y !== oldX ? y : x];
      });
      await this.write('dpiStages', profile, [stages.length, ...stages.flatMap(([x, y]) => [x >> 8, x & 0xff, y >> 8, y & 0xff])]);
    }
    for (const key of keys) {
      const v = desired[key];
      if (key === 'activeDpiStage') await this.write(key, profile, [v + 1]);
      else if (key === 'pollingRateHz') {
        const code = RATES.find(([, hz]) => hz === v);
        if (!code || !this.rates().includes(v)) throw new Error(t('이 마우스는 {rate} Hz를 지원하지 않습니다.', { rate: v }));
        await this.write(key, profile, [code[0]]);
        if (this.wireless) await delay(300); // 보고율을 바꾸면 무선 연결이 잠시 다시 맞춰진다
      } else if (key === 'liftOffDistance') {
        const code = LIFT_OFF.find(([, name]) => name === v);
        if (!code) throw new Error(t('지원하지 않는 리프트오프 거리입니다: {value}', { value: v }));
        await this.write(key, profile, [code[0]]);
      } else if (key === 'debounceMs') {
        if (!Number.isInteger(v) || v < 0 || v > DEBOUNCE_MAX) throw new Error(t('디바운스는 0~{max} ms 사이여야 합니다.', { max: DEBOUNCE_MAX }));
        await this.write(key, profile, [v]);
      } else if (key === 'sleepTimeout') await this.write(key, profile, [v >> 8, v & 0xff]);
      else if (key === 'angleTuning') {
        if (!Number.isInteger(v) || Math.abs(v) > ANGLE_LIMIT) throw new Error(t('센서 각도는 -30~30° 사이여야 합니다.'));
        await this.write(key, profile, [v & 0xff]);
      } else if (FLAGS.includes(key)) await this.write(key, profile, [v ? 1 : 0]);
    }
  }
}

export const filters = [{ vendorId: VENDOR_WLMOUSE }];
export const catalog = [...new Set([...PRODUCTS.values()].map(([name]) => name))].filter((n) => n !== RECEIVER)
  .map((name) => ({ name, verified: VERIFIED.has(name) }));

export function createClient(devices) {
  if (devices.some((d) => OTHER_PROTOCOL.has(d.productId))) {
    throw new Error(t('WLMouse Beast X 4K는 다른 통신 방식을 써서 아직 지원하지 않습니다.'));
  }
  const device = devices.find(isConfig);
  if (!device) throw new Error(t('WLMouse 설정 인터페이스(기능 보고서 0번)를 찾지 못했습니다. 연결 창에서 같은 마우스의 다른 항목을 골라 보세요.'));
  return new WLMouseDriver(device);
}

// 짝 마우스를 알아내지 못한 1K 수신기는 기종을 모르므로 읽기 전용이다.
export const knownStatus = (s) => s.brand === 'WLMouse' && !!s.model && s.model !== RECEIVER;
export const { editableSnapshot, changes, saveChanges } = statusSaver(FIELDS, knownStatus);
