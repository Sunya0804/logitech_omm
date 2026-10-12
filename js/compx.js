// VGN 계열(제조사 ID 0x3554) 마우스가 쓰는 16바이트 설정 프로토콜.
// 설정은 기기의 플래시 메모리에 주소별로 저장되고, HID 리포트 8번으로 읽고 쓴다.
// 명령 번호와 주소는 OpenMouse(mouse-protocol)가 정리한 내용을 참고했다. 코드는 가져오지 않았다.
(function (OMM) {
  'use strict';

  const VENDOR_ID = 0x3554;
  const REPORT_ID = 0x08;
  const PACKET_LENGTH = 16;
  const CHUNK = 10; // 한 패킷에 실리는 데이터 바이트 수
  const TIMEOUT_MS = 1200;

  const CMD = {
    IDENTIFY: 0x01, ONLINE: 0x03, BATTERY: 0x04, WRITE_FLASH: 0x07, READ_FLASH: 0x08,
    GET_PROFILE: 0x0e, VERSION: 0x12, DONGLE_VERSION: 0x1d,
  };

  // 플래시 주소. 한 바이트짜리 값은 바로 뒤에 검사 바이트(0x55 - 값)가 붙는다.
  const FLASH = {
    reportRate: 0, stageCount: 2, currentStage: 4, lod: 10,
    dpi: 12, // 단계당 4바이트 × 8
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

  // DPI 기록 [값, 값(복사본), 플래그, 검사]. 검사가 맞지 않으면 null.
  function decodeDpi(image, slot) {
    const o = FLASH.dpi + 4 * slot;
    const [low, dup, flags, sum] = image.subarray(o, o + 4);
    if (low !== dup || ((low + dup + flags + sum) & 0xff) !== 0x55) return null;
    let dpi = ((((flags >> 2) & 0x03) << 8) + low + 1) * DPI_STEP;
    if (flags & 0x01) dpi *= 2; // 높은 DPI 영역 표시. 이 범위는 읽기만 하고 직접 쓰지는 않는다.
    if (flags & 0x02) dpi *= 2;
    return dpi;
  }

  // dpi는 snapDpi를 거친 값이어야 한다. 실기기(DragonFly F2 Ultra+)에 저장돼 있던 42,000 DPI 기록
  // a3 a3 55 ba 와 같은 바이트가 나오는 것을 확인했다.
  function setDpi(image, slot, dpi) {
    const doubled = dpi >= DPI_HIGH_FROM;
    const raw = (doubled ? dpi / 2 : dpi) / DPI_STEP - 1;
    const low = raw & 0xff;
    const high = (raw >> 8) & 0x03;
    const flags = (high << 2) | (high << 6) | (doubled ? 0x11 : 0);
    image.set([low, low, flags, check(low + low + flags)], FLASH.dpi + 4 * slot);
  }

  // 기기가 표현할 수 있는 값으로 맞춘다: 30,000까지 50 단위, 그 위로는 100 단위.
  function snapDpi(v) {
    const clamped = Math.min(DPI_MAX, Math.max(DPI_MIN, v));
    if (clamped > (DPI_HIGH_FROM + 30000) / 2) return Math.max(DPI_HIGH_FROM, Math.round(clamped / 100) * 100);
    return Math.min(30000, Math.round(clamped / DPI_STEP) * DPI_STEP);
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

  function parse(image) {
    const stages = [];
    for (let i = 0; i < DPI_SLOTS; i++) stages.push(decodeDpi(image, i));
    // 쓸 수 있는 단계 수: 앞에서부터 연속으로 유효한 기록이 있는 칸까지
    const usable = stages.findIndex((s) => s === null);
    return {
      rate: decodeRate(image[FLASH.reportRate]),
      stageCount: image[FLASH.stageCount], currentStage: image[FLASH.currentStage], stages,
      maxStages: usable < 0 ? DPI_SLOTS : usable,
      lod: image[FLASH.lod], debounce: image[FLASH.debounce], sleep: image[FLASH.sleep],
      motionSync: image[FLASH.motionSync] === 1, angleSnap: image[FLASH.angleSnap] === 1, ripple: image[FLASH.ripple] === 1,
      keys: BUTTON_NAMES.map((_, i) => decodeKey(image, i)),
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

    get name() {
      return (this.dev && this.dev.productName) || 'VGN 마우스';
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
        const timer = setTimeout(done(reject), TIMEOUT_MS, new Error('기기 응답 시간 초과'));
        this.pending = { command, resolve: done(resolve), reject: done(reject) };
        Promise.resolve(this.dev.sendReport(REPORT_ID, packet)).catch((e) => this.pending && this.pending.reject(e));
      });
      const p = this.queue.then(run);
      this.queue = p.catch(() => {});
      return p;
    }

    async accepted(command, fill, what) {
      const r = await this.exchange(command, fill);
      if (r[1] !== 0) throw new Error(`기기가 ${what} 요청을 거부했습니다 (상태 ${r[1]}).`);
      return r;
    }

    async identify() {
      const r = await this.accepted(CMD.IDENTIFY, (p) => {
        p[4] = 8;
        crypto.getRandomValues(p.subarray(5, 9));
      }, '식별');
      const type = r[11];
      this.info = { cid: r[9], mid: r[10], type, dongleType: r[12], wired: type === 2 || type === 3, maxRate: MAX_RATE_BY_TYPE[type] || 1000 };
      return this.info;
    }

    // 설정을 읽고 쓰는 동안 수신기에 "제어 중"임을 알린다. 마우스가 절전 중이면 offline으로 답한다.
    async setOnline(on) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await this.accepted(CMD.ONLINE, (p) => { p[5] = on ? 1 : 0; }, '제어 전환');
        if (r[9] !== 1) {
          if (on && r[5] !== 1) throw new Error('마우스가 응답하지 않습니다. 마우스를 움직이거나 버튼을 누른 뒤 다시 시도하세요.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('수신기가 계속 사용 중입니다. 잠시 뒤 다시 시도하세요.');
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
        profile: profile ? profile[5] : null,
      };
    }
  }

  OMM.compx = {
    VENDOR_ID, FLASH, IMAGE_LENGTH, DPI_SLOTS, DPI_MIN, DPI_MAX, DPI_STEP, DEBOUNCE_MAX,
    BUTTON_NAMES, RATES, LOD, SLEEP, KEY_ACTIONS,
    filters: [{ vendorId: VENDOR_ID }],
    parse, decodeRate, encodeRate, decodeDpi, setDpi, snapDpi, setScalar, decodeKey, setKey, keyLabel, diffRuns, check,
    CompxDevice,
  };
})((window.OMM = window.OMM || {}));
