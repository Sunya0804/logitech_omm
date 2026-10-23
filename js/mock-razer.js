// 가상 Razer 마우스: razer.js의 90바이트 규격에 답한다. 데모와 시험에서만 쓰고 WebHID에 접근하지 않는다.
// o: { productId, productName, blocked: 브라우저가 기능 보고서를 막은 상황, busyReplies: 처음 몇 번 「처리 중」으로 답할지 }
import { checksum } from './razer.js';

export class MockRazer {
  constructor(o = {}) {
    this.vendorId = 0x1532;
    this.productId = o.productId ?? 0x00c1;
    this.productName = o.productName ?? 'Razer Viper V3 Pro';
    this.collections = [{ usagePage: 1, usage: 2, children: [], inputReports: [], outputReports: [], featureReports: [{ reportId: 0 }] }];
    this.blocked = !!o.blocked;
    this.busyReplies = o.busyReplies ?? 0;
    this.tid = o.tid ?? null; // 이 값과 다른 트랜잭션 ID에는 답하지 않는다(null이면 모두 받는다)
    this.opened = false;
    this.sent = [];
    this.stages = [[400, 400], [800, 800], [1600, 1600], [3200, 3200]];
    this.active = 3; // 1부터 센다
    this.dpi = [1600, 1600];
    this.rateDivisor8k = 8; // 1000 Hz
    this.rateDivisor1k = 1;
    this.sleep = 300;
    this.battery = 204; // 0~255 (80%)
    this.reply = new Uint8Array(90);
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendFeatureReport(reportId, data) {
    if (this.blocked) throw new DOMException('Failed to write the feature report.', 'NotAllowedError');
    const p = Uint8Array.from(data);
    this.sent.push(p);
    const out = new Uint8Array(90);
    out.set(p.slice(0, 8));
    if (this.tid !== null && p[1] !== this.tid) { this.reply = new Uint8Array(90); this.reply[88] = 0xff; return; } // 답하지 않음(체크섬도 틀림)
    const [cls, id] = [p[6], p[7]];
    const args = [...p.slice(8, 8 + p[5])];
    const value = this.handle(cls, id, args);
    if (value === undefined) out[0] = 5;
    else { out[0] = 2; out.set(value.slice(0, 80), 8); }
    out[88] = checksum(out);
    this.reply = out;
  }
  async receiveFeatureReport() {
    if (this.blocked) throw new DOMException('Failed to receive the feature report.', 'NotAllowedError');
    if (this.busyReplies > 0) {
      this.busyReplies--;
      const busy = Uint8Array.from(this.reply); busy[0] = 1; busy[88] = checksum(busy);
      return new DataView(busy.buffer);
    }
    return new DataView(this.reply.buffer.slice(0));
  }
  handle(cls, id, a) {
    const key = `${cls}:${id}`;
    switch (key) {
      case '0:129': return [1, 12];
      case '7:128': return [0, this.battery];
      case '7:132': return [0, 0];
      case '7:131': return [this.sleep >> 8, this.sleep & 0xff];
      case '7:3': this.sleep = (a[0] << 8) | a[1]; return a;
      case '4:133': return [a[0], this.dpi[0] >> 8, this.dpi[0] & 0xff, this.dpi[1] >> 8, this.dpi[1] & 0xff, 0, 0];
      case '4:5': this.dpi = [(a[1] << 8) | a[2], (a[3] << 8) | a[4]]; return a;
      case '4:134': {
        const out = new Array(0x26).fill(0);
        out[0] = a[0]; out[1] = this.active; out[2] = this.stages.length;
        this.stages.forEach(([x, y], i) => { const o = 3 + i * 7; out[o] = i; out[o + 1] = x >> 8; out[o + 2] = x & 0xff; out[o + 3] = y >> 8; out[o + 4] = y & 0xff; });
        return out;
      }
      case '4:6':
        this.active = a[1];
        this.stages = Array.from({ length: a[2] }, (_, i) => { const o = 3 + i * 7; return [(a[o + 1] << 8) | a[o + 2], (a[o + 3] << 8) | a[o + 4]]; });
        return a;
      case '0:133': return [this.rateDivisor1k];
      case '0:5': this.rateDivisor1k = a[0]; return a;
      case '0:192': return [0, this.rateDivisor8k];
      case '0:64': this.rateDivisor8k = a[1]; return a;
      default: return undefined;
    }
  }
}
