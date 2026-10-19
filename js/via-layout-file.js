// VIA 앱의 「Save + Load」 레이아웃 파일(.layout.json)과 GOMM 사이의 변환.
// 파일 모양: {name, vendorProductId, macros: [매크로 식], layers: [[키 이름 × 행·열 순서]], encoders: [인코더][레이어] = [반시계, 시계]}
// 키 이름은 VIA 앱(프로토콜 12 이름표)이 쓰는 문자열이고, 매크로 식은 {KC_A} 누르고 떼기, {+KC_A} 누르기, {-KC_A} 떼기,
// {100} 대기, {KC_LCTL,KC_C} 동시 입력, 그 밖의 글자는 그대로 입력(\{ 는 글자 {)이다.
// 형식은 VIA 앱의 공개 소스(the-via/app의 save-load.tsx, advanced-keys.ts, macro-api.common.ts)를 읽고 정리했다. 코드는 가져오지 않았다.
import { keycodeName, parseKeycode, RANGE, MOD_RIGHT } from './via-keycodes.js';
import { t } from './i18n.js';

// VIA가 우리와 다른 이름을 쓰는 키: [코드, VIA 이름]. 내보낼 때 이 이름을 쓰고, 불러올 때도 받는다.
const VIA_NAMES = [
  [0x47, 'KC_SLCK'], [0x53, 'KC_NLCK'], [0x66, 'KC_POWER'], [0x74, 'KC_EXECUTE'], [0x77, 'KC_SELECT'], [0x79, 'KC_AGAIN'], [0x7d, 'KC_PASTE'],
  [0x87, 'KC_RO'], [0x88, 'KC_KANA'], [0x89, 'KC_JYEN'], [0x8a, 'KC_HENK'], [0x8b, 'KC_MHEN'], [0x90, 'KC_HAEN'], [0x91, 'KC_HANJ'],
  [0x92, 'KC_LANG3'], [0x93, 'KC_LANG4'], [0x94, 'KC_LANG5'], [0x95, 'KC_LANG6'], [0x96, 'KC_LANG7'], [0x97, 'KC_LANG8'], [0x98, 'KC_LANG9'],
  [0x9a, 'KC_SYSREQ'], [0x9b, 'KC_CANCEL'], [0x9d, 'KC_PRIOR'], [0xa2, 'KC_CLEAR_AGAIN'], [0xa3, 'KC_CRSEL'], [0xa4, 'KC_EXSEL'],
  [0xb4, 'KC_WWW_SEARCH'], [0xb5, 'KC_WWW_HOME'], [0xb6, 'KC_WWW_BACK'], [0xb7, 'KC_WWW_FORWARD'], [0xb8, 'KC_WWW_STOP'],
  [0xb9, 'KC_WWW_REFRESH'], [0xba, 'KC_WWW_FAVORITES'],
  [0xcd, 'KC_MS_UP'], [0xce, 'KC_MS_DOWN'], [0xcf, 'KC_MS_LEFT'], [0xd0, 'KC_MS_RIGHT'],
  [0xd9, 'KC_MS_WH_UP'], [0xda, 'KC_MS_WH_DOWN'], [0xdb, 'KC_MS_WH_LEFT'], [0xdc, 'KC_MS_WH_RIGHT'],
  [0xdd, 'KC_MS_ACCEL0'], [0xde, 'KC_MS_ACCEL1'], [0xdf, 'KC_MS_ACCEL2'],
  [0x7803, 'BL_DEC'], [0x7804, 'BL_INC'], [0x7833, 'RGB_MODE_RGBTEST'],
  [0x7c00, 'RESET'], [0x7c02, 'DEBUG'], [0x7c03, 'QK_CLEAR_EEPROM'], [0x7c16, 'KC_GESC'], [0x7013, 'MAGIC_TOGGLE_NKRO'],
  [0x7c10, 'KC_ASDN'], [0x7c11, 'KC_ASUP'], [0x7c12, 'KC_ASRP'], [0x7c13, 'KC_ASON'], [0x7c14, 'KC_ASOFF'], [0x7c15, 'KC_ASTG'],
  [0x7c17, 'VLK_TOG'], [0x7c18, 'KC_LCPO'], [0x7c19, 'KC_RCPC'], [0x7c1a, 'KC_LSPO'], [0x7c1b, 'KC_RSPC'], [0x7c1c, 'KC_LAPO'],
  [0x7c1d, 'KC_RAPC'], [0x7c1e, 'KC_SFTENT'], [0x7c20, 'OUT_AUTO'], [0x7c21, 'OUT_USB'],
  [0x7c50, 'CMB_ON'], [0x7c51, 'CMB_OFF'], [0x7c52, 'CMB_TOG'],
  [0x7c53, 'DYN_REC_START1'], [0x7c54, 'DYN_REC_START2'], [0x7c55, 'DYN_REC_STOP'], [0x7c56, 'DYN_MACRO_PLAY1'], [0x7c57, 'DYN_MACRO_PLAY2'],
  [0x7c77, 'FN_MO13'], [0x7c78, 'FN_MO23'],
  [0x7482, 'AU_TOG'], [0x748a, 'CLICKY_TOGGLE'], [0x748b, 'CLICKY_ENABLE'], [0x748c, 'CLICKY_DISABLE'], [0x748d, 'CLICKY_UP'],
  [0x748e, 'CLICKY_DOWN'], [0x748f, 'CLICKY_RESET'], [0x7492, 'MU_TOG'], [0x7493, 'MU_MOD'],
  [0x7005, 'MAGIC_SWAP_LALT_LGUI'], [0x7006, 'MAGIC_UNSWAP_LALT_LGUI'], [0x7007, 'MAGIC_SWAP_RALT_RGUI'], [0x7008, 'MAGIC_UNSWAP_RALT_RGUI'],
  [0x7009, 'MAGIC_GUI_ON'], [0x700a, 'MAGIC_GUI_OFF'], [0x700b, 'MAGIC_TOGGLE_GUI'], [0x7014, 'MAGIC_SWAP_ALT_GUI'],
  [0x7015, 'MAGIC_UNSWAP_ALT_GUI'], [0x7016, 'MAGIC_TOGGLE_ALT_GUI'], [0x7017, 'MAGIC_SWAP_LCTL_LGUI'], [0x7018, 'MAGIC_UNSWAP_LCTL_LGUI'],
  [0x7019, 'MAGIC_SWAP_RCTL_RGUI'], [0x701a, 'MAGIC_UNSWAP_RCTL_RGUI'], [0x701b, 'MAGIC_SWAP_CTL_GUI'], [0x701c, 'MAGIC_UNSWAP_CTL_GUI'],
  [0x701d, 'MAGIC_TOGGLE_CTL_GUI'], [0x701e, 'MAGIC_EE_HANDS_LEFT'], [0x701f, 'MAGIC_EE_HANDS_RIGHT'],
];
for (let i = 1; i <= 8; i++) VIA_NAMES.push([0xd0 + i, 'KC_MS_BTN' + i]);
const VIA_BY_CODE = new Map(VIA_NAMES);
const VIA_BY_NAME = new Map(VIA_NAMES.map(([c, n]) => [n, c]));
// VIA가 받기만 하는 옛 이름과, 새 펌웨어용 VIA 이름(UG_*)
const SHIFTED = { KC_TILD: 'GRV', KC_EXLM: '1', KC_AT: '2', KC_HASH: '3', KC_DLR: '4', KC_PERC: '5', KC_CIRC: '6', KC_AMPR: '7', KC_ASTR: '8',
  KC_LPRN: '9', KC_RPRN: '0', KC_UNDS: 'MINS', KC_PLUS: 'EQL', KC_LCBR: 'LBRC', KC_RCBR: 'RBRC', KC_PIPE: 'BSLS', KC_COLN: 'SCLN',
  KC_DQUO: 'QUOT', KC_LT: 'COMM', KC_GT: 'DOT', KC_QUES: 'SLSH' };
const UNDERGLOW = ['UG_TOGG', 'UG_NEXT', 'UG_PREV', 'UG_HUEU', 'UG_HUED', 'UG_SATU', 'UG_SATD', 'UG_VALU', 'UG_VALD', 'UG_SPDU', 'UG_SPDD'];

// VIA의 수정자 함수 이름 → 5비트 수정자 (오른쪽은 비트 4)
const L = { C: 1, S: 2, A: 4, G: 8 };
const MOD_FN = {
  LCTL: 1, C: 1, LSFT: 2, S: 2, LALT: 4, A: 4, LGUI: 8, LCMD: 8, LWIN: 8, G: 8,
  RCTL: 0x11, RSFT: 0x12, RALT: 0x14, ALGR: 0x14, RGUI: 0x18, RCMD: 0x18, RWIN: 0x18,
  SCMD: L.S | L.G, SWIN: L.S | L.G, SGUI: L.S | L.G, LSG: L.S | L.G, LAG: L.A | L.G, LCA: L.C | L.A, LSA: L.S | L.A,
  RSG: 0x10 | L.S | L.G, RAG: 0x10 | L.A | L.G, SAGR: 0x10 | L.S | L.A, RSA: 0x10 | L.S | L.A, RCS: 0x10 | L.C | L.S,
  LCAG: L.C | L.A | L.G, MEH: L.C | L.S | L.A, HYPR: L.C | L.S | L.A | L.G,
};
const MOD_MASK = { MOD_LCTL: 1, MOD_LSFT: 2, MOD_LALT: 4, MOD_LGUI: 8, MOD_RCTL: 0x11, MOD_RSFT: 0x12, MOD_RALT: 0x14, MOD_RGUI: 0x18, MOD_MEH: 7, MOD_HYPR: 0x0f };

// ---------- 키 이름 ----------

const basicName = (kc) => VIA_BY_CODE.get(kc) ?? keycodeName(kc);
const modMaskName = (m) => {
  const side = m & MOD_RIGHT ? 'R' : 'L';
  return ['CTL', 'SFT', 'ALT', 'GUI'].filter((_, i) => m & (1 << i)).map((n) => `MOD_${side}${n}`).join(' | ');
};

// 16비트 키 코드 → VIA 이름
function viaKeyName(code) {
  if (VIA_BY_CODE.has(code)) return VIA_BY_CODE.get(code);
  const kc = code & 0xff;
  const m = (code >> 8) & 0x1f;
  const inRange = ([lo, hi]) => code >= lo && code <= hi;
  if (inRange(RANGE.MODS)) {
    const side = m & MOD_RIGHT ? 'R' : 'L';
    const fns = ['CTL', 'SFT', 'ALT', 'GUI'].filter((_, i) => m & (1 << i)).map((n) => side + n);
    return fns.join('(') + '(' + basicName(kc) + ')'.repeat(fns.length);
  }
  if (inRange(RANGE.MOD_TAP)) return `MT(${modMaskName(m)},${basicName(kc)})`;
  if (inRange(RANGE.LAYER_TAP)) return `LT(${(code >> 8) & 0x0f},${basicName(kc)})`;
  if (inRange(RANGE.LAYER_MOD)) return `LM(${(code >> 5) & 0x0f},${modMaskName(code & 0x1f)})`;
  if (inRange(RANGE.ONE_SHOT_MOD)) return `OSM(${modMaskName(code & 0x1f)})`;
  if (inRange(RANGE.MACRO)) return `MACRO(${code - RANGE.MACRO[0]})`;
  if (code >= RANGE.KB[0] && code <= 0x7eff) return `CUSTOM(${code - RANGE.KB[0]})`;
  return keycodeName(code); // 레이어 함수(MO(1) 등)와 기본 키는 이름이 같고, 모르는 코드는 16진수
}

const parseMask = (text) => {
  let m = 0;
  for (const part of text.split('|').map((x) => x.trim())) {
    if (!(part in MOD_MASK)) return null;
    m |= MOD_MASK[part];
  }
  return m;
};

// VIA 이름 → 16비트 키 코드. 모르면 null.
function parseViaKey(text) {
  const s = String(text).trim().toUpperCase().replace(/^0X/, '0x');
  if (VIA_BY_NAME.has(s)) return VIA_BY_NAME.get(s);
  if (s in SHIFTED) return 0x0200 | parseKeycode('KC_' + SHIFTED[s]);
  if (UNDERGLOW.includes(s)) return 0x7820 + UNDERGLOW.indexOf(s);
  let m;
  if ((m = /^MACRO0?(\d+)$/.exec(s)) || (m = /^MACRO\((\d+)\)$/.exec(s))) return +m[1] < 128 ? RANGE.MACRO[0] + +m[1] : null;
  if ((m = /^USER0?(\d+)$/.exec(s)) || (m = /^CUSTOM\((\d+)\)$/.exec(s))) return +m[1] < 256 ? RANGE.KB[0] + +m[1] : null;
  if ((m = /^SPC_FN([1-3])$/.exec(s))) return RANGE.LAYER_TAP[0] | (+m[1] << 8) | 0x2c;
  if ((m = /^MT\((.+),(.+)\)$/.exec(s))) {
    const mask = parseMask(m[1]); const kc = parseViaKey(m[2]);
    return mask && kc !== null && kc <= 0xff ? RANGE.MOD_TAP[0] | (mask << 8) | kc : null;
  }
  if ((m = /^LT\((\d+),(.+)\)$/.exec(s))) {
    const kc = parseViaKey(m[2]);
    return +m[1] < 16 && kc !== null && kc <= 0xff ? RANGE.LAYER_TAP[0] | (+m[1] << 8) | kc : null;
  }
  if ((m = /^LM\((\d+),(.+)\)$/.exec(s))) { const mask = parseMask(m[2]); return +m[1] < 16 && mask ? RANGE.LAYER_MOD[0] | (+m[1] << 5) | mask : null; }
  if ((m = /^OSM\((.+)\)$/.exec(s))) { const mask = parseMask(m[1]); return mask ? RANGE.ONE_SHOT_MOD[0] | mask : null; }
  // 수정자 함수: C(KC_A), LCTL(LSFT(KC_A)), MEH(KC_A) 등. 왼쪽과 오른쪽을 섞을 수 없다.
  if ((m = /^([A-Z]+)\((.+)\)$/.exec(s)) && m[1] in MOD_FN) {
    const inner = parseViaKey(m[2]);
    if (inner === null || inner > 0x1fff) return null;
    const add = MOD_FN[m[1]];
    const have = (inner >> 8) & 0x1f;
    if (have && (have & MOD_RIGHT) !== (add & MOD_RIGHT)) return null;
    return ((have | add) << 8) | (inner & 0xff);
  }
  return parseKeycode(s);
}

// ---------- 매크로 식 ----------

// 매크로 단계 → VIA 매크로 식. 같은 키를 바로 누르고 떼면 {KC}로 줄인다.
function stepsToExpression(steps) {
  const keys = (st) => {
    const out = [];
    for (let bit = 0; bit < 8; bit++) if (st.mods & (1 << bit)) out.push(0xe0 + bit);
    if (st.usage) out.push(st.usage);
    return out.map(basicName);
  };
  const parts = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'text') parts.push(s.text.replace(/\{/g, '\\{'));
    else if (s.kind === 'delay') parts.push(`{${Math.max(0, Math.round(s.ms))}}`);
    else if (s.kind === 'key') {
      const n = steps[i + 1];
      if (s.down && n?.kind === 'key' && !n.down && n.mods === s.mods && n.usage === s.usage) {
        parts.push(...keys(s).map((k) => `{${k}}`));
        i++;
      } else parts.push(...keys(s).map((k) => `{${s.down ? '+' : '-'}${k}}`));
    } else throw new Error(t('VIA 매크로에 넣을 수 없는 단계입니다.'));
  }
  return parts.join('');
}

const keyStep = (down, kc) => (kc >= 0xe0 && kc <= 0xe7 ? { kind: 'key', down, mods: 1 << (kc - 0xe0), usage: 0 } : { kind: 'key', down, mods: 0, usage: kc });

// VIA 매크로 식 → 매크로 단계. 읽을 수 없는 키 이름이 있으면 오류를 던진다.
function expressionToSteps(text) {
  const steps = [];
  const basic = (name) => {
    const kc = parseViaKey(name);
    if (kc === null || kc > 0xff || kc === 0) throw new Error(t('매크로의 키 「{name}」을 읽을 수 없습니다.', { name }));
    return kc;
  };
  for (const piece of String(text).split(/(?<!\\)(\{.*?\})/)) {
    if (!piece) continue;
    if (/^\{.*\}$/.test(piece)) {
      const body = piece.slice(1, -1).trim();
      if (/^\d+$/.test(body)) { steps.push({ kind: 'delay', ms: +body }); continue; }
      const action = /^[+-]/.test(body) ? body[0] : null;
      const names = body.replace(/^[+-]/, '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!names.length) continue;
      if (action) { steps.push(keyStep(action === '+', basic(names[0]))); continue; }
      const codes = names.map(basic);
      codes.forEach((kc) => steps.push(keyStep(true, kc)));
      [...codes].reverse().forEach((kc) => steps.push(keyStep(false, kc)));
    } else {
      const textPart = piece.replace(/\\\{/g, '{');
      const last = steps[steps.length - 1];
      if (last?.kind === 'text') last.text += textPart; else steps.push({ kind: 'text', text: textPart });
    }
  }
  return steps;
}

// ---------- 파일 ----------

// 세션의 저장된 상태(orig)를 VIA 레이아웃 파일로
function exportViaLayout(session) {
  const { def, orig } = session;
  const size = def.rows * def.cols;
  const encoderIds = [...new Set(Object.keys(orig.encoders).map((k) => +k.split(',')[1]))];
  const encoderCount = encoderIds.length ? Math.max(...encoderIds) + 1 : 0;
  return {
    name: def.name,
    vendorProductId: def.vendorId * 65536 + def.productId,
    macros: Array.from({ length: session.macroCount }, (_, i) => {
      const m = session.orig.macros[i];
      return m.steps ? stepsToExpression(m.steps) : '';
    }),
    layers: Array.from({ length: session.layers }, (_, l) => orig.keymap.slice(l * size, (l + 1) * size).map(viaKeyName)),
    encoders: Array.from({ length: encoderCount }, (_, e) => Array.from({ length: session.layers }, (_, l) =>
      [false, true].map((cw) => viaKeyName(orig.encoders[`${l},${e},${cw ? 1 : 0}`] ?? 0)))),
  };
}

// VIA 레이아웃 파일을 세션의 편집본으로 불러온다 (저장해야 기기에 기록된다). 맞지 않거나 읽을 수 없는 키가 있으면 오류.
function importViaLayout(session, file) {
  const { def } = session;
  if (!file || typeof file.name !== 'string' || !Array.isArray(file.layers) || !Number.isInteger(file.vendorProductId)) {
    throw new Error(t('VIA 레이아웃 파일이 아닙니다.'));
  }
  if (file.vendorProductId !== def.vendorId * 65536 + def.productId) throw new Error(t('다른 키보드의 VIA 레이아웃 파일입니다 ({name}).', { name: file.name }));
  const size = def.rows * def.cols;
  if (file.layers.length > session.layers || file.layers.some((layer) => !Array.isArray(layer) || layer.length !== size)) {
    throw new Error(t('VIA 레이아웃 파일의 레이어 수나 키 수가 이 키보드와 다릅니다.'));
  }
  const unknown = new Set();
  const code = (name) => { const c = parseViaKey(name); if (c === null) unknown.add(String(name)); return c ?? 0; };
  const keymap = session.work.keymap.slice();
  file.layers.forEach((layer, l) => layer.forEach((name, i) => { keymap[l * size + i] = code(name); }));
  const encoders = { ...session.work.encoders };
  (Array.isArray(file.encoders) ? file.encoders : []).forEach((perLayer, e) => (perLayer || []).forEach((pair, l) => {
    [false, true].forEach((cw, j) => { const key = `${l},${e},${cw ? 1 : 0}`; if (key in encoders && pair?.[j] !== undefined) encoders[key] = code(pair[j]); });
  }));
  if (unknown.size) throw new Error(t('VIA 레이아웃 파일에 읽을 수 없는 키가 있습니다: {names}', { names: [...unknown].slice(0, 8).join(', ') }));
  let macros = null;
  if (Array.isArray(file.macros) && session.macroCount) {
    if (file.macros.length !== session.macroCount) throw new Error(t('VIA 레이아웃 파일의 매크로 수({n})가 이 키보드({m})와 다릅니다.', { n: file.macros.length, m: session.macroCount }));
    macros = file.macros.map((text) => ({ steps: expressionToSteps(text) }));
  }
  if (!session.editable) session.needEditable();
  // 중간에 실패하면(매크로가 저장 공간을 넘는 등) 편집본을 불러오기 전으로 되돌린다
  const before = structuredClone(session.work);
  try {
    keymap.forEach((c, i) => { if (c !== session.work.keymap[i]) session.setKeycode(Math.floor(i / size), Math.floor(i / def.cols) % def.rows, i % def.cols, c); });
    for (const [key, c] of Object.entries(encoders)) {
      if (c !== session.work.encoders[key]) { const [l, e, cw] = key.split(',').map(Number); session.setEncoder(l, e, !!cw, c); }
    }
    if (macros) session.setMacros(macros.map((m) => m.steps));
  } catch (e) {
    session.work = before;
    throw e;
  }
}

export { viaKeyName, parseViaKey, stepsToExpression, expressionToSteps, exportViaLayout, importViaLayout };
