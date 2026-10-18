// VIA(QMK 동적 매크로) 매크로 버퍼의 해석과 기록. 프로토콜 11 이후의 형식이다.
// 버퍼에는 매크로가 0으로 끝나는 문자열로 차례로 들어 있다. 문자열 안에서
//   인쇄 가능한 ASCII(0x20~0x7E): 그 글자를 입력
//   0x01 0x01 키 / 0x01 0x02 키 / 0x01 0x03 키: 기본 키 코드(1바이트) 누르고 떼기 / 누르기 / 떼기
//   0x01 0x04 숫자들 '|': 그 ms만큼 대기 (10진 ASCII)
// 형식은 QMK 문서(feature_dynamic_macros, send_string)에 정리된 것을 따랐다. 코드는 가져오지 않았다.
// 단계의 모양은 js/macro-editor.js와 같다: key{down, mods, usage}, delay{ms}, 그리고 VIA에만 있는 text{text}.
// 알 수 없는 바이트가 나오면 그 매크로는 읽기만 하고(editable: false) 원래 바이트를 그대로 둔다.
import { t } from './i18n.js';

const PREFIX = 0x01;
const ACTION = { TAP: 0x01, DOWN: 0x02, UP: 0x03, DELAY: 0x04 };
const DELAY_END = 0x7c; // '|'
const MAX_DELAY_MS = 9999999;
const printable = (b) => b >= 0x20 && b <= 0x7e;

// 수정자 키(HID 0xE0~0xE7)는 macro-editor처럼 mods 비트로, 나머지는 usage로 둔다.
const keyStep = (down, kc) => (kc >= 0xe0 && kc <= 0xe7 ? { kind: 'key', down, mods: 1 << (kc - 0xe0), usage: 0 } : { kind: 'key', down, mods: 0, usage: kc });

// 매크로 하나(0을 뺀 바이트) → {steps, editable}
function decodeMacro(bytes) {
  const steps = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (printable(b)) {
      let text = '';
      while (i < bytes.length && printable(bytes[i])) text += String.fromCharCode(bytes[i++]);
      steps.push({ kind: 'text', text });
      continue;
    }
    if (b !== PREFIX || i + 1 >= bytes.length) return { steps, editable: false };
    const action = bytes[i + 1];
    if (action === ACTION.DELAY) {
      const end = bytes.indexOf(DELAY_END, i + 2);
      const digits = end < 0 ? '' : String.fromCharCode(...bytes.subarray(i + 2, end));
      if (!/^\d+$/.test(digits)) return { steps, editable: false };
      steps.push({ kind: 'delay', ms: +digits });
      i = end + 1;
      continue;
    }
    const kc = bytes[i + 2];
    if (![ACTION.TAP, ACTION.DOWN, ACTION.UP].includes(action) || kc === undefined || kc === 0) return { steps, editable: false };
    if (action !== ACTION.UP) steps.push(keyStep(true, kc));
    if (action !== ACTION.DOWN) steps.push(keyStep(false, kc));
    i += 3;
  }
  return { steps, editable: true };
}

// 키 단계의 기본 키 코드들. 수정자 비트가 여러 개면 비트마다 하나씩이다.
function keycodesOf(s) {
  const out = [];
  for (let bit = 0; bit < 8; bit++) if (s.mods & (1 << bit)) out.push(0xe0 + bit);
  if (s.usage) out.push(s.usage);
  if (!out.length || out.some((kc) => kc > 0xff)) throw new Error(t('VIA 매크로에 넣을 수 없는 키입니다.'));
  return out;
}

// 단계들 → 바이트(끝의 0은 붙이지 않는다). 같은 키를 바로 누르고 떼면 한 번의 입력(tap)으로 줄인다.
function encodeMacro(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'text') {
      if (![...s.text].every((c) => printable(c.charCodeAt(0)))) throw new Error(t('매크로 글자는 영문·숫자·기호(ASCII)만 넣을 수 있습니다.'));
      out.push(...[...s.text].map((c) => c.charCodeAt(0)));
    } else if (s.kind === 'delay') {
      const ms = Math.min(MAX_DELAY_MS, Math.max(0, Math.round(s.ms)));
      out.push(PREFIX, ACTION.DELAY, ...[...String(ms)].map((c) => c.charCodeAt(0)), DELAY_END);
    } else if (s.kind === 'key') {
      const codes = keycodesOf(s);
      const n = steps[i + 1];
      if (s.down && n?.kind === 'key' && !n.down && n.mods === s.mods && n.usage === s.usage) {
        for (const kc of codes) out.push(PREFIX, ACTION.TAP, kc);
        i++;
      } else {
        for (const kc of codes) out.push(PREFIX, s.down ? ACTION.DOWN : ACTION.UP, kc);
      }
    } else if (s.kind === 'raw') {
      out.push(...s.bytes);
    } else {
      throw new Error(t('VIA 매크로에 넣을 수 없는 단계입니다.'));
    }
  }
  if (out.includes(0)) throw new Error(t('VIA 매크로에 넣을 수 없는 단계입니다.'));
  return out;
}

// 버퍼 → 매크로 count개 [{steps, editable, bytes}]. bytes는 원래 바이트(읽을 수 없는 매크로를 그대로 되돌리는 데 쓴다).
function decodeMacros(buffer, count) {
  const out = [];
  let start = 0;
  for (let n = 0; n < count; n++) {
    let end = buffer.indexOf(0, start);
    if (end < 0) end = buffer.length;
    const bytes = Uint8Array.from(buffer.subarray(start, end));
    out.push({ ...decodeMacro(bytes), bytes });
    start = Math.min(buffer.length, end + 1);
  }
  return out;
}

// 매크로들 → 버퍼 크기만큼의 바이트 (뒤는 0). 각 항목은 steps(편집한 것) 또는 bytes(그대로 둘 것).
function encodeMacros(macros, size) {
  const out = new Uint8Array(size);
  let o = 0;
  for (const m of macros) {
    const bytes = m.steps ? encodeMacro(m.steps) : Array.from(m.bytes || []);
    if (o + bytes.length + 1 > size) throw new Error(t('매크로가 기기의 매크로 저장 공간({size}바이트)보다 깁니다.', { size }));
    out.set(bytes, o);
    o += bytes.length + 1; // 끝의 0
  }
  return out;
}

// 매크로들이 차지하는 바이트 수 (끝의 0 포함)
const macrosLength = (macros) => macros.reduce((n, m) => n + (m.steps ? encodeMacro(m.steps) : m.bytes || []).length + 1, 0);

export { decodeMacro, encodeMacro, decodeMacros, encodeMacros, macrosLength, PREFIX, ACTION };
