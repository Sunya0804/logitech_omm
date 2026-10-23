// 가상 WLMouse 마우스: wlmouse.js의 기능 보고서 0번 규격에 답한다. 데모와 시험에서만 쓰고 WebHID에 접근하지 않는다.
// o: { productId, productName, unsupported: ['page:command', ...], shifted: 답 앞에 보고서 번호를 붙이는지 }
const OK = 0xa1, UNSUPPORTED = 0xa2;

export class MockWLMouse {
  constructor(o = {}) {
    this.vendorId = 0x36a7;
    this.productId = o.productId ?? 0xa883;
    this.productName = o.productName ?? 'WLmouse Beast X';
    this.pairedId = o.pairedId ?? 0xa883;
    this.collections = [{ usagePage: 0xffff, usage: 1, children: [], inputReports: [], outputReports: [], featureReports: [{ reportId: 0 }] }];
    this.unsupported = new Set(o.unsupported ?? []);
    this.shifted = !!o.shifted;
    this.opened = false;
    this.writes = [];
    this.battery = { percent: 87, charging: false };
    this.profile = 1;
    this.debounce = 4;
    this.sleep = 120;
    this.settings = {
      stages: [[400, 400], [800, 800], [1600, 1600], [3200, 3200]], active: 2, rate: 0x01, lod: 0x01, angle: 0,
      flags: { 0x84: 0, 0x89: 1, 0x8a: 0, 0x8b: 0, 0x93: 0 },
    };
    this.reply = new Uint8Array(64);
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }

  async sendFeatureReport(reportId, data) {
    const p = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    const [target, length, page, command] = [p[2], p[3], p[4], p[5]];
    const args = [...p.slice(6, 6 + length)];
    const out = new Uint8Array(64);
    out[2] = target; out[4] = page; out[5] = command;
    let value = [];
    if (this.unsupported.has(`${page}:${command}`)) out[0] = UNSUPPORTED;
    else {
      out[0] = OK;
      value = command & 0x80 ? this.read(target, page, command, args) : this.write(page, command, args);
    }
    out[3] = value.length;
    out.set(value, 6);
    this.reply = this.shifted ? Uint8Array.from([0, ...out.slice(0, 63)]) : out;
  }
  async receiveFeatureReport() { return new DataView(this.reply.buffer.slice(0)); }

  read(target, page, command, args) {
    const s = this.settings;
    if (page === 0) {
      if (command === 0x81) return target === 0 ? [0, 0, 3, 4] : [0, 0, 1, 2];
      if (command === 0x83) return [this.battery.charging ? 1 : 0, this.battery.percent];
      if (command === 0x85) return [this.profile];
      if (command === 0x87) return [args[0], this.sleep >> 8, this.sleep & 0xff];
      if (command === 0x88) return [args[0], this.debounce];
      if (command === 0x8b && target === 1) return [0x02, 0, 0, 0, this.pairedId >> 8, this.pairedId & 0xff];
    }
    if (page === 1) {
      if (command === 0x80) return [args[0], s.rate];
      if (command === 0x81) return [args[0], s.stages.length, ...s.stages.flatMap(([x, y]) => [x >> 8, x & 0xff, y >> 8, y & 0xff])];
      if (command === 0x82) return [args[0], s.active + 1];
      if (command === 0x88) return [args[0], s.lod];
      if (command === 0x94) return [args[0], s.angle & 0xff];
      if (command in s.flags) return [args[0], s.flags[command]];
    }
    return [];
  }
  write(page, command, args) {
    this.writes.push([page, command, ...args]);
    const s = this.settings;
    const [, ...v] = args;
    if (page === 0 && command === 0x07) this.sleep = (v[0] << 8) | v[1];
    else if (page === 0 && command === 0x08) this.debounce = v[0];
    else if (page === 1 && command === 0x00) s.rate = v[0];
    else if (page === 1 && command === 0x01) s.stages = Array.from({ length: v[0] }, (_, i) => [(v[1 + i * 4] << 8) | v[2 + i * 4], (v[3 + i * 4] << 8) | v[4 + i * 4]]);
    else if (page === 1 && command === 0x02) s.active = v[0] - 1;
    else if (page === 1 && command === 0x08) s.lod = v[0];
    else if (page === 1 && command === 0x14) s.angle = v[0] > 0x7f ? v[0] - 0x100 : v[0];
    else if (page === 1 && (command | 0x80) in s.flags) s.flags[command | 0x80] = v[0];
    return [args[0]];
  }
}
