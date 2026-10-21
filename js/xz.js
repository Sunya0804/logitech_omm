// .xz(LZMA2)와 .lzma(LZMA alone) 압축 풀기. Vial 키보드는 정의 파일을 xz로 압축해 펌웨어에 넣어 둔다.
// 브라우저의 DecompressionStream은 xz를 풀지 못해서 직접 푼다. xz 파일 형식 문서와 LZMA 명세를 따라 새로 작성했다.
// 출력 전체를 사전으로 쓰므로(정의 파일은 수십 KB) 사전 크기 설정은 보지 않는다.
import { t } from './i18n.js';

const MAX_OUTPUT = 16 * 1024 * 1024;
const fail = (what) => { throw new Error(t('압축된 정의 파일을 풀 수 없습니다 ({what}).', { what })); };

// ---------- 검사 값 ----------

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC64_POLY = 0xc96c5795d7870f42n;
const CRC64_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = BigInt(n);
  for (let k = 0; k < 8; k++) c = c & 1n ? CRC64_POLY ^ (c >> 1n) : c >> 1n;
  return c;
});
function crc64(bytes) {
  let c = 0xffffffffffffffffn;
  for (const b of bytes) c = CRC64_TABLE[Number((c ^ BigInt(b)) & 0xffn)] ^ (c >> 8n);
  return c ^ 0xffffffffffffffffn;
}

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le64 = (b, o) => BigInt(le32(b, o)) | (BigInt(le32(b, o + 4)) << 32n);

// ---------- 출력 (사전 겸용) ----------

class Output {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; }
  reserve(n) {
    if (this.pos + n <= this.buf.length) return;
    if (this.pos + n > MAX_OUTPUT) fail('too large');
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(Math.min(size, MAX_OUTPUT));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  push(b) { this.reserve(1); this.buf[this.pos++] = b; }
  // dist: 0이면 바로 앞 바이트. 겹치는 복사(반복)도 한 바이트씩 처리한다.
  copy(dist, len, start) {
    if (dist >= this.pos - start) fail('distance');
    this.reserve(len);
    const { buf } = this;
    for (let i = 0; i < len; i++, this.pos++) buf[this.pos] = buf[this.pos - dist - 1];
  }
  result() { return this.buf.slice(0, this.pos); }
}

// ---------- 범위 부호기 ----------

class RangeDecoder {
  constructor(input, pos, end) {
    if (pos + 5 > end || input[pos] !== 0) fail('range coder');
    this.input = input; this.end = end; this.pos = pos + 1;
    this.range = 0xffffffff; this.code = 0;
    for (let i = 0; i < 4; i++) this.code = this.code * 256 + input[this.pos++];
  }
  next() { if (this.pos >= this.end) fail('truncated'); return this.input[this.pos++]; }
  normalize() {
    if (this.range < 0x1000000) { this.range *= 256; this.code = this.code * 256 + this.next(); }
  }
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((2048 - p) >>> 5); b = 0; }
    else { this.range -= bound; this.code -= bound; probs[i] = p - (p >>> 5); b = 1; }
    this.normalize();
    return b;
  }
  direct(count) {
    let r = 0;
    for (let i = 0; i < count; i++) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      r = r * 2 + b;
      this.normalize();
    }
    return r;
  }
  tree(probs, base, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = m * 2 + this.bit(probs, base + m);
    return m - (1 << bits);
  }
  reverse(probs, base, bits) {
    let m = 1; let sym = 0;
    for (let i = 0; i < bits; i++) { const b = this.bit(probs, base + m); m = m * 2 + b; sym |= b << i; }
    return sym;
  }
}

// ---------- LZMA ----------

const STATES = 12;
const POS_STATES = 16;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 128;

class LengthDecoder {
  constructor() { this.probs = new Uint16Array(2 + POS_STATES * 8 * 2 + 256); }
  reset() { this.probs.fill(1024); }
  decode(rc, posState) {
    const p = this.probs;
    if (rc.bit(p, 0) === 0) return rc.tree(p, 2 + posState * 8, 3);
    if (rc.bit(p, 1) === 0) return 8 + rc.tree(p, 2 + POS_STATES * 8 + posState * 8, 3);
    return 16 + rc.tree(p, 2 + POS_STATES * 16, 8);
  }
}

class LzmaDecoder {
  constructor(out) {
    this.out = out;
    this.isMatch = new Uint16Array(STATES * POS_STATES);
    this.isRep = new Uint16Array(STATES);
    this.isRepG0 = new Uint16Array(STATES);
    this.isRepG1 = new Uint16Array(STATES);
    this.isRepG2 = new Uint16Array(STATES);
    this.isRep0Long = new Uint16Array(STATES * POS_STATES);
    this.posSlot = new Uint16Array(4 * 64);
    this.posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL);
    this.align = new Uint16Array(16);
    this.len = new LengthDecoder();
    this.repLen = new LengthDecoder();
    this.literal = null;
    this.dictStart = 0;
  }

  setProps(byte) {
    if (byte >= 9 * 5 * 5) fail('properties');
    this.lc = byte % 9; this.lp = Math.floor(byte / 9) % 5; this.pb = Math.floor(byte / 45);
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  resetState() {
    for (const p of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posSpecial, this.align, this.literal]) p.fill(1024);
    this.len.reset(); this.repLen.reset();
    this.state = 0; this.reps = [0, 0, 0, 0];
  }

  // 출력이 end 바이트가 될 때까지 푼다. end가 Infinity면 끝 표시까지 푼다(.lzma). 끝 표시를 만나면 true.
  run(rc, end) {
    const { out } = this;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    const reps = this.reps;
    let state = this.state;
    while (out.pos < end) {
      const posState = out.pos & pbMask;
      if (rc.bit(this.isMatch, state * POS_STATES + posState) === 0) {
        const prev = out.pos > this.dictStart ? out.buf[out.pos - 1] : 0;
        const base = 0x300 * (((out.pos & lpMask) << this.lc) + (prev >> (8 - this.lc)));
        let sym = 1;
        if (state >= 7) {
          if (reps[0] >= out.pos - this.dictStart) fail('distance');
          let match = out.buf[out.pos - reps[0] - 1];
          while (sym < 0x100) {
            const matchBit = (match >> 7) & 1;
            match <<= 1;
            const b = rc.bit(this.literal, base + 0x100 + (matchBit << 8) + sym);
            sym = (sym << 1) | b;
            if (b !== matchBit) break;
          }
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.literal, base + sym);
        out.push(sym & 0xff);
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let length;
      if (rc.bit(this.isRep, state) === 1) {
        if (out.pos === this.dictStart) fail('distance');
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, state * POS_STATES + posState) === 0) {
            state = state < 7 ? 9 : 11;
            out.copy(reps[0], 1, this.dictStart);
            continue;
          }
        } else {
          let dist;
          if (rc.bit(this.isRepG1, state) === 0) dist = reps[1];
          else {
            if (rc.bit(this.isRepG2, state) === 0) dist = reps[2];
            else { dist = reps[3]; reps[3] = reps[2]; }
            reps[2] = reps[1];
          }
          reps[1] = reps[0]; reps[0] = dist;
        }
        length = this.repLen.decode(rc, posState);
        state = state < 7 ? 8 : 11;
      } else {
        reps[3] = reps[2]; reps[2] = reps[1]; reps[1] = reps[0];
        length = this.len.decode(rc, posState);
        state = state < 7 ? 7 : 10;
        const dist = this.distance(rc, length);
        if (dist === 0xffffffff) { this.state = state; return true; } // 끝 표시
        reps[0] = dist;
      }
      length += 2;
      if (out.pos + length > end) fail('length');
      out.copy(reps[0], length, this.dictStart);
    }
    this.state = state;
    return false;
  }

  distance(rc, length) {
    const slot = rc.tree(this.posSlot, Math.min(length, 3) * 64, 6);
    if (slot < 4) return slot;
    const bits = (slot >> 1) - 1;
    let dist = (2 | (slot & 1)) * 2 ** bits;
    if (slot < END_POS_MODEL) return dist + rc.reverse(this.posSpecial, dist - slot, bits);
    dist += rc.direct(bits - 4) * 16;
    return dist + rc.reverse(this.align, 0, 4);
  }
}

// ---------- LZMA2 ----------

function lzma2(input, pos, end, out) {
  const lz = new LzmaDecoder(out);
  let needProps = true;
  for (;;) {
    if (pos >= end) fail('truncated');
    const control = input[pos++];
    if (control === 0x00) return pos;
    if (control === 0x01 || control === 0x02) {
      if (pos + 2 > end) fail('truncated');
      const size = ((input[pos] << 8) | input[pos + 1]) + 1;
      pos += 2;
      if (control === 0x01) lz.dictStart = out.pos;
      if (pos + size > end) fail('truncated');
      out.reserve(size);
      out.buf.set(input.subarray(pos, pos + size), out.pos);
      out.pos += size;
      pos += size;
      continue;
    }
    if (control < 0x80) fail('chunk');
    if (pos + 4 > end) fail('truncated');
    const unpacked = (control & 0x1f) * 65536 + ((input[pos] << 8) | input[pos + 1]) + 1;
    const packed = ((input[pos + 2] << 8) | input[pos + 3]) + 1;
    pos += 4;
    const reset = (control >> 5) & 3;
    if (reset === 3) lz.dictStart = out.pos;
    if (reset >= 2) { lz.setProps(input[pos++]); needProps = false; }
    if (needProps) fail('properties');
    if (reset >= 1) lz.resetState();
    if (pos + packed > end) fail('truncated');
    const rc = new RangeDecoder(input, pos, pos + packed);
    if (lz.run(rc, out.pos + unpacked)) fail('end marker');
    pos += packed;
  }
}

// ---------- 컨테이너 ----------

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const CHECK_SIZE = { 0: 0, 1: 4, 4: 8, 10: 32 };

function readVli(b, pos) {
  let value = 0;
  for (let i = 0; i < 9; i++) {
    const byte = b[pos + i];
    if (byte === undefined) fail('truncated');
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return [value, pos + i + 1];
  }
  return fail('header');
}

function unxz(input) {
  if (input.length < 24) fail('truncated');
  const flags = input.subarray(6, 8);
  if (flags[0] !== 0 || crc32(flags) !== le32(input, 8)) fail('stream header');
  const check = flags[1] & 0x0f;
  if (!(check in CHECK_SIZE)) fail('check type');
  const out = new Output();
  let pos = 12;
  for (;;) {
    const size = input[pos];
    if (size === undefined) fail('truncated');
    if (size === 0) break; // 블록 목록(index)이 시작된다
    const headerEnd = pos + (size + 1) * 4;
    if (headerEnd > input.length || crc32(input.subarray(pos, headerEnd - 4)) !== le32(input, headerEnd - 4)) fail('block header');
    const blockFlags = input[pos + 1];
    let p = pos + 2;
    let compressed = null;
    let uncompressed = null;
    if (blockFlags & 0x40) [compressed, p] = readVli(input, p);
    if (blockFlags & 0x80) [uncompressed, p] = readVli(input, p);
    if ((blockFlags & 0x03) !== 0) fail('filters'); // LZMA2 하나만 받는다
    let filter; let propSize;
    [filter, p] = readVli(input, p);
    [propSize, p] = readVli(input, p);
    if (filter !== 0x21 || propSize !== 1) fail('filters');
    const start = out.pos;
    const dataStart = headerEnd;
    const dataEnd = lzma2(input, dataStart, input.length, out);
    if (compressed !== null && dataEnd - dataStart !== compressed) fail('block size');
    if (uncompressed !== null && out.pos - start !== uncompressed) fail('block size');
    pos = dataEnd;
    while (pos % 4) { if (input[pos++] !== 0) fail('padding'); }
    const block = out.buf.subarray(start, out.pos);
    if (check === 1 && crc32(block) !== le32(input, pos)) fail('CRC32');
    if (check === 4 && crc64(block) !== le64(input, pos)) fail('CRC64');
    pos += CHECK_SIZE[check];
  }
  return out.result();
}

// .lzma: [속성 1][사전 크기 4][풀린 크기 8, 모르면 FF…] 뒤에 LZMA 데이터
function unlzma(input) {
  if (input.length < 18) fail('truncated');
  const size = le64(input, 5);
  const known = size !== 0xffffffffffffffffn;
  if (known && size > BigInt(MAX_OUTPUT)) fail('too large');
  const out = new Output();
  const lz = new LzmaDecoder(out);
  lz.setProps(input[0]);
  lz.resetState();
  const rc = new RangeDecoder(input, 13, input.length);
  const ended = lz.run(rc, known ? Number(size) : MAX_OUTPUT);
  if (!known && !ended) fail('end marker');
  return out.result();
}

// 압축 형식을 보고 푼다
function decompress(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (XZ_MAGIC.every((b, i) => bytes[i] === b)) return unxz(bytes);
  return unlzma(bytes);
}

export { decompress, unxz, unlzma, crc32, crc64 };
