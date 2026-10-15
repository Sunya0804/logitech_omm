// 영어 번역표(js/i18n-en.js)에 화면 문구가 빠짐없이 있는지 확인한다.
// 코드의 한글 문자열과 index.html의 data-i18n 문구를 모아 번역표의 키와 비교한다.
// 주석과 「i18n-ignore」 표시가 붙은 줄(개발자용 이슈 본문 등)은 제외한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EN from '../js/i18n-en.js';
import { OPTIONS } from '../js/mchose-actions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANGUL = /[가-힣]/;
// 화면에 나오지 않는 파일: 가상 기기, 기종표 출처 설명, 번역표 자체
const SKIP = new Set(['i18n-en.js', 'mock.js', 'mock-compx.js', 'device-images.js', 'compx-models.js', 'mchose-models.js']);

export function sourceStrings() {
  const found = new Set();
  for (const file of fs.readdirSync(path.join(root, 'js'))) {
    if (!file.endsWith('.js') || SKIP.has(file)) continue;
    const lines = fs.readFileSync(path.join(root, 'js', file), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (line.includes('i18n-ignore')) continue;
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '');
      if (!HANGUL.test(code)) continue;
      for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) {
        const text = (m[1] ?? m[2]).replace(/\\(.)/g, '$1');
        if (HANGUL.test(text)) found.add(text);
      }
    }
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n\b(?!-)[^>]*>([^<]+)</g)) found.add(m[2].trim());
  for (const m of html.matchAll(/(?:aria-label|title|placeholder)="([^"]*[가-힣][^"]*)"/g)) found.add(m[1]);
  // MCHOSE 버튼 동작 이름은 코드에서 만들어지므로 목록에서 직접 가져온다.
  for (const label of OPTIONS) if (HANGUL.test(label)) found.add(label);
  return found;
}

test('every Korean UI string has an English translation', () => {
  const missing = [...sourceStrings()].filter((s) => !(s in EN));
  assert.deepEqual(missing, [], `번역표에 없는 문구 ${missing.length}개`);
});

test('translations keep the same {placeholders}', () => {
  const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const wrong = Object.entries(EN).filter(([ko, en]) => names(ko) !== names(en)).map(([ko]) => ko);
  assert.deepEqual(wrong, []);
});

test('translations contain no Korean', () => {
  assert.deepEqual(Object.values(EN).filter((en) => HANGUL.test(en)), []);
});
