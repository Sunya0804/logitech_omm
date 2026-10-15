// MCHOSE 버튼 동작 표. 동작 하나가 세대(V2/V3)마다 어떤 바이트로 저장되는지 적는다.
// 저장 값은 M HUB의 동작 표에 있는 사실 정보이고, 키보드 키는 USB HID 사용 코드(Usage Tables)를 따른다.
//
// V2: 버튼 하나가 [종류, 24비트 값]. 같은 값도 종류에 따라 뜻이 다르다.
// V3: 버튼 하나가 [종류, 값 바이트들]. 값의 길이는 종류가 정하고, 대부분 리틀 엔디언 정수지만
//     조합 키(0x13)와 편집 단축키(0x16)는 [수식키, 키] 순서 그대로 저장한다.

export const V2_BUTTONS = ['Left', 'Middle', 'Right', 'Forward', 'Back', 'DPI'];
export const V3_BUTTONS = ['Left', 'Right', 'Middle', 'Forward', 'Back', 'DPI'];

const MASK = { Left: 1, Right: 2, Middle: 4, Back: 8, Forward: 16, DPI: 0 };
const CTRL = 1, SHIFT = 2, ALT = 4, WIN = 8;

const table = [];
// v2: [종류, 값], v3: [종류, 정수 값]
const add = (label, v2, v3) => table.push({ label, v2, v3 });

add('사용 안 함', [9, 0xffffff], [0xfe, 0]);
for (const [label, button] of [['왼쪽 클릭', 'Left'], ['오른쪽 클릭', 'Right'], ['휠 클릭', 'Middle'], ['앞으로', 'Forward'], ['뒤로', 'Back']]) {
  add(label, [1, MASK[button] << 16], [0x00, MASK[button]]);
}
add('휠 위로', [1, 0x000200], [0x05, 0]);
add('휠 아래로', [1, 0x00fe00], [0x05, 1]);
add('DPI 순환', [5, 0x010000], [0x01, 0]);
add('DPI 올리기', [5, 0x020000], [0x01, 2]);
add('DPI 내리기', [5, 0x030000], [0x01, 3]);
for (const [label, usage] of [['재생/일시정지', 0xcd], ['다음 곡', 0xb5], ['이전 곡', 0xb6], ['정지', 0xb7],
  ['볼륨 올리기', 0xe9], ['볼륨 내리기', 0xea], ['음소거', 0xe2]]) {
  add(label, [3, usage << 16], [0x14, usage]);
}
for (const [label, usage] of [['화면 밝게', 0x6f], ['화면 어둡게', 0x70]]) add(label, [8, 0x0c0000 | (usage << 8)], [0x14, usage]);
for (const [label, usage] of [['복사', 0x06], ['잘라내기', 0x1b], ['붙여넣기', 0x19]]) add(label, [8, 0x070100 | usage], [0x16, 0x0100 | usage]);
for (let n = 1; n <= 3; n++) add(`프로필 ${n}로 전환`, [10, n << 16], [0x33, n - 1]);
add('프로필 순환', [10, 0x040000], [0x33, 0xff]);

const KEYS = [];
for (let i = 0; i < 26; i++) KEYS.push([String.fromCharCode(65 + i), 0x04 + i]);
[...'1234567890'].forEach((c, i) => KEYS.push([c, 0x1e + i]));
for (let i = 1; i <= 12; i++) KEYS.push([`F${i}`, 0x39 + i]);
KEYS.push(['Enter', 0x28], ['Esc', 0x29], ['Backspace', 0x2a], ['Tab', 0x2b], ['Space', 0x2c],
  ['- _', 0x2d], ['= +', 0x2e], ['[ {', 0x2f], ['] }', 0x30], ['\\ |', 0x31], ['; :', 0x33], ['\' "', 0x34],
  ['` ~', 0x35], [', <', 0x36], ['. >', 0x37], ['/ ?', 0x38], ['Caps Lock', 0x39], ['Print Screen', 0x46],
  ['Scroll Lock', 0x47], ['Pause', 0x48], ['Insert', 0x49], ['Home', 0x4a], ['Page Up', 0x4b], ['Delete', 0x4c],
  ['End', 0x4d], ['Page Down', 0x4e], ['→', 0x4f], ['←', 0x50], ['↓', 0x51], ['↑', 0x52],
  ['Num Lock', 0x53], ['Num /', 0x54], ['Num *', 0x55], ['Num -', 0x56], ['Num +', 0x57], ['Num Enter', 0x58]);
for (let i = 1; i <= 9; i++) KEYS.push([`Num ${i}`, 0x58 + i]);
KEYS.push(['Num 0', 0x62], ['Num .', 0x63], ['Menu', 0x65]);
['Ctrl', 'Shift', 'Alt', 'Win'].forEach((m, i) => KEYS.push([`왼쪽 ${m}`, 0xe0 + i], [`오른쪽 ${m}`, 0xe4 + i]));
for (const [label, usage] of KEYS) add(label, [2, usage << 8], [0x11, usage]);

const letter = c => 0x04 + c.charCodeAt(0) - 65;
const COMBOS = [
  ...[...'ACNOSTVWXYZ'].map(c => [`Ctrl + ${c}`, CTRL, letter(c)]),
  ['Ctrl + 0', CTRL, 0x27], ['Ctrl + -', CTRL, 0x2d], ['Ctrl + =', CTRL, 0x2e], ['Ctrl + Esc', CTRL, 0x29],
  ['Ctrl + Shift + Esc', CTRL | SHIFT, 0x29],
  ['Alt + Tab', ALT, 0x2b], ['Alt + F4', ALT, 0x3d], ['Alt + Esc', ALT, 0x29], ['Alt + ←', ALT, 0x50], ['Alt + →', ALT, 0x4f],
  ...[...'ABDEGIKLRSTUX'].map(c => [`Win + ${c}`, WIN, letter(c)]),
  ['Win + Tab', WIN, 0x2b], ['Win + .', WIN, 0x37], ['Win + =', WIN, 0x2e], ['Win + Ctrl + Enter', WIN | CTRL, 0x28],
];
for (const [label, mods, usage] of COMBOS) add(label, [2, (mods << 16) | (usage << 8)], [0x13, (mods << 8) | usage]);

export const DEFAULT_LABEL = '기본값';
// 화면에 내는 선택지. 「기본값」은 버튼의 공장 기능으로 되돌린다.
export const OPTIONS = [DEFAULT_LABEL, ...table.map(a => a.label)];
const byLabel = new Map(table.map(a => [a.label, a]));
const hex = (n, width) => n.toString(16).padStart(width, '0');

// ── V2 ──
// 종류 0은 공장 기능, 4는 매크로(이름만 따로 읽을 수 있다).
export function v2Encode(label) {
  if (label === DEFAULT_LABEL) return [0, 0];
  return byLabel.get(label)?.v2 ?? null;
}
export function v2Describe(type, value) {
  if (type === 0) return DEFAULT_LABEL;
  if (type === 4) return '매크로';
  const hit = table.find(a => a.v2[0] === type && a.v2[1] === value);
  return hit ? hit.label : `알 수 없음 (${hex(type, 1)}:${hex(value, 6)})`;
}

// ── V3 ──
export const v3Width = type => ({ 0x01: 3, 0x22: 3, 0x23: 7, 0x24: 7 })[type] ?? 2;
const inOrder = type => type === 0x13 || type === 0x16;

function v3Bytes(type, n) {
  const bytes = Array.from({ length: v3Width(type) }, (_, i) => (n >>> (8 * i)) & 0xff);
  return inOrder(type) ? bytes.reverse() : bytes;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// V3에는 「공장 기능」 표시가 따로 없어서, 버튼마다 원래 기능을 직접 적어 넣는다.
export function v3Encode(button, label) {
  // DPI 버튼의 공장 기록값은 근거가 엇갈려(종류 0·값 0이라는 기록과 0xFF로 출하된 실기기 기록) 쓰지 않는다.
  // DPI 기능이 필요하면 「DPI 순환」을 고르면 된다.
  if (label === DEFAULT_LABEL) return button in MASK && button !== 'DPI' ? { type: 0x00, bytes: v3Bytes(0x00, MASK[button]) } : null;
  const a = byLabel.get(label);
  return a ? { type: a.v3[0], bytes: v3Bytes(a.v3[0], a.v3[1]) } : null;
}
export function v3Describe(button, entry) {
  if (entry.type === 0xff) return '지정 안 됨';
  if (entry.type === 0x00 && button in MASK && same(entry.bytes, v3Bytes(0x00, MASK[button]))) return DEFAULT_LABEL;
  const hit = table.find(a => a.v3[0] === entry.type && same(v3Bytes(a.v3[0], a.v3[1]), entry.bytes));
  return hit ? hit.label : `알 수 없음 (${hex(entry.type, 2)}:${entry.bytes.map(b => hex(b, 2)).join('')})`;
}
