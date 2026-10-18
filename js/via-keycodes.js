// VIA 프로토콜 12(QMK 0.19 이후 키 코드 체계)의 16비트 키 코드 ↔ 이름. 값 범위는 QMK 문서(keycodes.md,
// quantum_keycodes)에 정리된 것을 따랐다. 코드는 가져오지 않았다.
// 프로토콜 11 이하는 키 코드 번호가 달라서 여기서 해석하지 않는다(isSupportedProtocol).
// 이름(keycodeName)은 QMK 이름 그대로라 parseKeycode로 되돌릴 수 있고, 표시(keycodeLabel)는 키캡에 들어갈 짧은 글자다.
import { t } from './i18n.js';

const isSupportedProtocol = (protocol) => protocol >= 12;
const hex = (code) => '0x' + code.toString(16).padStart(4, '0');

// ---------- 기본 키 (0x0000 ~ 0x00FF) ----------

// [코드, 이름, 표시]. 표시를 비우면 이름에서 KC_를 뺀 것이다.
const BASIC = [
  [0x00, 'KC_NO', ''], [0x01, 'KC_TRNS', '▽'],
  [0x28, 'KC_ENT', 'Enter'], [0x29, 'KC_ESC', 'Esc'], [0x2a, 'KC_BSPC', 'Bksp'], [0x2b, 'KC_TAB', 'Tab'], [0x2c, 'KC_SPC', 'Space'],
  [0x2d, 'KC_MINS', '-'], [0x2e, 'KC_EQL', '='], [0x2f, 'KC_LBRC', '['], [0x30, 'KC_RBRC', ']'], [0x31, 'KC_BSLS', '\\'],
  [0x32, 'KC_NUHS', '#'], [0x33, 'KC_SCLN', ';'], [0x34, 'KC_QUOT', "'"], [0x35, 'KC_GRV', '`'], [0x36, 'KC_COMM', ','],
  [0x37, 'KC_DOT', '.'], [0x38, 'KC_SLSH', '/'], [0x39, 'KC_CAPS', 'Caps'],
  [0x46, 'KC_PSCR', 'PrtSc'], [0x47, 'KC_SCRL', 'ScrLk'], [0x48, 'KC_PAUS', 'Pause'], [0x49, 'KC_INS', 'Ins'], [0x4a, 'KC_HOME', 'Home'],
  [0x4b, 'KC_PGUP', 'PgUp'], [0x4c, 'KC_DEL', 'Del'], [0x4d, 'KC_END', 'End'], [0x4e, 'KC_PGDN', 'PgDn'],
  [0x4f, 'KC_RGHT', '→'], [0x50, 'KC_LEFT', '←'], [0x51, 'KC_DOWN', '↓'], [0x52, 'KC_UP', '↑'],
  [0x53, 'KC_NUM', 'NumLk'], [0x54, 'KC_PSLS', 'Num /'], [0x55, 'KC_PAST', 'Num *'], [0x56, 'KC_PMNS', 'Num -'], [0x57, 'KC_PPLS', 'Num +'],
  [0x58, 'KC_PENT', 'Num Enter'], [0x63, 'KC_PDOT', 'Num .'], [0x64, 'KC_NUBS', 'ISO \\'], [0x65, 'KC_APP', 'Menu'],
  [0x66, 'KC_KB_POWER', 'Power'], [0x67, 'KC_PEQL', 'Num ='],
  [0x74, 'KC_EXEC', 'Exec'], [0x75, 'KC_HELP', 'Help'], [0x76, 'KC_MENU', 'Menu'], [0x77, 'KC_SLCT', 'Select'], [0x78, 'KC_STOP', 'Stop'],
  [0x79, 'KC_AGIN', 'Again'], [0x7a, 'KC_UNDO', 'Undo'], [0x7b, 'KC_CUT', 'Cut'], [0x7c, 'KC_COPY', 'Copy'], [0x7d, 'KC_PSTE', 'Paste'],
  [0x7e, 'KC_FIND', 'Find'], [0x7f, 'KC_KB_MUTE', 'Mute'], [0x80, 'KC_KB_VOLUME_UP', 'Vol +'], [0x81, 'KC_KB_VOLUME_DOWN', 'Vol -'],
  [0x82, 'KC_LCAP', 'Locking Caps'], [0x83, 'KC_LNUM', 'Locking Num'], [0x84, 'KC_LSCR', 'Locking Scroll'],
  [0x85, 'KC_PCMM', 'Num ,'], [0x86, 'KC_KP_EQUAL_AS400', 'Num = (AS400)'],
  [0x99, 'KC_ERAS', 'Alt Erase'], [0x9a, 'KC_SYRQ', 'SysReq'], [0x9b, 'KC_CNCL', 'Cancel'], [0x9c, 'KC_CLR', 'Clear'], [0x9d, 'KC_PRIR', 'Prior'],
  [0x9e, 'KC_RETN', 'Return'], [0x9f, 'KC_SEPR', 'Separator'], [0xa0, 'KC_OUT', 'Out'], [0xa1, 'KC_OPER', 'Oper'], [0xa2, 'KC_CLAG', 'Clear Again'],
  [0xa3, 'KC_CRSL', 'CrSel'], [0xa4, 'KC_EXSL', 'ExSel'],
  [0xa5, 'KC_PWR', 'Sys Power'], [0xa6, 'KC_SLEP', 'Sleep'], [0xa7, 'KC_WAKE', 'Wake'],
  [0xa8, 'KC_MUTE', 'Mute'], [0xa9, 'KC_VOLU', 'Vol +'], [0xaa, 'KC_VOLD', 'Vol -'], [0xab, 'KC_MNXT', 'Next'], [0xac, 'KC_MPRV', 'Prev'],
  [0xad, 'KC_MSTP', 'Stop'], [0xae, 'KC_MPLY', 'Play'], [0xaf, 'KC_MSEL', 'Media Sel'], [0xb0, 'KC_EJCT', 'Eject'], [0xb1, 'KC_MAIL', 'Mail'],
  [0xb2, 'KC_CALC', 'Calc'], [0xb3, 'KC_MYCM', 'My PC'], [0xb4, 'KC_WSCH', 'Search'], [0xb5, 'KC_WHOM', 'Browser Home'], [0xb6, 'KC_WBAK', 'Browser Back'],
  [0xb7, 'KC_WFWD', 'Browser Fwd'], [0xb8, 'KC_WSTP', 'Browser Stop'], [0xb9, 'KC_WREF', 'Refresh'], [0xba, 'KC_WFAV', 'Favorites'],
  [0xbb, 'KC_MFFD', 'Fast Fwd'], [0xbc, 'KC_MRWD', 'Rewind'], [0xbd, 'KC_BRIU', 'Bright +'], [0xbe, 'KC_BRID', 'Bright -'],
  [0xbf, 'KC_CPNL', 'Control Panel'], [0xc0, 'KC_ASST', 'Assistant'], [0xc1, 'KC_MCTL', 'Mission Ctrl'], [0xc2, 'KC_LPAD', 'Launchpad'],
  [0xcd, 'KC_MS_U', 'Mouse ↑'], [0xce, 'KC_MS_D', 'Mouse ↓'], [0xcf, 'KC_MS_L', 'Mouse ←'], [0xd0, 'KC_MS_R', 'Mouse →'],
  [0xd9, 'KC_WH_U', 'Wheel ↑'], [0xda, 'KC_WH_D', 'Wheel ↓'], [0xdb, 'KC_WH_L', 'Wheel ←'], [0xdc, 'KC_WH_R', 'Wheel →'],
  [0xdd, 'KC_ACL0', 'Accel 0'], [0xde, 'KC_ACL1', 'Accel 1'], [0xdf, 'KC_ACL2', 'Accel 2'],
  [0xe0, 'KC_LCTL', 'LCtrl'], [0xe1, 'KC_LSFT', 'LShift'], [0xe2, 'KC_LALT', 'LAlt'], [0xe3, 'KC_LGUI', 'LWin'],
  [0xe4, 'KC_RCTL', 'RCtrl'], [0xe5, 'KC_RSFT', 'RShift'], [0xe6, 'KC_RALT', 'RAlt'], [0xe7, 'KC_RGUI', 'RWin'],
];
for (let i = 0; i < 26; i++) BASIC.push([0x04 + i, 'KC_' + String.fromCharCode(65 + i), '']);
for (let i = 1; i <= 10; i++) BASIC.push([0x1d + i, 'KC_' + (i % 10), '']);
for (let i = 1; i <= 12; i++) BASIC.push([0x39 + i, 'KC_F' + i, '']);
for (let i = 13; i <= 24; i++) BASIC.push([0x5b + i, 'KC_F' + i, '']);
for (let i = 1; i <= 10; i++) BASIC.push([0x58 + i, 'KC_P' + (i % 10), 'Num ' + (i % 10)]);
for (let i = 1; i <= 9; i++) BASIC.push([0x86 + i, 'KC_INT' + i, 'Int ' + i], [0x8f + i, 'KC_LNG' + i, 'Lang ' + i]);
for (let i = 1; i <= 8; i++) BASIC.push([0xd0 + i, 'KC_BTN' + i, 'Mouse ' + i]);

// QMK가 같은 키에 붙인 다른 이름 (해석만 한다)
const ALIASES = {
  KC_TRANSPARENT: 0x01, _______: 0x01, XXXXXXX: 0x00, KC_ENTER: 0x28, KC_ESCAPE: 0x29, KC_BACKSPACE: 0x2a, KC_SPACE: 0x2c,
  KC_MINUS: 0x2d, KC_EQUAL: 0x2e, KC_LEFT_BRACKET: 0x2f, KC_RIGHT_BRACKET: 0x30, KC_BACKSLASH: 0x31, KC_SEMICOLON: 0x33,
  KC_QUOTE: 0x34, KC_GRAVE: 0x35, KC_COMMA: 0x36, KC_SLASH: 0x38, KC_CAPS_LOCK: 0x39, KC_PRINT_SCREEN: 0x46, KC_SCROLL_LOCK: 0x47,
  KC_PAUSE: 0x48, KC_INSERT: 0x49, KC_PAGE_UP: 0x4b, KC_DELETE: 0x4c, KC_PAGE_DOWN: 0x4e, KC_RIGHT: 0x4f, KC_NUM_LOCK: 0x53,
  KC_APPLICATION: 0x65, KC_LEFT_CTRL: 0xe0, KC_LEFT_SHIFT: 0xe1, KC_LEFT_ALT: 0xe2, KC_LEFT_GUI: 0xe3,
  KC_RIGHT_CTRL: 0xe4, KC_RIGHT_SHIFT: 0xe5, KC_RIGHT_ALT: 0xe6, KC_RIGHT_GUI: 0xe7, KC_AUDIO_MUTE: 0xa8, KC_AUDIO_VOL_UP: 0xa9,
  KC_AUDIO_VOL_DOWN: 0xaa, KC_MEDIA_PLAY_PAUSE: 0xae, KC_MEDIA_NEXT_TRACK: 0xab, KC_MEDIA_PREV_TRACK: 0xac,
};

// ---------- 그 밖의 고정 코드 ----------

const FIXED = [
  // 조명 (QK_LIGHTING)
  [0x7800, 'BL_ON', 'BL On'], [0x7801, 'BL_OFF', 'BL Off'], [0x7802, 'BL_TOGG', 'BL Toggle'], [0x7803, 'BL_DOWN', 'BL -'],
  [0x7804, 'BL_UP', 'BL +'], [0x7805, 'BL_STEP', 'BL Cycle'], [0x7806, 'BL_BRTG', 'BL Breath'],
  [0x7820, 'RGB_TOG', 'RGB Toggle'], [0x7821, 'RGB_MOD', 'RGB Mode +'], [0x7822, 'RGB_RMOD', 'RGB Mode -'],
  [0x7823, 'RGB_HUI', 'Hue +'], [0x7824, 'RGB_HUD', 'Hue -'], [0x7825, 'RGB_SAI', 'Sat +'], [0x7826, 'RGB_SAD', 'Sat -'],
  [0x7827, 'RGB_VAI', 'Bright +'], [0x7828, 'RGB_VAD', 'Bright -'], [0x7829, 'RGB_SPI', 'Speed +'], [0x782a, 'RGB_SPD', 'Speed -'],
  [0x782b, 'RGB_M_P', 'RGB Plain'], [0x782c, 'RGB_M_B', 'RGB Breathe'], [0x782d, 'RGB_M_R', 'RGB Rainbow'], [0x782e, 'RGB_M_SW', 'RGB Swirl'],
  [0x782f, 'RGB_M_SN', 'RGB Snake'], [0x7830, 'RGB_M_K', 'RGB Knight'], [0x7831, 'RGB_M_X', 'RGB Xmas'], [0x7832, 'RGB_M_G', 'RGB Gradient'],
  [0x7833, 'RGB_M_T', 'RGB Test'],
  // 기능 (QK_QUANTUM). 부트로더·EEPROM 초기화는 키에 넣을 수는 있지만 선택 목록에서는 위험 표시를 한다.
  [0x7c00, 'QK_BOOT', 'Boot'], [0x7c01, 'QK_RBT', 'Reboot'], [0x7c02, 'DB_TOGG', 'Debug'], [0x7c03, 'EE_CLR', 'EEPROM Clear'],
  [0x7c16, 'QK_GESC', 'Esc `'], [0x7c73, 'CW_TOGG', 'Caps Word'],
];
const DANGER = new Set([0x7c00, 0x7c01, 0x7c03]);

const BY_CODE = new Map();
const BY_NAME = new Map(Object.entries(ALIASES));
for (const [code, name, label] of [...BASIC, ...FIXED]) {
  BY_CODE.set(code, { name, label: label || name.replace(/^KC_/, '') });
  BY_NAME.set(name, code);
}

// ---------- 조합 코드 ----------

// 5비트 수정자: 비트 0 Ctrl, 1 Shift, 2 Alt, 3 GUI, 4 오른쪽
const MOD_BITS = [['CTL', 'Ctrl'], ['SFT', 'Shift'], ['ALT', 'Alt'], ['GUI', 'Win']];
const MOD_RIGHT = 0x10;
const modNames = (mods) => MOD_BITS.filter((_, i) => mods & (1 << i)).map(([n]) => `MOD_${mods & MOD_RIGHT ? 'R' : 'L'}${n}`);
const modLabel = (mods) => (mods & MOD_RIGHT ? 'R' : '') + MOD_BITS.filter((_, i) => mods & (1 << i)).map(([, l]) => l).join('+');
function parseMods(text) {
  let mods = 0;
  for (const part of text.split('|').map((s) => s.trim())) {
    const m = /^MOD_([LR])(CTL|SFT|ALT|GUI)$/.exec(part);
    if (!m) return null;
    const right = m[1] === 'R' ? MOD_RIGHT : 0;
    if (mods && (mods & MOD_RIGHT) !== right) return null; // 왼쪽과 오른쪽을 섞을 수 없다
    mods |= right | (1 << MOD_BITS.findIndex(([n]) => n === m[2]));
  }
  return mods;
}
// 레이어 하나를 받는 코드: [시작, 이름, 표시 접두]
const LAYER_FN = [
  [0x5200, 'TO', 'TO'], [0x5220, 'MO', 'MO'], [0x5240, 'DF', 'DF'], [0x5260, 'TG', 'TG'],
  [0x5280, 'OSL', 'OSL'], [0x52c0, 'TT', 'TT'], [0x52e0, 'PDF', 'PDF'],
];
const RANGE = {
  MODS: [0x0100, 0x1fff], MOD_TAP: [0x2000, 0x3fff], LAYER_TAP: [0x4000, 0x4fff], LAYER_MOD: [0x5000, 0x51ff],
  ONE_SHOT_MOD: [0x52a0, 0x52bf], TAP_DANCE: [0x5700, 0x57ff], MACRO: [0x7700, 0x777f], KB: [0x7e00, 0x7e3f], USER: [0x7e40, 0x7fff],
};
const inRange = (code, [lo, hi]) => code >= lo && code <= hi;

// 수정자 하나뿐인 모드 탭의 별명: LCTL_T(kc) 등
const singleModName = (mods) => {
  const bits = mods & 0x0f;
  const i = [1, 2, 4, 8].indexOf(bits);
  return i < 0 ? null : `${mods & MOD_RIGHT ? 'R' : 'L'}${MOD_BITS[i][0]}`;
};

// ---------- 이름 ----------

// QMK 이름. 모르는 코드는 16진수.
function keycodeName(code) {
  const fixed = BY_CODE.get(code);
  if (fixed) return fixed.name;
  if (inRange(code, RANGE.MODS)) {
    const kc = keycodeName(code & 0xff);
    const mods = (code >> 8) & 0x1f;
    return MOD_BITS.reduceRight((inner, [n], i) => (mods & (1 << i) ? `${mods & MOD_RIGHT ? 'R' : 'L'}${n}(${inner})` : inner), kc);
  }
  if (inRange(code, RANGE.MOD_TAP)) {
    const mods = (code >> 8) & 0x1f;
    const single = singleModName(mods);
    const kc = keycodeName(code & 0xff);
    return single ? `${single}_T(${kc})` : `MT(${modNames(mods).join(' | ')}, ${kc})`;
  }
  if (inRange(code, RANGE.LAYER_TAP)) return `LT(${(code >> 8) & 0x0f}, ${keycodeName(code & 0xff)})`;
  if (inRange(code, RANGE.LAYER_MOD)) return `LM(${(code >> 5) & 0x0f}, ${modNames(code & 0x1f).join(' | ')})`;
  if (inRange(code, RANGE.ONE_SHOT_MOD)) return `OSM(${modNames(code & 0x1f).join(' | ')})`;
  const layer = LAYER_FN.find(([start]) => code >= start && code < start + 0x20);
  if (layer) return `${layer[1]}(${code - layer[0]})`;
  if (inRange(code, RANGE.TAP_DANCE)) return `TD(${code & 0xff})`;
  if (inRange(code, RANGE.MACRO)) return `MC_${code - RANGE.MACRO[0]}`;
  if (inRange(code, RANGE.KB)) return `QK_KB_${code - RANGE.KB[0]}`;
  if (inRange(code, RANGE.USER)) return `QK_USER_${code - RANGE.USER[0]}`;
  return hex(code);
}

// 키캡에 넣을 짧은 글자와 설명. ctx.customKeycodes: 정의 파일의 customKeycodes (QK_KB_n의 이름)
function keycodeLabel(code, ctx = {}) {
  const name = keycodeName(code);
  const fixed = BY_CODE.get(code);
  if (fixed) return { label: fixed.label, title: name, danger: DANGER.has(code) };
  const inner = (kc) => BY_CODE.get(kc)?.label ?? keycodeName(kc);
  let label = name;
  if (inRange(code, RANGE.MODS)) label = `${modLabel((code >> 8) & 0x1f)}+${inner(code & 0xff)}`;
  else if (inRange(code, RANGE.MOD_TAP)) label = `${inner(code & 0xff)}\n${modLabel((code >> 8) & 0x1f)}`;
  else if (inRange(code, RANGE.LAYER_TAP)) label = `${inner(code & 0xff)}\nL${(code >> 8) & 0x0f}`;
  else if (inRange(code, RANGE.MACRO)) label = `M${code - RANGE.MACRO[0]}`;
  else if (inRange(code, RANGE.KB)) {
    const custom = ctx.customKeycodes?.[code - RANGE.KB[0]];
    if (custom) return { label: custom.shortName || custom.name, title: custom.title || custom.name, danger: false };
  }
  return { label, title: name, danger: false };
}

// ---------- 해석 ----------

// 이름이나 16진수를 키 코드로. 알 수 없으면 null.
function parseKeycode(text) {
  const s = String(text).trim();
  if (/^0x[0-9a-f]{1,4}$/i.test(s)) return parseInt(s, 16);
  if (BY_NAME.has(s)) return BY_NAME.get(s);
  let m;
  if ((m = /^MC_(\d+)$/.exec(s)) && +m[1] < 128) return RANGE.MACRO[0] + +m[1];
  if ((m = /^QK_KB_(\d+)$/.exec(s)) && +m[1] < 64) return RANGE.KB[0] + +m[1];
  if ((m = /^QK_USER_(\d+)$/.exec(s)) && +m[1] < 448) return RANGE.USER[0] + +m[1];
  if ((m = /^TD\((\d+)\)$/.exec(s)) && +m[1] < 256) return RANGE.TAP_DANCE[0] + +m[1];
  if ((m = /^([A-Z]+)\((\d+)\)$/.exec(s))) {
    const layer = LAYER_FN.find(([, n]) => n === m[1]);
    if (layer && +m[2] < 32) return layer[0] + +m[2];
  }
  if ((m = /^([LR])(CTL|SFT|ALT|GUI)\((.+)\)$/.exec(s))) {
    const inner = parseKeycode(m[3]);
    if (inner === null || inner > 0x1fff) return null;
    const bit = (1 << MOD_BITS.findIndex(([n]) => n === m[2])) << 8;
    const right = m[1] === 'R' ? MOD_RIGHT << 8 : 0;
    const innerMods = inner & 0x1f00;
    if (innerMods && (innerMods & (MOD_RIGHT << 8)) !== right) return null;
    return inner | bit | right;
  }
  if ((m = /^([LR])(CTL|SFT|ALT|GUI)_T\((.+)\)$/.exec(s))) {
    const kc = parseKeycode(m[3]);
    const mods = parseMods(`MOD_${m[1]}${m[2]}`);
    return kc !== null && kc <= 0xff ? RANGE.MOD_TAP[0] | (mods << 8) | kc : null;
  }
  if ((m = /^MT\((.+),\s*(.+)\)$/.exec(s))) {
    const mods = parseMods(m[1]);
    const kc = parseKeycode(m[2]);
    return mods && kc !== null && kc <= 0xff ? RANGE.MOD_TAP[0] | (mods << 8) | kc : null;
  }
  if ((m = /^LT\((\d+),\s*(.+)\)$/.exec(s))) {
    const kc = parseKeycode(m[2]);
    return +m[1] < 16 && kc !== null && kc <= 0xff ? RANGE.LAYER_TAP[0] | (+m[1] << 8) | kc : null;
  }
  if ((m = /^LM\((\d+),\s*(.+)\)$/.exec(s))) {
    const mods = parseMods(m[2]);
    return +m[1] < 16 && mods ? RANGE.LAYER_MOD[0] | (+m[1] << 5) | mods : null;
  }
  if ((m = /^OSM\((.+)\)$/.exec(s))) {
    const mods = parseMods(m[1]);
    return mods ? RANGE.ONE_SHOT_MOD[0] | mods : null;
  }
  return null;
}

// ---------- 선택 목록 ----------

// ctx: {layers: 레이어 수, macroCount, customKeycodes, lighting: 정의 파일 keycodes에 조명이 있는지}
// → [{id, label, keys: [{code, label, title, danger}]}]
function keycodeGroups(ctx = {}) {
  const entry = (code) => ({ code, ...keycodeLabel(code, ctx) });
  const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const groups = [
    { id: 'basic', label: t('기본'), keys: [0x00, 0x01, ...range(0x04, 0x39), ...range(0x3a, 0x45), ...range(0x46, 0x52), ...range(0xe0, 0xe7)].map(entry) },
    { id: 'numpad', label: t('숫자 패드'), keys: [...range(0x53, 0x63), 0x67, 0x85].map(entry) },
    { id: 'extra', label: t('추가 키'), keys: [...range(0x68, 0x73), 0x64, 0x65, 0x32, ...range(0x87, 0x98), 0x7c16, 0x7c73].map(entry) },
    { id: 'media', label: t('미디어'), keys: [...range(0xa5, 0xc2)].map(entry) },
    { id: 'mouse', label: t('마우스'), keys: [...range(0xcd, 0xdf)].map(entry) },
  ];
  const layers = Math.min(16, ctx.layers || 0);
  if (layers) {
    groups.push({
      id: 'layers', label: t('레이어'),
      keys: ['MO', 'TG', 'TO', 'TT', 'OSL', 'DF'].flatMap((fn) => range(0, layers - 1).map((l) => entry(parseKeycode(`${fn}(${l})`)))),
    });
  }
  if (ctx.lighting) groups.push({ id: 'lighting', label: t('조명'), keys: FIXED.filter(([c]) => c >= 0x7800 && c < 0x7900).map(([c]) => entry(c)) });
  if (ctx.macroCount) groups.push({ id: 'macro', label: t('매크로'), keys: range(0, Math.min(128, ctx.macroCount) - 1).map((i) => entry(RANGE.MACRO[0] + i)) });
  if (ctx.customKeycodes?.length) {
    groups.push({ id: 'custom', label: t('키보드 전용'), keys: ctx.customKeycodes.slice(0, 64).map((_, i) => entry(RANGE.KB[0] + i)) });
  }
  groups.push({ id: 'special', label: t('특수'), keys: [0x7c00, 0x7c01, 0x7c02, 0x7c03].map(entry) });
  return groups;
}

export { isSupportedProtocol, keycodeName, keycodeLabel, parseKeycode, keycodeGroups, RANGE, DANGER };
