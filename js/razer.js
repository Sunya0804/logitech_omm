// Razer 마우스. 설정은 기능 보고서 0번으로 90바이트 요청을 보내고 같은 보고서로 답을 읽는다(OpenRazer와 같은 틀).
// 기종별 값(트랜잭션 ID, DPI 상한, 보고율)은 OpenMouse(@openmouse/protocol 0.45.2, AGPL-3.0)와 OpenRazer가 공개한 사실을 참고해
// 이 파일에서 새로 작성했다. 출처와 확인 범위: docs/razer-wlmouse.md
//
// 요청·답: [0]=상태(답: 1 처리 중·2 성공·3 실패·4 시간 초과·5 지원하지 않음), [1]=트랜잭션 ID, [5]=인자 길이,
//          [6]=명령 묶음, [7]=명령(읽기는 0x80 비트), [8..87]=인자, [88]=[2..87]의 XOR
//
// 주의: Chrome 153(2026-09-08)부터 Windows에서 Razer 설정 채널(마우스 컬렉션)의 기능 보고서를 막는다(OpenMouse 이슈 #253).
// 이 경우 브라우저만으로는 읽거나 쓸 수 없고, 연결할 때 그 이유를 알린다.
import { t } from './i18n.js';
import { statusSaver } from './status-save.js';

export const VENDOR_RAZER = 0x1532;
const REPORT_ID = 0;
const LENGTH = 90;
const STATUS = { busy: 1, ok: 2, unsupported: 5 };
const RATES_1K = [125, 500, 1000];
const RATES_8K = [125, 500, 1000, 2000, 4000, 8000];
// 자동 절전: 1~15분, 1분 단위 (실기기 Viper V3 Pro가 180초로 답함)
const SLEEP = Array.from({ length: 15 }, (_, i) => (i + 1) * 60);
const MAX_STAGES = 5;

// 제품 ID: { 이름, 무선, DPI 상한, 보고율, 고속 보고율 명령 사용, 트랜잭션 ID, 저장 위치 바이트, 보고율 확정용 트랜잭션 ID }
// OpenMouse가 실기기로 확인한 기종만 넣었다.
const m = (name, wireless, maxDpi, rates, ext, tid, more = {}) => ({ name, wireless, maxDpi, rates, ext, tid, storage: 1, ...more });
export const PRODUCTS = new Map([
  [0x0084, m('DeathAdder V2', false, 20000, RATES_1K, false, 0x3f, { storage: 0 })],
  [0x007c, m('DeathAdder V2 Pro', false, 20000, RATES_1K, false, 0x3f)],
  [0x007d, m('DeathAdder V2 Pro', true, 20000, RATES_1K, true, 0x3f)],
  [0x006e, m('DeathAdder Essential', false, 6400, RATES_1K, false, 0x3f)],
  [0x0071, m('DeathAdder Essential White Edition', false, 6400, RATES_1K, false, 0x3f)],
  [0x0098, m('DeathAdder Essential (2021)', false, 6400, RATES_1K, false, 0x3f)],
  [0x00b2, m('DeathAdder V3', false, 30000, RATES_8K, true, 0x1f, { commitTid: 0x1f })],
  [0x00b6, m('DeathAdder V3 Pro', false, 30000, RATES_1K, false, 0x1f)],
  [0x00b7, m('DeathAdder V3 Pro', true, 30000, RATES_1K, false, 0x1f)],
  [0x00be, m('DeathAdder V4 Pro', false, 45000, RATES_8K, true, 0x1f)],
  [0x00bf, m('DeathAdder V4 Pro', true, 45000, RATES_8K, true, 0x1f)],
  [0x00ef, m('DeathAdder V4 Pro Carbon Fiber Edition', false, 45000, RATES_8K, true, 0x1f)],
  [0x00f0, m('DeathAdder V4 Pro Carbon Fiber Edition', true, 45000, RATES_8K, true, 0x1f)],
  [0x00a5, m('Viper V2 Pro', false, 30000, RATES_1K, false, 0x1f)],
  [0x00a6, m('Viper V2 Pro', true, 30000, RATES_1K, true, 0x1f)],
  [0x00c0, m('Viper V3 Pro', false, 35000, RATES_1K, false, 0x1f)],
  [0x00c1, m('Viper V3 Pro', true, 35000, RATES_8K, true, 0x1f, { commitTid: 0x1f })],
  [0x00b8, m('Viper V3 HyperSpeed', true, 30000, RATES_1K, false, 0x1f)],
  [0x00a7, m('Naga V2 Pro', false, 30000, RATES_1K, false, 0x1f)],
  [0x00a8, m('Naga V2 Pro', true, 30000, RATES_1K, true, 0x1f)],
]);

const CMD = {
  firmware: [0x00, 0x81, 2], battery: [0x07, 0x80, 2], charging: [0x07, 0x84, 2], sleep: [0x07, 0x83, 2], setSleep: [0x07, 0x03, 2],
  dpi: [0x04, 0x85, 7], setDpi: [0x04, 0x05, 7], stages: [0x04, 0x86, 0x26], setStages: [0x04, 0x06, 0x26],
  rate: [0x00, 0x85, 1], setRate: [0x00, 0x05, 1], rateExt: [0x00, 0xc0, 2], setRateExt: [0x00, 0x40, 2],
};
const FIELDS = ['pollingRateHz', 'activeDpiStage', 'sleepTimeout'];

class Unsupported extends Error {}
class Corrupt extends Error {}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const hex2 = (n) => n.toString(16).padStart(2, '0');

export const checksum = (p) => p.slice(2, 88).reduce((a, b) => a ^ b, 0);
export function encodeRequest([cls, id, size], args = [], tid) {
  const p = new Uint8Array(LENGTH);
  p[1] = tid; p[5] = size; p[6] = cls; p[7] = id;
  p.set(args.slice(0, 80), 8);
  p[88] = checksum(p);
  return p;
}
// 답의 인자 부분. 처리 중이면 null, 길이·체크섬이 틀리면 Corrupt, 지원하지 않으면 Unsupported.
export function decodeReply(reply, [cls, id]) {
  const p = reply.length === LENGTH + 1 ? reply.slice(1) : reply; // 보고서 번호가 앞에 붙어 오는 경우
  if (p.length !== LENGTH || p[88] !== checksum(p)) throw new Corrupt('corrupt');
  if (p[0] === STATUS.busy) return null;
  if (p[0] === STATUS.unsupported) throw new Unsupported(`class ${hex2(cls)} command ${hex2(id)}`);
  if (p[0] !== STATUS.ok) throw new Error(t('Razer 마우스가 명령 {command}을 거절했습니다 (상태 {status}).', { command: `${hex2(cls)}/${hex2(id)}`, status: p[0] }));
  if (p[6] !== cls || p[7] !== id) return null; // 앞선 명령의 답이 남아 있었다
  return p.slice(8, 8 + Math.min(p[5], 80));
}
export function decodeStages(a) {
  const stages = [];
  for (let i = 0; i < Math.min(a[2], MAX_STAGES); i++) {
    const o = 3 + i * 7;
    stages.push({ x: (a[o + 1] << 8) | a[o + 2], y: (a[o + 3] << 8) | a[o + 4] });
  }
  return { active: a[1], stages };
}
export function encodeStages(storage, active, stages) {
  const a = new Array(0x26).fill(0);
  a[0] = storage; a[1] = active; a[2] = stages.length;
  stages.forEach(({ x, y }, i) => { const o = 3 + i * 7; a[o] = i; a[o + 1] = x >> 8; a[o + 2] = x & 0xff; a[o + 3] = y >> 8; a[o + 4] = y & 0xff; });
  return a;
}

// 브라우저가 기능 보고서를 막았을 때 보여 줄 설명
function blockedMessage(error) {
  const chrome = /Chrome\/(\d+)/.exec(globalThis.navigator?.userAgent || '');
  return t('브라우저가 Razer 마우스의 설정 채널에 접근하지 못했습니다. Razer Synapse가 실행 중이면 끄고 다시 연결하세요. Chrome·Edge 153 이상은 Windows에서 이 채널을 막고 있어(현재 {version}), 이 경우 브라우저만으로는 Razer 마우스를 설정할 수 없습니다. ({detail})',
    { version: chrome ? chrome[1] : '?', detail: error.message });
}

export class RazerDriver {
  family = 'Razer';
  constructor(device) { this.device = device; this.info = PRODUCTS.get(device.productId); this.queue = Promise.resolve(); }
  async open() {
    try { if (!this.device.opened) await this.device.open(); }
    catch (e) { throw new Error(blockedMessage(e)); }
  }
  async close() { if (this.device.opened) await this.device.close(); }
  getDebounceMaxMs() { return 0; }
  getSleepOptions() { return this.info.wireless ? SLEEP : []; }

  request(cmd, args = [], tid = this.info.tid) {
    const run = this.queue.then(() => this.exchange(cmd, args, tid));
    this.queue = run.catch(() => {});
    return run;
  }
  async exchange(cmd, args, tid) {
    const packet = encodeRequest(cmd, args, tid);
    for (let send = 0; send < 6; send++) {
      try { await this.device.sendFeatureReport(REPORT_ID, packet); }
      catch (e) { throw new Error(blockedMessage(e)); }
      for (let read = 0; read < 6; read++) {
        await delay(100);
        let view;
        try { view = await this.device.receiveFeatureReport(REPORT_ID); }
        catch (e) { throw new Error(blockedMessage(e)); }
        try {
          const value = decodeReply(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), cmd);
          if (value) return value;
        } catch (e) {
          if (e instanceof Corrupt) break; // 주고받기가 깨졌으면 처음부터 다시 보낸다
          throw e;
        }
      }
    }
    throw new Error(t('Razer 마우스가 응답하지 않습니다. 절전 중이거나 수신 범위 밖일 수 있습니다.'));
  }
  async optional(promise) {
    try { return await promise; } catch (e) { if (e instanceof Unsupported) return null; throw e; }
  }
  async readBattery() {
    if (!this.info.wireless) return null;
    try {
      const level = await this.request(CMD.battery);
      const charging = await this.optional(this.request(CMD.charging));
      return { percent: Math.round(level[1] * 100 / 255), charging: charging?.[1] === 1 };
    } catch { return null; }
  }
  async readRate() {
    if (this.info.ext) {
      const r = await this.optional(this.request(CMD.rateExt, [0]));
      if (r?.[1]) return Math.round(8000 / r[1]);
    }
    const r = await this.request(CMD.rate);
    return r[0] ? Math.round(1000 / r[0]) : null;
  }

  async readStatus() {
    const { name, wireless, maxDpi, rates, storage } = this.info;
    const fw = await this.request(CMD.firmware);
    const table = decodeStages(await this.request(CMD.stages, [storage]));
    if (!table.stages.length) throw new Error(t('마우스가 DPI 단계를 알려 주지 않았습니다.'));
    const active = Math.min(Math.max(table.active, 1), table.stages.length) - 1;
    this.lastStages = table.stages.map((s) => s.x);
    const battery = await this.readBattery();
    const sleep = wireless ? await this.optional(this.request(CMD.sleep)) : null;
    return {
      brand: 'Razer', family: this.family, name: `Razer ${name}`, model: name, productId: this.device.productId,
      connectionType: wireless ? 'Wireless' : 'Wired',
      batteryPercent: battery?.percent ?? null, batteryState: battery?.charging ? 'Charging' : 'Discharging',
      dpi: table.stages[active].x, dpiStages: table.stages.map((s) => s.x), dpiStagesY: table.stages.map((s) => s.y), activeDpiStage: active,
      pollingRateHz: await this.readRate(), supportedPollingRates: rates,
      sleepTimeout: sleep ? (sleep[0] << 8) | sleep[1] : null,
      activeProfile: null, profileCount: null,
      firmware: [`${fw[0]}.${fw[1]}`],
      ui: { settingsReady: true, dpiStageEditor: { minDpi: 100, maxDpi, stepDpi: 50 } },
    };
  }

  async apply(keys, desired) {
    const { storage, rates, ext, commitTid } = this.info;
    if (keys.some((k) => k.startsWith('dpiStages.') || k === 'activeDpiStage')) {
      const stages = desired.dpiStages.map((x, i) => {
        const y = desired.dpiStagesY?.[i], oldX = this.lastStages?.[i]; // 세로 DPI가 따로 설정돼 있으면 그대로 둔다
        return { x, y: y != null && oldX != null && y !== oldX ? y : x };
      });
      await this.request(CMD.setStages, encodeStages(storage, desired.activeDpiStage + 1, stages));
      const cur = stages[desired.activeDpiStage];
      await this.request(CMD.setDpi, [storage, cur.x >> 8, cur.x & 0xff, cur.y >> 8, cur.y & 0xff, 0, 0]);
    }
    if (keys.includes('pollingRateHz')) {
      const hz = desired.pollingRateHz;
      if (!rates.includes(hz)) throw new Error(t('이 마우스는 {rate} Hz를 지원하지 않습니다.', { rate: hz }));
      if (ext) {
        await this.request(CMD.setRateExt, [0, 8000 / hz]);
        if (commitTid !== undefined) await this.request(CMD.setRateExt, [1, 8000 / hz], commitTid);
        if (this.info.wireless) await delay(500); // 보고율을 바꾸면 무선 연결이 잠시 다시 맞춰진다
      } else await this.request(CMD.setRate, [1000 / hz]);
    }
    if (keys.includes('sleepTimeout')) await this.request(CMD.setSleep, [desired.sleepTimeout >> 8, desired.sleepTimeout & 0xff]);
  }
}

export const filters = [...PRODUCTS.keys()].map((productId) => ({ vendorId: VENDOR_RAZER, productId }));
export const catalog = [...new Set([...PRODUCTS.values()].map((p) => p.name))].map((name) => ({ name }));

// 같은 마우스가 여러 인터페이스로 잡히면, 설정 채널이 있는 마우스 컬렉션(또는 제조사 정의 컬렉션)을 고른다.
export function createClient(devices) {
  const razer = devices.filter((d) => d.vendorId === VENDOR_RAZER);
  if (!razer.length) throw new Error(t('Razer 마우스가 아닙니다.'));
  if (!razer.some((d) => PRODUCTS.has(d.productId))) {
    const hex = razer[0].productId.toString(16).padStart(4, '0').toUpperCase();
    throw new Error(t('{name}: 아직 지원하지 않는 Razer 기종입니다 (1532:{id}). 실기기로 확인된 기종만 연결합니다.', { name: razer[0].productName || 'Razer', id: hex }));
  }
  const known = razer.filter((d) => PRODUCTS.has(d.productId));
  const device = known.find((d) => d.collections.some((c) => c.usagePage === 1 && c.usage === 2))
    || known.find((d) => d.collections.some((c) => c.usagePage >= 0xff00)) || known[0];
  return new RazerDriver(device);
}

export const knownStatus = (s) => s.brand === 'Razer' && [...PRODUCTS.values()].some((p) => p.name === s.model);
export const { editableSnapshot, changes, saveChanges } = statusSaver(FIELDS, knownStatus);
