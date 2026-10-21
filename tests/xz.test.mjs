import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { decompress } from '../js/xz.js';

const { samples } = JSON.parse(fs.readFileSync(new URL('./fixtures/xz-samples.json', import.meta.url)));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('xz and lzma samples made by Python decompress exactly', () => {
  for (const s of samples) {
    const out = decompress(Buffer.from(s.packed, 'base64'));
    assert.equal(out.length, s.size, s.name);
    assert.equal(sha256(out), s.sha256, s.name);
  }
});

test('the compressed definition decodes to the same JSON', () => {
  const s = samples[0];
  const json = JSON.parse(new TextDecoder().decode(decompress(Buffer.from(s.packed, 'base64'))));
  assert.equal(json.name, 'QK80 MK2');
});

// 블록 뒤의 목록(index)과 꼬리는 풀 때 쓰지 않아 검사하지 않는다. 블록 머리·데이터·검사 값의 손상은 알아챈다.
test('damaged data is rejected instead of returning garbage', () => {
  for (const s of samples.slice(0, 3)) {
    const bytes = Buffer.from(s.packed, 'base64');
    for (const at of [8, 40, Math.floor(bytes.length / 2), bytes.length - 40]) {
      const bad = Uint8Array.from(bytes);
      bad[at] ^= 0x55;
      assert.throws(() => { const out = decompress(bad); if (sha256(out) !== s.sha256) throw new Error('mismatch'); }, undefined, `${s.name} @${at}`);
    }
  }
  assert.throws(() => decompress(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 1])), /풀 수 없습니다/);
});
