// 버튼 할당에 쓰이는 이름표: 키보드 HID usage, 마우스 버튼, 특수 기능, 미디어 키.
import { toHex } from './profile.js';
import { t } from './i18n.js';

// KeyboardEvent.code → [HID usage, 표시 이름]
const CODE_TO_USAGE = {};
const USAGE_NAMES = {};
function add(code, usage, label) {
  CODE_TO_USAGE[code] = usage;
  USAGE_NAMES[usage] = label;
}

for (let i = 0; i < 26; i++) add('Key' + String.fromCharCode(65 + i), 0x04 + i, String.fromCharCode(65 + i));
for (let i = 1; i <= 9; i++) add('Digit' + i, 0x1d + i, String(i));
add('Digit0', 0x27, '0');
for (let i = 1; i <= 12; i++) add('F' + i, 0x39 + i, 'F' + i);
for (let i = 13; i <= 24; i++) add('F' + i, 0x5b + i, 'F' + i);
for (let i = 1; i <= 9; i++) add('Numpad' + i, 0x58 + i, 'Num ' + i);
[
  ['Enter', 0x28, 'Enter'], ['Escape', 0x29, 'Esc'], ['Backspace', 0x2a, 'Backspace'], ['Tab', 0x2b, 'Tab'],
  ['Space', 0x2c, 'Space'], ['Minus', 0x2d, '-'], ['Equal', 0x2e, '='], ['BracketLeft', 0x2f, '['],
  ['BracketRight', 0x30, ']'], ['Backslash', 0x31, '\\'], ['Semicolon', 0x33, ';'], ['Quote', 0x34, "'"],
  ['Backquote', 0x35, '`'], ['Comma', 0x36, ','], ['Period', 0x37, '.'], ['Slash', 0x38, '/'],
  ['CapsLock', 0x39, 'Caps Lock'], ['PrintScreen', 0x46, 'Print Screen'], ['ScrollLock', 0x47, 'Scroll Lock'],
  ['Pause', 0x48, 'Pause'], ['Insert', 0x49, 'Insert'], ['Home', 0x4a, 'Home'], ['PageUp', 0x4b, 'Page Up'],
  ['Delete', 0x4c, 'Delete'], ['End', 0x4d, 'End'], ['PageDown', 0x4e, 'Page Down'],
  ['ArrowRight', 0x4f, '→'], ['ArrowLeft', 0x50, '←'], ['ArrowDown', 0x51, '↓'], ['ArrowUp', 0x52, '↑'],
  ['NumLock', 0x53, 'Num Lock'], ['NumpadDivide', 0x54, 'Num /'], ['NumpadMultiply', 0x55, 'Num *'],
  ['NumpadSubtract', 0x56, 'Num -'], ['NumpadAdd', 0x57, 'Num +'], ['NumpadEnter', 0x58, 'Num Enter'],
  ['Numpad0', 0x62, 'Num 0'], ['NumpadDecimal', 0x63, 'Num .'], ['ContextMenu', 0x65, 'Menu'],
].forEach((k) => add(...k));

const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

// 수정자 비트 (왼쪽 키 기준). 오른쪽 키는 << 4.
const MODIFIERS = [[0x01, 'Ctrl'], [0x02, 'Shift'], [0x04, 'Alt'], [0x08, 'Win']];

const MOUSE_BUTTONS = ['왼쪽 클릭', '오른쪽 클릭', '가운데 클릭', '뒤로', '앞으로'];
const mouseButtonName = (bit) => (MOUSE_BUTTONS[bit] ? t(MOUSE_BUTTONS[bit]) : t('마우스 버튼 {n}', { n: bit + 1 }));

const SPECIALS = {
  0x01: '휠 왼쪽 틸트', 0x02: '휠 오른쪽 틸트', 0x03: 'DPI 올리기', 0x04: 'DPI 내리기', 0x05: 'DPI 순환',
  0x06: '기본 DPI', 0x07: 'DPI 시프트', 0x08: '다음 프로필', 0x09: '이전 프로필', 0x0a: '프로필 순환',
  0x0b: 'G-Shift', 0x0c: '배터리 잔량 표시', 0x10: '스크롤 내리기', 0x11: '스크롤 올리기',
};

// 표시만 하고 선택 목록에는 넣지 않는 기능 (추가 값이 필요하거나 일부 기기 전용)
const SPECIALS_DISPLAY_ONLY = { 0x00: '동작 없음', 0x0d: '지정 프로필로 전환', 0x0e: '성능 모드 전환', 0x0f: '호스트 전환 버튼' };

const CONSUMER = {
  0xcd: '재생/일시정지', 0xb5: '다음 트랙', 0xb6: '이전 트랙', 0xb7: '정지',
  0xe2: '음소거', 0xe9: '볼륨 올리기', 0xea: '볼륨 내리기',
};

const hex = (n, w = 2) => '0x' + n.toString(16).padStart(w, '0');

function keyName(mods, usage) {
  const parts = MODIFIERS.filter(([bit]) => mods & (bit | (bit << 4))).map(([, name]) => name);
  if (usage) parts.push(USAGE_NAMES[usage] || t('키 {code}', { code: hex(usage) }));
  return parts.join(' + ') || t('(없음)');
}

function describe(action, rawBytes) {
  switch (action.kind) {
    case 'mouse': {
      const bits = [...Array(16).keys()].filter((b) => action.mask & (1 << b));
      return bits.map(mouseButtonName).join(' + ') || t('(없음)');
    }
    case 'key': return keyName(action.mods, action.usage);
    // 실기기에는 상위 바이트에 usage page(0x0C)를 넣은 형태(0x0CE2)도 저장돼 있다.
    case 'consumer': {
      const name = CONSUMER[action.usage] || (action.usage >> 8 === 0x0c && CONSUMER[action.usage & 0xff]);
      return name ? t(name) : t('미디어 {code}', { code: hex(action.usage, 4) });
    }
    case 'special': {
      const name = SPECIALS[action.code] || SPECIALS_DISPLAY_ONLY[action.code];
      return name ? t(name) : t('특수 기능 {code}', { code: hex(action.code) });
    }
    case 'disabled': return t('사용 안 함');
    case 'macro': return t('매크로');
  }
  return t('알 수 없음 ({bytes})', { bytes: toHex(rawBytes) });
}

export { CODE_TO_USAGE, MODIFIER_CODES, MODIFIERS, SPECIALS, CONSUMER, mouseButtonName, keyName, describe };
