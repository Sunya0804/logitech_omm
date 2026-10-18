// VIA 정의 파일(키보드마다 따로 있는 JSON)의 해석. 두 모양을 받는다.
// - 원본: layouts.keymap이 KLE(keyboard-layout-editor) 배열이고, vendorId·productId가 문자열인 파일 (키보드 제작사가 배포하는 것)
// - 변환본: usevia.app·제작사 웹 허브가 내려 주는 것. layouts.keys에 키 위치가 계산돼 있고 vendorProductId가 숫자다.
// KLE 범례 규칙(왼쪽 위 "행,열", 오른쪽 아래 "옵션,선택", 가운데 "e번호" 인코더)과 레이아웃 옵션 비트 배치는
// VIA 문서(caniusevia.com)의 설명을 따랐다. 코드는 가져오지 않았다.
import { t } from './i18n.js';

// ---------- 정의 파일을 받을 곳 ----------

const vendorProductId = (vendorId, productId) => vendorId * 65536 + productId;
// usevia.app은 다른 사이트에서 받아 갈 수 있게 열려 있다(Access-Control-Allow-Origin: *). VIA 목록에 있는 키보드만 있다.
const USEVIA = (id) => `https://usevia.app/definitions/v3/${id}.json`;
// 제작사 웹 허브. 다른 사이트에서 받아 갈 수 없게 막혀 있어서, 사용자가 링크로 파일을 받아 불러온다.
const VENDOR_HUBS = {
  0x514b: { name: 'Qwertykeys', page: 'https://cfg.qwertykeys.com/#/', url: (id) => `https://cfg.qwertykeys.com/definitions/v3/${id}.json` },
};

// 이 사이트에 함께 실은 제작사 정의 파일 (definitions/README.md에 출처·날짜·해시). 키: vendorProductId
const BUNDLED = {
  1363889410: { name: 'Qwertykeys QK80 MK2', path: 'definitions/qwertykeys/1363889410.json', fetchedAt: '2026-10-18' },
};

// 이 키보드의 정의 파일을 받을 곳: [{kind: 'bundled' | 'fetch' | 'link', name, url, page?, fetchedAt?}]
// bundled와 fetch는 fetchDefinition이 이 순서로 자동으로 받고, link는 사용자가 받아 불러온다.
function definitionSources(vendorId, productId) {
  const id = vendorProductId(vendorId, productId);
  const hub = VENDOR_HUBS[vendorId];
  const bundled = BUNDLED[id];
  return [
    ...(bundled ? [{ kind: 'bundled', name: bundled.name, url: bundled.path, fetchedAt: bundled.fetchedAt }] : []),
    { kind: 'fetch', name: 'VIA', url: USEVIA(id) },
    ...(hub ? [{ kind: 'link', name: hub.name, url: hub.url(id), page: hub.page }] : []),
  ];
}

// 받아 갈 수 있는 곳에서 정의 파일을 찾는다. 없으면 null. (usevia.app은 없는 파일에도 HTML로 200을 돌려준다.)
async function fetchDefinition(vendorId, productId, fetchFn = fetch) {
  for (const source of definitionSources(vendorId, productId).filter((s) => s.kind !== 'link')) {
    try {
      const res = await fetchFn(source.url);
      if (!res.ok || !/json/.test(res.headers.get('content-type') || '')) continue;
      const json = await res.json();
      const def = parseDefinition(json);
      if (def.vendorId === vendorId && def.productId === productId) return { json, def, source };
    } catch { /* 다음 곳을 본다 */ }
  }
  return null;
}

// 불러온 정의 파일을 이 브라우저에 기억해 둔다. 저장소를 쓸 수 없으면 조용히 넘어간다.
const cacheKey = (id) => `gomm.via.definition.${id}`;
function rememberDefinition(json) {
  try {
    const def = parseDefinition(json);
    localStorage.setItem(cacheKey(vendorProductId(def.vendorId, def.productId)), JSON.stringify(json));
  } catch { /* 저장하지 못해도 이번 연결에는 문제가 없다 */ }
}
function rememberedDefinition(vendorId, productId) {
  try {
    const text = localStorage.getItem(cacheKey(vendorProductId(vendorId, productId)));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
function forgetDefinition(vendorId, productId) {
  try { localStorage.removeItem(cacheKey(vendorProductId(vendorId, productId))); } catch { /* 없음 */ }
}

// ---------- KLE ----------

// KLE 문자열의 n번째 범례가 키 위의 어느 자리인지 (정렬 a마다 다르다). 자리: 0 왼쪽 위, 4 가운데, 8 오른쪽 아래 등 12곳.
const LABEL_MAP = [
  [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10],
  [1, 7, -1, -1, 9, 11, 4, -1, -1, -1, -1, 10],
  [3, -1, 5, -1, 9, 11, -1, -1, 4, -1, -1, 10],
  [4, -1, -1, -1, 9, 11, -1, -1, -1, -1, -1, 10],
  [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1],
  [1, 7, -1, -1, 10, -1, 4, -1, -1, -1, -1, -1],
  [3, -1, 5, -1, 10, -1, -1, -1, 4, -1, -1, -1],
  [4, -1, -1, -1, 10, -1, -1, -1, -1, -1, -1, -1],
];

// KLE 색 → VIA 키 색 이름 (alpha 글자 키, mod 수정자 키, accent 강조 키)
function colorName(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return 'alpha';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min > 0.3) return 'accent';
  return (max + min) / 2 < 0.6 ? 'mod' : 'alpha';
}

// KLE 배열 → [{row, col, x, y, w, h, r, rx, ry, color, option?: [옵션, 선택], encoder?: 번호, shape?}]
function parseKle(rows) {
  if (!Array.isArray(rows)) throw new Error(t('정의 파일의 키 배치(layouts.keymap)가 배열이 아닙니다.'));
  const keys = [];
  const cur = { x: 0, y: 0, r: 0, rx: 0, ry: 0, a: 4, c: null };
  let next = { w: 1, h: 1, x2: 0, y2: 0, w2: 0, h2: 0, d: false };
  for (const row of rows) {
    if (!Array.isArray(row)) continue; // 머리 정보(이름 등)
    for (const item of row) {
      if (item && typeof item === 'object') {
        if (item.r !== undefined) cur.r = item.r;
        if (item.rx !== undefined) { cur.rx = item.rx; cur.x = item.rx; cur.y = cur.ry; }
        if (item.ry !== undefined) { cur.ry = item.ry; cur.y = item.ry; cur.x = cur.rx; }
        if (item.a !== undefined) cur.a = item.a;
        if (item.c !== undefined) cur.c = item.c;
        if (item.x !== undefined) cur.x += item.x;
        if (item.y !== undefined) cur.y += item.y;
        for (const k of ['w', 'h', 'x2', 'y2', 'w2', 'h2']) if (item[k] !== undefined) next[k] = item[k];
        if (item.d) next.d = true;
        continue;
      }
      const raw = String(item).split('\n');
      const labels = [];
      raw.forEach((text, i) => { const pos = (LABEL_MAP[cur.a] || LABEL_MAP[4])[i]; if (pos >= 0) labels[pos] = text; });
      if (!next.d) {
        const key = { x: cur.x, y: cur.y, w: next.w, h: next.h, r: cur.r, rx: cur.rx, ry: cur.ry, color: colorName(cur.c) };
        const matrix = /^(\d+),(\d+)$/.exec((labels[0] || '').trim());
        if (matrix) [key.row, key.col] = [+matrix[1], +matrix[2]];
        const option = /^(\d+),(\d+)$/.exec((labels[8] || '').trim());
        if (option) key.option = [+option[1], +option[2]];
        const enc = labels.map((l) => /^e(\d+)$/.exec((l || '').trim())).find(Boolean);
        if (enc) key.encoder = +enc[1];
        if (next.w2 || next.h2) key.shape = { x2: next.x2, y2: next.y2, w2: next.w2 || next.w, h2: next.h2 || next.h };
        keys.push(key);
      }
      cur.x += next.w;
      next = { w: 1, h: 1, x2: 0, y2: 0, w2: 0, h2: 0, d: false };
    }
    cur.y += 1;
    cur.x = cur.rx;
  }
  return keys;
}

// ---------- 메뉴(조명·설정) ----------

// action: 켜는 순간 무언가를 실행하는 토글(초기화·페어링 삭제·DFU 진입 등). 값으로 읽지 않는다.
// danger: 기기 상태를 크게 바꾸는 항목(action과 연결 방식 전환). 화면에서 확인을 받아야 한다.
const ACTION_WORDS = /reset|clear|eeprom|bootloader|dfu|delete|erase|factory|shutdown|초기화|삭제/i;
const DANGER_WORDS = /connect|connection|연결/i;

// 메뉴 항목 하나를 정리한다. 알 수 없는 모양이면 null.
function menuItem(raw, path) {
  const [id, ...head] = Array.isArray(raw.content) ? raw.content : [];
  if (typeof id !== 'string' || head.length < 2 || !head.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  const words = `${id} ${raw.label}`;
  const action = raw.type === 'toggle' && ACTION_WORDS.test(words);
  const item = { id, label: String(raw.label ?? id), type: raw.type, head, path, showIf: raw.showIf || null, action, danger: action || DANGER_WORDS.test(words) };
  switch (raw.type) {
    case 'range': {
      const [min, max] = Array.isArray(raw.options) ? raw.options : [0, 255];
      return { ...item, min, max, size: max > 255 ? 2 : 1 };
    }
    case 'dropdown':
      if (!Array.isArray(raw.options)) return null;
      return { ...item, size: 1, choices: raw.options.map((o, i) => (Array.isArray(o) ? { label: String(o[0]), value: o[1] } : { label: String(o), value: i })) };
    case 'toggle': {
      const [off, on] = Array.isArray(raw.options) ? raw.options : [0, 1];
      return { ...item, size: 1, off, on };
    }
    case 'color': return { ...item, size: 2 };
    case 'keycode': return { ...item, size: 2 };
    default: return null;
  }
}

// v3 menus → {sections: [{label, groups: [{label, items}]}], items: 모든 항목, unsupported: 다루지 못한 것의 이름}
function parseMenus(menus) {
  const sections = [];
  const items = [];
  const unsupported = [];
  const collect = (list, path, out) => {
    for (const raw of list || []) {
      if (typeof raw === 'string') { unsupported.push(raw); continue; } // qmk_rgblight 같은 VIA 내장 메뉴 이름
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type) {
        const item = menuItem(raw, path);
        if (item) { out.push(item); items.push(item); } else unsupported.push(String(raw.label ?? raw.type));
      } else if (Array.isArray(raw.content)) collect(raw.content, [...path, String(raw.label ?? '')], out);
    }
  };
  for (const menu of Array.isArray(menus) ? menus : []) {
    if (typeof menu === 'string') { unsupported.push(menu); continue; }
    const section = { label: String(menu.label ?? ''), groups: [] };
    for (const group of menu.content || []) {
      if (group && typeof group === 'object' && !group.type) {
        const g = { label: String(group.label ?? ''), items: [] };
        collect(group.content, [section.label, g.label], g.items);
        if (g.items.length) section.groups.push(g);
      } else {
        const g = { label: '', items: [] };
        collect([group], [section.label], g.items);
        if (g.items.length) section.groups.push(g);
      }
    }
    if (section.groups.length) sections.push(section);
  }
  return { sections, items, unsupported };
}

// 메뉴 값 ↔ 바이트. 색은 {hue, sat} (각 0~255), 나머지는 수.
function encodeValue(item, value) {
  if (item.type === 'color') return [value.hue & 0xff, value.sat & 0xff];
  return item.size === 2 ? [(value >> 8) & 0xff, value & 0xff] : [value & 0xff];
}
function decodeValue(item, bytes) {
  if (item.type === 'color') return { hue: bytes[0], sat: bytes[1] };
  return item.size === 2 ? (bytes[0] << 8) | bytes[1] : bytes[0];
}

// showIf 식: {id} == 3 && ({id2} != 0 || !{id3}) 같은 모양. eval을 쓰지 않고 직접 푼다. 풀 수 없으면 true(보여 준다).
function evaluateShowIf(expr, values) {
  if (!expr) return true;
  const tokens = String(expr).match(/\{[^}]+\}|\d+|==|!=|>=|<=|&&|\|\||[()<>!]/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== String(expr).replace(/\s/g, '')) return true;
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  const value = (v) => (v && typeof v === 'object' ? v.hue : v ?? 0);
  function primary() {
    const tok = take();
    if (tok === '(') { const v = or(); if (take() !== ')') throw new Error('paren'); return v; }
    if (tok === '!') return primary() ? 0 : 1;
    if (/^\d+$/.test(tok)) return +tok;
    if (/^\{.+\}$/.test(tok)) return value(values[tok.slice(1, -1)]);
    throw new Error('token');
  }
  function compare() {
    let left = primary();
    while (['==', '!=', '>', '<', '>=', '<='].includes(peek())) {
      const op = take();
      const right = primary();
      left = { '==': left === right, '!=': left !== right, '>': left > right, '<': left < right, '>=': left >= right, '<=': left <= right }[op] ? 1 : 0;
    }
    return left;
  }
  function and() { let v = compare(); while (peek() === '&&') { take(); const r = compare(); v = v && r ? 1 : 0; } return v; }
  function or() { let v = and(); while (peek() === '||') { take(); const r = and(); v = v || r ? 1 : 0; } return v; }
  try {
    const v = or();
    return i === tokens.length ? !!v : true;
  } catch {
    return true;
  }
}

// ---------- 정의 파일 ----------

const num = (v) => (typeof v === 'string' ? parseInt(v, v.startsWith('0x') || v.startsWith('0X') ? 16 : 10) : v);

// 정의 파일 → {name, vendorId, productId, rows, cols, keys, optionKeys, options, width, height, menus, customKeycodes, lighting, version}
// keys: 옵션과 무관한 키, optionKeys[옵션][선택]: 그 선택일 때만 있는 키. 문제가 있으면 오류를 던진다.
function parseDefinition(json) {
  if (!json || typeof json !== 'object') throw new Error(t('정의 파일이 JSON 객체가 아닙니다.'));
  let vendorId; let productId;
  if (Number.isInteger(json.vendorProductId)) [vendorId, productId] = [Math.floor(json.vendorProductId / 65536), json.vendorProductId % 65536];
  else [vendorId, productId] = [num(json.vendorId), num(json.productId)];
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) throw new Error(t('정의 파일에 제조사·제품 ID가 없습니다.'));
  const rows = json.matrix?.rows;
  const cols = json.matrix?.cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 32 || cols > 32) throw new Error(t('정의 파일의 행렬(matrix) 크기가 올바르지 않습니다.'));
  const layouts = json.layouts || {};

  let all;
  if (Array.isArray(layouts.keys)) {
    // 변환본: 옵션 키는 optionKeys에 따로 있다
    all = layouts.keys.map((k) => ({ ...k }));
    for (const [opt, choices] of Object.entries(layouts.optionKeys || {})) {
      for (const [choice, list] of Object.entries(choices)) for (const k of list) all.push({ ...k, option: [+opt, +choice] });
    }
  } else {
    all = parseKle(layouts.keymap);
  }
  all = all.filter((k) => !k.d).map((k) => ({
    row: k.row, col: k.col, x: +k.x || 0, y: +k.y || 0, w: +k.w || 1, h: +k.h || 1, r: +k.r || 0, rx: +k.rx || 0, ry: +k.ry || 0,
    color: k.color || 'alpha', ...(k.option ? { option: k.option } : {}), ...(Number.isInteger(k.ei ?? k.encoder) ? { encoder: k.ei ?? k.encoder } : {}),
    ...(k.shape ? { shape: k.shape } : k.w2 ? { shape: { x2: k.x2 || 0, y2: k.y2 || 0, w2: k.w2, h2: k.h2 || k.h } } : {}),
  }));
  const bad = all.find((k) => k.encoder === undefined && (!Number.isInteger(k.row) || !Number.isInteger(k.col) || k.row >= rows || k.col >= cols));
  if (bad) throw new Error(t('정의 파일의 키({row},{col})가 행렬 밖에 있습니다.', { row: bad.row, col: bad.col }));
  if (!all.length) throw new Error(t('정의 파일에 키 배치가 없습니다.'));

  const options = (layouts.labels || []).map((l) => (Array.isArray(l) ? { label: String(l[0]), choices: l.slice(1).map(String) } : { label: String(l), choices: [t('끔'), t('켬')], toggle: true }));
  const keys = all.filter((k) => !k.option);
  const optionKeys = options.map(() => ({}));
  for (const k of all.filter((x) => x.option)) {
    const [opt, choice] = k.option;
    if (!optionKeys[opt]) continue; // 이름표 없는 옵션
    (optionKeys[opt][choice] ||= []).push(k);
  }
  alignOptionKeys(optionKeys);
  const visible = [...keys, ...optionKeys.flatMap((o) => Object.values(o).flat())];
  const menus = parseMenus(json.menus);
  if (json.lighting) menus.unsupported.push(typeof json.lighting === 'string' ? json.lighting : 'lighting');
  return {
    name: String(json.name || 'VIA'), vendorId, productId, rows, cols, keys, optionKeys, options,
    width: Math.max(...visible.map((k) => k.x + k.w)), height: Math.max(...visible.map((k) => k.y + k.h)),
    menus, customKeycodes: Array.isArray(json.customKeycodes) ? json.customKeycodes : [],
    lighting: Array.isArray(json.keycodes) && json.keycodes.includes('qmk_lighting'),
    version: Array.isArray(layouts.keys) || json.menus ? 3 : 2,
  };
}

// KLE에서는 옵션의 다른 선택을 키보드 밖에 따로 그려 두므로, 각 선택을 첫 선택(0)의 자리로 옮긴다.
// 이미 같은 자리에 있으면 움직이지 않는다.
function alignOptionKeys(optionKeys) {
  const corner = (list) => [Math.min(...list.map((k) => k.x)), Math.min(...list.map((k) => k.y))];
  for (const choices of optionKeys) {
    const base = choices[0];
    if (!base?.length) continue;
    const [bx, by] = corner(base);
    for (const [choice, list] of Object.entries(choices)) {
      if (choice === '0' || !list.length) continue;
      const [x, y] = corner(list);
      for (const k of list) { k.x += bx - x; k.y += by - y; if (k.rx) k.rx += bx - x; if (k.ry) k.ry += by - y; }
    }
  }
}

// ---------- 레이아웃 옵션 ----------

// 옵션마다 선택지 수를 담을 비트 수(최소 1)를 쓰고, 마지막 옵션이 가장 낮은 비트에 온다.
const optionBits = (o) => Math.max(1, Math.ceil(Math.log2(o.choices.length)));
function decodeLayoutOptions(value, options) {
  const out = new Array(options.length).fill(0);
  let v = value >>> 0;
  for (let i = options.length - 1; i >= 0; i--) {
    const bits = optionBits(options[i]);
    out[i] = Math.min(v & ((1 << bits) - 1), options[i].choices.length - 1);
    v >>>= bits;
  }
  return out;
}
function encodeLayoutOptions(choices, options) {
  let v = 0;
  let shift = 0;
  for (let i = options.length - 1; i >= 0; i--) {
    v |= (choices[i] & ((1 << optionBits(options[i])) - 1)) << shift;
    shift += optionBits(options[i]);
  }
  return v >>> 0;
}

// 지금 고른 레이아웃 옵션으로 보이는 키들
function visibleKeys(def, choices) {
  return [...def.keys, ...def.optionKeys.flatMap((o, i) => o[choices[i] ?? 0] || [])];
}

export {
  vendorProductId, definitionSources, fetchDefinition, rememberDefinition, rememberedDefinition, forgetDefinition,
  parseKle, parseMenus, parseDefinition, evaluateShowIf, encodeValue, decodeValue,
  decodeLayoutOptions, encodeLayoutOptions, visibleKeys, VENDOR_HUBS, BUNDLED,
};
