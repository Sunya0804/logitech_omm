// VGN(제조사 ID 0x3554)과 ATK(0x373b) 마우스가 쓰는 16바이트 설정 프로토콜.
// 설정은 기기의 플래시 메모리에 주소별로 저장되고, HID 리포트 8번으로 읽고 쓴다.
// 명령 번호와 주소는 OpenMouse(mouse-protocol)가 정리한 내용과 VGN 웹 허브의 동작을 참고했다. 코드는 가져오지 않았다.
import { compxCatalog } from './compx-models.js';
import { t } from './i18n.js';

const VENDOR_VGN = 0x3554;
const VENDOR_ATK = 0x373b;
const VENDOR_IDS = [VENDOR_VGN, VENDOR_ATK];
const REPORT_ID = 0x08;
const PACKET_LENGTH = 16;
const CHUNK = 10; // 한 패킷에 실리는 데이터 바이트 수
const TIMEOUT_MS = 1200;

const CMD = {
  IDENTIFY: 0x01, ONLINE: 0x03, BATTERY: 0x04, WRITE_FLASH: 0x07, READ_FLASH: 0x08,
  GET_PROFILE: 0x0e, SET_PROFILE: 0x0f, VERSION: 0x12, DONGLE_VERSION: 0x1d,
};

// 플래시 주소. 한 바이트짜리 값은 바로 뒤에 검사 바이트(0x55 - 값)가 붙는다.
const FLASH = {
  reportRate: 0, stageCount: 2, currentStage: 4, lod: 10,
  dpi: 12, // 단계당 4바이트 × 8
  dpiColor: 44, // 단계별 표시등 색 [R, G, B, 검사] × 8
  dpiLightMode: 76, dpiLightBrightness: 78, dpiLightSpeed: 80, dpiLightState: 82,
  keys: 96, // 버튼당 4바이트 × 6
  debounce: 169, motionSync: 171, sleep: 173, angleSnap: 175, ripple: 177, performanceTime: 183,
};
const IMAGE_LENGTH = 185;
const DPI_SLOTS = 8;
const BUTTON_NAMES = ['왼쪽', '오른쪽', '휠 클릭', '뒤로', '앞으로', 'DPI 버튼'];
const DPI_MIN = 50;
const DPI_MAX = 42000;
const DPI_STEP = 50;
const DPI_HIGH_FROM = 30100; // 이 값부터는 절반 값을 저장하고 "2배" 표시를 붙인다 (100 단위)
// 식별 응답의 연결 종류 → 그 연결이 지원하는 최대 보고율
const MAX_RATE_BY_TYPE = { 0: 1000, 1: 4000, 2: 1000, 3: 8000, 4: 2000, 5: 8000 };
const RATES = [125, 250, 500, 1000, 2000, 4000, 8000];
const LOD = [[3, '낮음'], [1, '중간'], [2, '높음']]; // 저장 값은 순서대로가 아니다
const SLEEP = [[1, '10초'], [3, '30초'], [6, '1분'], [12, '2분'], [30, '5분'], [60, '10분'], [180, '30분']]; // 10초 단위
const DEBOUNCE_MAX = 15;
const PROFILE_COUNT = 4;
// DPI 표시등: 상태(켬/끔)와 모드(1 상시, 2 숨쉬기)가 따로 저장된다. 화면에서는 하나로 합쳐 고른다.
const DPI_LIGHT = [['off', '끔'], ['steady', '상시 켜짐'], ['breathing', '숨쉬기']];
const DPI_LIGHT_SPEED_MAX = 5;
// 밝기 1~10단계가 저장되는 값 (간격이 일정하지 않다)
const BRIGHTNESS = [16, 30, 60, 90, 128, 150, 180, 210, 230, 255];

// 버튼 동작: [종류, 값, 이름]. 종류 0 사용 안 함, 1 마우스 버튼, 2 DPI.
const KEY_ACTIONS = [
  [1, 0x0100, '왼쪽 클릭'], [1, 0x0200, '오른쪽 클릭'], [1, 0x0400, '가운데 클릭'], [1, 0x0800, '뒤로'], [1, 0x1000, '앞으로'],
  [2, 0x0100, 'DPI 순환'], [2, 0x0200, 'DPI 올리기'], [2, 0x0300, 'DPI 내리기'], [0, 0x0000, '사용 안 함'],
];

const check = (sum) => (0x55 - (sum & 0xff)) & 0xff;
const sumOf = (bytes) => bytes.reduce((a, b) => a + b, 0);

// ---------- 플래시 이미지 해석/수정 (기기와 무관) ----------

const decodeRate = (v) => (v >= 16 ? (v / 16) * 2000 : v ? 1000 / v : null);
const encodeRate = (hz) => (hz <= 1000 ? 1000 / hz : (hz / 2000) * 16);

// Ultra 센서의 DPI 표현: 10,000까지 10 단위, 그 위로 30,000까지 50 단위(플래그 비트 1), 30,000을 넘으면
// 절반 값을 저장하고 2배 표시(비트 0)를 붙인다. 실기기(F1 LEVIATAN 2.0)에서 읽은 기록 27 27 00 07(400),
// 3f 3f 44 93(3,200)이 ATK HUB에 보이는 값과 맞는 것을 확인했다. 높은 영역은 OpenMouse의 정리를 따랐다.
function decodeUltra(low, flags) {
  const code = (((flags >> 2) & 0x03) << 8) | low;
  const base = flags & 0x02 ? 10050 + code * 50 : (code + 1) * 10;
  return flags & 0x01 ? base * 2 : base;
}

function encodeUltra(dpi) {
  const doubled = dpi > 30000;
  const value = doubled ? dpi / 2 : dpi;
  const high = value > 10000;
  const code = high ? (value - 10050) / 50 : value / 10 - 1;
  return { low: code & 0xff, nibble: ((code >> 8) << 2) | (high ? 2 : 0) | (doubled ? 1 : 0) };
}

// DPI 기록 [가로 값, 세로 값, 플래그, 검사]. 검사가 맞지 않으면 null. 가로 값을 그 단계의 DPI로 본다.
function decodeDpi(image, slot, model = MODELS.vgn) {
  const o = FLASH.dpi + 4 * slot;
  const [low, lowY, flags, sum] = image.subarray(o, o + 4);
  if (((low + lowY + flags + sum) & 0xff) !== 0x55) return null;
  if (model.dpiCodec === 'ultra') return decodeUltra(low, flags);
  let dpi = ((((flags >> 2) & 0x03) << 8) + low + 1) * DPI_STEP;
  if (flags & 0x01) dpi *= 2; // 높은 DPI 영역 표시. 이 범위는 읽기만 하고 직접 쓰지는 않는다.
  if (flags & 0x02) dpi *= 2;
  return dpi;
}

// dpi는 snapDpi를 거친 값이어야 한다. 실기기(DragonFly F2 Ultra+)에 저장돼 있던 42,000 DPI 기록
// a3 a3 55 ba 와 같은 바이트가 나오는 것을 확인했다.
function setDpi(image, slot, dpi, model = MODELS.vgn) {
  if (model.dpiCodec === 'ultra') {
    const { low, nibble } = encodeUltra(dpi);
    const mode = (nibble << 4) | nibble;
    image.set([low, low, mode, check(low + low + mode)], FLASH.dpi + 4 * slot);
    return;
  }
  const doubled = dpi >= DPI_HIGH_FROM;
  const raw = (doubled ? dpi / 2 : dpi) / DPI_STEP - 1;
  const low = raw & 0xff;
  const high = (raw >> 8) & 0x03;
  const flags = (high << 2) | (high << 6) | (doubled ? 0x11 : 0);
  image.set([low, low, flags, check(low + low + flags)], FLASH.dpi + 4 * slot);
}

// 기종별 차이. lod / sleep: [저장 값, 표시], debounce: 고를 수 있는 값(ms), maxRate: 기종 자체의 보고율 상한.
// lighting / profiles: DPI 표시등 설정과 프로필 전환을 화면에 낼지 (확인된 기종만 켠다).
// dpiCodec: DPI 저장 방식 (없으면 50 단위, 'ultra'는 10 단위부터), dpiStep: 화면에서 쓰는 가장 작은 간격.
const ATK_COMMON = {
  brand: 'ATK', debounce: [0, 1, 2, 4, 8, 15, 20], lighting: false, profiles: true,
  sleep: [[3, '30초'], [6, '1분'], [12, '2분'], [18, '3분'], [30, '5분'], [120, '20분'], [150, '25분'], [180, '30분']],
};
// PAW3950 Ultra 센서 기종. 리프트오프는 0.1 mm 눈금이고 저장 값 1이 0.7 mm다.
const ATK_ULTRA = {
  ...ATK_COMMON, dpiCodec: 'ultra', dpiStep: 10, dpiMin: 10, dpiMax: 42000, maxRate: 8000,
  lod: [...Array(11).keys()].map((i) => [i + 1, `${((i + 7) / 10).toFixed(1)} mm`]),
};
const MODELS = {
  // 실기기(DragonFly F2 Ultra+)로 확인한 VGN 기본값
  vgn: {
    brand: 'VGN', model: null, dpiMin: DPI_MIN, dpiMax: DPI_MAX, lod: LOD, sleep: SLEEP, maxRate: 8000,
    debounce: [...Array(DEBOUNCE_MAX + 1).keys()], lighting: true, profiles: true,
  },
  // ATK는 같은 프로토콜이라도 센서에 따라 DPI 표현이 달라서, 50 단위 표현을 쓰는 것으로 알려진 기종만 받는다.
  // 값은 OpenMouse가 ATK HUB와 실기기로 대조해 둔 내용을 따랐다. 이 프로젝트에서 실기기로 확인한 적은 없다.
  'atk:2,39': { ...ATK_COMMON, model: 'ATK X1 Pro Max', dpiMin: 50, dpiMax: 36000, maxRate: 8000, lod: [[3, '0.7 mm'], [1, '1 mm'], [2, '2 mm']] },
  'atk:2,83': { ...ATK_COMMON, model: 'ATK A9 Plus Nearlink', dpiMin: 100, dpiMax: 30000, maxRate: 1000, lod: [[1, '1 mm'], [2, '2 mm']] },
  // PAW3950 Ultra. 실기기(8K 수신기 연결)에서 읽은 DPI 단계와 리프트오프 값이 ATK HUB와 맞는 것을 확인했다.
  // 식별값 1,13은 DPI 기록이 6바이트인 다른 기종(X1 Ultra Max 2.0 + Tri-Mode)도 쓰는데, 그 기기는
  // 4바이트 기록의 검사가 맞지 않아 연결 단계에서 걸러진다.
  'atk:1,13': { ...ATK_ULTRA, model: 'ATK F1 LEVIATAN 2.0' },
  // 실기기(8K 수신기 연결)의 설정 메모리가 F1 LEVIATAN 2.0과 같은 구조로 읽히는 것을 확인했다.
  'atk:1,24': { ...ATK_ULTRA, model: 'ATK Ghost Ultimate' },
  // 2026-10-14: 사용자가 A9 Ultra의 GOMM 동작을 확인하고 경고 제거를 요청했다.
  // 미확인 리프트오프 값과 기존 디바운스 선택지는 확장하지 않는다.
  'atk:2,87': { ...ATK_ULTRA, model: 'ATK A9 Ultra', lod: null, debounce: [1, 2, 4, 8, 15, 20], verified: true },
};

// 실기기로 확인하지 못한 기종(compx-models.js)에 쓰는 설정. 기종표로 알 수 있는 것은 센서별 DPI 범위와 저장 방식뿐이다.
// 리프트오프는 기종마다 저장 값의 뜻이 달라 바꾸지 못하게 하고(lod: null), 디바운스 0 ms는 받지 않는 기종이 있어 뺀다.
const UNVERIFIED_DPI = {
  ultra: { dpiCodec: 'ultra', dpiStep: 10, dpiMin: 10, dpiMax: 42000 },
  paw3950: { dpiMin: 50, dpiMax: 36000 },
  paw3395: { dpiMin: 100, dpiMax: 30000 },
  core26k: { dpiMin: 50, dpiMax: 26000 },
};

// 식별 응답(cid, mid)에 맞는 기종 설정. 지원하지 않는 기종이면 null.
// verified가 false인 기종은 사용자가 읽힌 값을 확인해야 편집이 열린다.
function modelFor(vendorId, cid, mid) {
  if (vendorId === VENDOR_VGN) return MODELS.vgn;
  const key = `${cid},${mid}`;
  if (MODELS[`atk:${key}`]) return MODELS[`atk:${key}`];
  for (const [group, names] of Object.entries(compxCatalog)) {
    if (names[key]) {
      return { ...ATK_COMMON, ...UNVERIFIED_DPI[group], model: names[key], maxRate: 8000, lod: null, debounce: [1, 2, 4, 8, 15, 20], verified: false };
    }
  }
  return null;
}

// 기기가 표현할 수 있는 값으로 맞춘다: 30,000까지 50 단위, 그 위로는 100 단위.
// Ultra 방식은 10,000까지 10 단위이고 그 위는 10,050부터 50 단위, 30,100부터 100 단위다.
function snapDpi(v, model = MODELS.vgn) {
  const clamped = Math.min(model.dpiMax, Math.max(model.dpiMin, v));
  if (model.dpiCodec === 'ultra') {
    if (clamped <= 10025) return Math.min(10000, Math.round(clamped / 10) * 10);
    if (clamped <= 30050) return Math.min(30000, Math.max(10050, Math.round(clamped / 50) * 50));
    return Math.max(DPI_HIGH_FROM, Math.round(clamped / 100) * 100);
  }
  if (clamped > (DPI_HIGH_FROM + 30000) / 2) return Math.max(DPI_HIGH_FROM, Math.round(clamped / 100) * 100);
  return Math.min(30000, Math.round(clamped / DPI_STEP) * DPI_STEP);
}

// 단계별 표시등 색: [r, g, b] 또는 검사가 맞지 않으면 null
function decodeDpiColor(image, slot) {
  const o = FLASH.dpiColor + 4 * slot;
  const [r, g, b, sum] = image.subarray(o, o + 4);
  return ((r + g + b + sum) & 0xff) === 0x55 ? [r, g, b] : null;
}

function setDpiColor(image, slot, [r, g, b]) {
  image.set([r, g, b, check(r + g + b)], FLASH.dpiColor + 4 * slot);
}

function decodeDpiLight(image) {
  const on = image[FLASH.dpiLightState] === 1;
  const level = BRIGHTNESS.indexOf(image[FLASH.dpiLightBrightness]) + 1; // 0이면 목록에 없는 값
  return {
    kind: !on ? 'off' : image[FLASH.dpiLightMode] === 2 ? 'breathing' : 'steady',
    brightness: level, speed: image[FLASH.dpiLightSpeed],
  };
}

function setDpiLightKind(image, kind) {
  setScalar(image, FLASH.dpiLightState, kind === 'off' ? 0 : 1);
  if (kind !== 'off') setScalar(image, FLASH.dpiLightMode, kind === 'breathing' ? 2 : 1);
}

// 표시등 관련 값들의 검사 바이트가 모두 맞는지 (맞지 않으면 이 기기에는 그 기능이 없다고 본다)
function hasDpiLight(image) {
  const scalars = [FLASH.dpiLightMode, FLASH.dpiLightBrightness, FLASH.dpiLightSpeed, FLASH.dpiLightState];
  return scalars.every((a) => image[a + 1] === check(image[a])) && decodeDpiColor(image, 0) !== null;
}

function setScalar(image, address, value) {
  image[address] = value;
  image[address + 1] = check(value);
}

// 버튼 기록 [종류, 값 상위, 값 하위, 검사]
function decodeKey(image, index) {
  const o = FLASH.keys + 4 * index;
  return { cls: image[o], param: (image[o + 1] << 8) | image[o + 2] };
}

function setKey(image, index, cls, param) {
  const bytes = [cls, param >> 8, param & 0xff];
  image.set([...bytes, check(sumOf(bytes))], FLASH.keys + 4 * index);
}

function keyLabel(key) {
  const known = KEY_ACTIONS.find(([cls, param]) => cls === key.cls && param === key.param);
  return known ? known[2] : `기타 (${key.cls}:0x${key.param.toString(16).padStart(4, '0')})`;
}

function parse(image, model = MODELS.vgn) {
  const stages = [];
  for (let i = 0; i < DPI_SLOTS; i++) stages.push(decodeDpi(image, i, model));
  // 쓸 수 있는 단계 수: 앞에서부터 연속으로 유효한 기록이 있는 칸까지
  const usable = stages.findIndex((s) => s === null);
  return {
    rate: decodeRate(image[FLASH.reportRate]),
    stageCount: image[FLASH.stageCount], currentStage: image[FLASH.currentStage], stages,
    maxStages: usable < 0 ? DPI_SLOTS : usable,
    lod: image[FLASH.lod], debounce: image[FLASH.debounce], sleep: image[FLASH.sleep],
    motionSync: image[FLASH.motionSync] === 1, angleSnap: image[FLASH.angleSnap] === 1, ripple: image[FLASH.ripple] === 1,
    keys: BUTTON_NAMES.map((_, i) => decodeKey(image, i)),
    hasDpiLight: hasDpiLight(image), dpiLight: decodeDpiLight(image),
    dpiColors: stages.map((_, i) => decodeDpiColor(image, i)),
  };
}

// 바뀐 바이트를 이어진 구간(최대 CHUNK 바이트)으로 묶는다: [{address, bytes}]
function diffRuns(orig, work) {
  const runs = [];
  let i = 0;
  while (i < work.length) {
    if (orig[i] === work[i]) { i += 1; continue; }
    let end = i;
    while (end + 1 < work.length && end + 1 - i < CHUNK && orig[end + 1] !== work[end + 1]) end += 1;
    runs.push({ address: i, bytes: work.slice(i, end + 1) });
    i = end + 1;
  }
  return runs;
}

// ---------- 기기 통신 ----------

class CompxDevice {
  constructor(devices) {
    this.devices = devices;
    this.dev = devices.find(CompxDevice.hasConfigCollection) || null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.info = null;
    this._listener = (e) => this._onInput(e);
  }

  // 설정용 인터페이스: 입력·출력 리포트가 각각 8번 하나뿐인 컬렉션
  static hasConfigCollection(device) {
    return device.collections.some((c) => c.inputReports.length === 1 && c.outputReports.length === 1
      && c.inputReports[0].reportId === REPORT_ID && c.outputReports[0].reportId === REPORT_ID);
  }

  get vendorId() {
    return this.dev.vendorId;
  }

  get name() {
    return (this.dev && this.dev.productName) || t('마우스');
  }

  async open() {
    if (!this.dev.opened) await this.dev.open();
    this.dev.addEventListener('inputreport', this._listener);
  }

  async close() {
    this.dev.removeEventListener('inputreport', this._listener);
    if (this.dev.opened) await this.dev.close().catch(() => {});
  }

  _onInput(e) {
    const p = this.pending;
    if (!p || e.reportId !== REPORT_ID) return;
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (bytes[0] === p.command) p.resolve(bytes.slice());
  }

  // 패킷 하나를 보내고 같은 명령 번호의 응답을 기다린다. 요청은 한 번에 하나씩 처리한다.
  exchange(command, fill) {
    const run = () => new Promise((resolve, reject) => {
      const packet = new Uint8Array(PACKET_LENGTH);
      packet[0] = command;
      if (fill) fill(packet);
      packet[PACKET_LENGTH - 1] = check(REPORT_ID + sumOf(packet.subarray(0, PACKET_LENGTH - 1)));
      const done = (settle) => (v) => {
        clearTimeout(timer);
        this.pending = null;
        settle(v);
      };
      const timer = setTimeout(done(reject), TIMEOUT_MS, new Error(t('기기 응답 시간 초과')));
      this.pending = { command, resolve: done(resolve), reject: done(reject) };
      Promise.resolve(this.dev.sendReport(REPORT_ID, packet)).catch((e) => this.pending && this.pending.reject(e));
    });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  async accepted(command, fill, what) {
    const r = await this.exchange(command, fill);
    if (r[1] !== 0) throw new Error(t('기기가 {what} 요청을 거부했습니다 (상태 {status}).', { what: t(what), status: r[1] }));
    return r;
  }

  async identify() {
    const r = await this.accepted(CMD.IDENTIFY, (p) => {
      p[4] = 8;
      crypto.getRandomValues(p.subarray(5, 9));
    }, '식별');
    const type = r[11];
    this.info = { cid: r[9], mid: r[10], type, dongleType: r[12], wired: type === 2 || type === 3, maxRate: MAX_RATE_BY_TYPE[type] || 1000 };
    this.info.raw = Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
    return this.info;
  }

  // 설정을 읽고 쓰는 동안 수신기에 "제어 중"임을 알린다. 마우스가 절전 중이면 offline으로 답한다.
  async setOnline(on) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = await this.accepted(CMD.ONLINE, (p) => { p[5] = on ? 1 : 0; }, '제어 전환');
      if (r[9] !== 1) {
        if (on && r[5] !== 1) throw new Error(t('마우스가 응답하지 않습니다. 마우스를 움직이거나 버튼을 누른 뒤 다시 시도하세요.'));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(t('수신기가 계속 사용 중입니다. 잠시 뒤 다시 시도하세요.'));
  }

  async withControl(fn) {
    await this.setOnline(true);
    try {
      return await fn();
    } finally {
      await this.setOnline(false).catch(() => {});
    }
  }

  async readFlash(address, length) {
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += CHUNK) {
      const count = Math.min(CHUNK, length - off);
      const a = address + off;
      const r = await this.accepted(CMD.READ_FLASH, (p) => p.set([a >> 8, a & 0xff, count], 2), '읽기');
      out.set(r.subarray(5, 5 + count), off);
    }
    return out;
  }

  async writeFlash(address, bytes) {
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const chunk = bytes.subarray(off, off + CHUNK);
      const a = address + off;
      await this.accepted(CMD.WRITE_FLASH, (p) => {
        p.set([a >> 8, a & 0xff, chunk.length], 2);
        p.set(chunk, 5);
      }, '쓰기');
    }
  }

  // 프로필(0부터)을 바꾼다. 바꾼 뒤에는 설정 이미지를 다시 읽어야 한다.
  setProfile(index) {
    if (!Number.isInteger(index) || index < 0 || index >= PROFILE_COUNT) throw new Error(t('프로필 번호가 범위를 벗어났습니다.'));
    return this.accepted(CMD.SET_PROFILE, (p) => p.set([1, index], 4), '프로필 전환');
  }

  // 상태 조회. 지원하지 않는 항목은 null.
  async readExtras() {
    const optional = (command) => this.exchange(command).then((r) => (r[1] === 0 ? r : null), () => null);
    const battery = await optional(CMD.BATTERY);
    const version = await optional(CMD.VERSION);
    const dongle = await optional(CMD.DONGLE_VERSION);
    const profile = await optional(CMD.GET_PROFILE);
    const ver = (r) => (r ? `${r[5]}.${r[6].toString(16).padStart(2, '0')}` : null);
    return {
      battery: battery && battery[5] <= 100 ? { percent: battery[5], charging: battery[6] === 1 } : null,
      firmware: ver(version), dongleFirmware: ver(dongle),
      profile: profile && profile[5] < PROFILE_COUNT ? profile[5] : null,
    };
  }
}

const filters = VENDOR_IDS.map((vendorId) => ({ vendorId }));

export {
  filters, VENDOR_IDS, VENDOR_VGN, VENDOR_ATK, MODELS, modelFor, FLASH, IMAGE_LENGTH, DPI_SLOTS, DPI_MIN, DPI_MAX, DPI_STEP, DEBOUNCE_MAX,
  BUTTON_NAMES, RATES, LOD, SLEEP, KEY_ACTIONS, PROFILE_COUNT, DPI_LIGHT, DPI_LIGHT_SPEED_MAX, BRIGHTNESS,
  parse, decodeRate, encodeRate, decodeDpi, setDpi, snapDpi, setScalar, decodeKey, setKey, keyLabel, diffRuns, check,
  decodeDpiColor, setDpiColor, setDpiLightKind,
  CompxDevice,
};
