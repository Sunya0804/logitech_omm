import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/compx.js';

const image = () => new Uint8Array(C.IMAGE_LENGTH);
const vgn = C.modelFor(C.VENDOR_VGN, 0, 0);
const ultra = C.modelFor(C.VENDOR_ATK, 1, 13);
const recordAt = (img, slot) => Array.from(img.subarray(C.FLASH.dpi + 4 * slot, C.FLASH.dpi + 4 * slot + 4));

test('DPI records match bytes read from real mice', () => {
  // DragonFly F2 Ultra+ (VGN): 42,000 DPI
  const img = image();
  C.setDpi(img, 0, 42000, vgn);
  assert.deepEqual(recordAt(img, 0), [0xa3, 0xa3, 0x55, 0xba]);
  assert.equal(C.decodeDpi(img, 0, vgn), 42000);
  // F1 LEVIATAN 2.0 (Ultra 방식): 400, 3,200
  C.setDpi(img, 1, 400, ultra);
  C.setDpi(img, 2, 3200, ultra);
  assert.deepEqual(recordAt(img, 1), [0x27, 0x27, 0x00, 0x07]);
  assert.deepEqual(recordAt(img, 2), [0x3f, 0x3f, 0x44, 0x93]);
  assert.equal(C.decodeDpi(img, 2, ultra), 3200);
  // 검사 바이트가 맞지 않으면 읽지 않는다
  img[C.FLASH.dpi + 3] ^= 1;
  assert.equal(C.decodeDpi(img, 0, vgn), null);
});

test('every snapped DPI survives a write and read', () => {
  for (const model of [vgn, ultra]) {
    const img = image();
    for (let v = model.dpiMin; v <= model.dpiMax; v += 7) {
      const dpi = C.snapDpi(v, model);
      C.setDpi(img, 0, dpi, model);
      assert.equal(C.decodeDpi(img, 0, model), dpi, `${model.model || model.brand} ${v}`);
    }
  }
});

test('snapDpi rounds to what the sensor can store', () => {
  assert.equal(C.snapDpi(1234, vgn), 1250);
  assert.equal(C.snapDpi(10, vgn), vgn.dpiMin);
  assert.equal(C.snapDpi(99999, vgn), vgn.dpiMax);
  assert.equal(C.snapDpi(1234, ultra), 1230);
  assert.equal(C.snapDpi(10030, ultra), 10050);
  assert.equal(C.snapDpi(20020, ultra), 20000);
});

test('diffRuns groups changed bytes into packets', () => {
  const orig = image();
  const work = orig.slice();
  assert.deepEqual(C.diffRuns(orig, work), []);
  work[5] = 1; work[6] = 2; work[9] = 3;
  work.fill(7, 100, 125);
  const runs = C.diffRuns(orig, work);
  assert.deepEqual(runs.map((r) => [r.address, r.bytes.length]), [[5, 2], [9, 1], [100, 10], [110, 10], [120, 5]]);
  for (const r of runs) assert.deepEqual(Array.from(r.bytes), Array.from(work.subarray(r.address, r.address + r.bytes.length)));
});

test('report rates encode both ways', () => {
  for (const hz of C.RATES) assert.equal(C.decodeRate(C.encodeRate(hz)), hz);
});

test('sensor mode is read only when its check byte matches', () => {
  // ATK 웹허브: 주소 185에 0 기본, 1 경기용, 2 경기용 MAX, 186에 검사 바이트(0x55 - 값)
  const img = image().fill(0xff);
  assert.equal(C.parse(img, ultra).sensorMode, null);
  C.setScalar(img, C.FLASH.sensorMode, 2);
  assert.deepEqual(Array.from(img.subarray(185, 187)), [2, 0x53]);
  assert.equal(C.parse(img, ultra).sensorMode, 2);
  img[186] ^= 1;
  assert.equal(C.parse(img, ultra).sensorMode, null);
  img[185] = 3;
  img[186] = 0x52;
  assert.equal(C.parse(img, ultra).sensorMode, null);
});
