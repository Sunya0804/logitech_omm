// WebHID simulator backed by read-only captures of the user's actual mice.
// All writes below affect an in-memory byte array, never a physical HID device.
export class CapturedMouse {
  constructor(capture) {
    this.vendorId = capture.vendor_id; this.productId = capture.product_id;
    this.productName = capture.product_string; this.opened = false; this.writes = [];
    this.reads = Object.fromEntries(Object.entries(capture.reads).filter(([, v]) => v)
      .map(([key, hex]) => [Number(key), Uint8Array.from(hex.match(/../g), h => parseInt(h, 16))]));
    this.collections = [{ usagePage: 0xff01, usage: 1, children: [], inputReports: [], outputReports: [],
      featureReports: [{ reportId: 0x11 }, { reportId: 0x12 }] }];
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendFeatureReport(report, bytes) {
    const t = Uint8Array.from(bytes, b => b ^ 255); this.command = t[0]; this.report = report;
    if (t[0] === 0x68) { this.reply = Uint8Array.from([t[1], ...new TextEncoder().encode(this.profileNames?.[t[1]] ?? `Profile ${t[1] + 1}`), 0]); return; }
    if (this.reads[t[0]]) { this.reply = this.reads[t[0]]; return; }
    this.writes.push([report, Array.from(t)]);
    if (this.rejectWrites) return;
    if (t[0] === 0x57) this.reads[0x67] = t.slice(1);
    else if (t[0] === 0x0a) this.reads[0x67][19] = t[2];
    else if (t[0] === 0x58) this.reads[0x67][0] = t[1];
    else if (t[0] === 0x42) {
      const raw = this.reads[0x67]; raw[17] = (raw[17] & ~3) | t[1];
      for (const [i, mask] of [[2, 4], [3, 8], [4, 16]]) if (t[i]) raw[17] = t[i] === 1 ? raw[17] | mask : raw[17] & ~mask;
      if (t[7]) raw[17] = (raw[17] & 63) | ((t[7] === 1 ? 0 : t[7]) << 6);
      if (t[8]) raw[49] = t[9];
    } else if (t[0] === 0x52) this.reads[0x67].set([(t[1] << 4) | t[3], ...t.slice(4, 7)], 20 + 4 * t[1]);
    else throw new Error(`Unexpected write command ${t[0].toString(16)}`);
  }
  async receiveFeatureReport(report) {
    const result = Uint8Array.from([report, this.command ^ 255, ...Array.from(this.reply || [], b => b ^ 255)]);
    return new DataView(result.buffer);
  }
}
