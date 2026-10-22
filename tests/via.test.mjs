// VIA 키보드 지원(js/via*.js) 시험: 통신, 키 코드, 정의 파일, 매크로, 편집·저장.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ViaDevice, CMD } from '../js/via.js';
import * as K from '../js/via-keycodes.js';
import * as D from '../js/via-definition.js';
import * as M from '../js/via-macro.js';
import { ViaSession } from '../js/via-session.js';
import { MockViaDevice } from '../js/mock-via.js';
import * as F from '../js/via-layout-file.js';
import { setLang } from '../js/i18n.js';

setLang('ko'); // 오류 문구를 한국어 원문으로 맞춘다 (CI는 영어 환경)

const capture = JSON.parse(readFileSync(new URL('./fixtures/via-qk80mk2.json', import.meta.url), 'utf8'));
const captureKeymap = Array.from({ length: capture.keymap.length / 4 }, (_, i) => parseInt(capture.keymap.slice(4 * i, 4 * i + 4), 16));

// 작은 원본(KLE) 정의: 2×3 행렬, 옵션 2개(분할 백스페이스 / 아래 줄 3가지), 인코더 하나
const RAW = {
  name: 'Test Board', vendorId: '0x514B', productId: '0x4D02', matrix: { rows: 2, cols: 3 },
  customKeycodes: [{ name: 'USB Mode', title: '[CNT_USB] Enter USB mode', shortName: 'USB' }],
  keycodes: ['qmk_lighting'],
  layouts: {
    labels: ['Split Backspace', ['Bottom Row', 'A', 'B', 'C']],
    keymap: [
      ['0,0', { w: 2 }, '0,1\n\n\n0,0', { x: 1 }, '0,1\n\n\n0,1', '0,2\n\n\n0,1'],
      [{ c: '#777777' }, '1,0\n\n\n1,0', { x: 1 }, '1,0\n\n\n1,1', '1,1\n\n\n1,2', { c: '#cccccc', d: true }, 'decal', '1,2\n\n\n\n\n\n\n\n\ne0'],
    ],
  },
  menus: [
    { label: 'Lighting', content: [{ label: 'Backlight', content: [
      { label: 'Brightness', type: 'range', options: [0, 255], content: ['id_b', 22, 1] },
      { label: 'Effect', type: 'dropdown', options: ['Off', 'Solid'], content: ['id_e', 22, 2] },
      { label: 'Speed', type: 'range', options: [0, 255], content: ['id_s', 22, 3], showIf: '{id_e} != 0' },
      { label: 'Color', type: 'color', content: ['id_c', 22, 4] },
    ] }] },
    { label: 'Config', content: [{ label: 'Firmware', content: [
      { label: 'Debounce', type: 'dropdown', options: [['1 ms', 1], ['5 ms', 5]], content: ['id_d', 17, 7] },
      { label: 'Clear Settings', type: 'toggle', content: ['id_cp_eeprom_reset', 16, 2] },
    ] }] },
    'qmk_audio',
  ],
};

const board = (o = {}) => new MockViaDevice({ rows: 2, cols: 3, layers: 2, macroCount: 4, macroBufferSize: 64, custom: { '22,1': [100], '22,2': [1], '17,7': [5] }, ...o });
async function session(o) {
  const mock = board(o);
  const dev = new ViaDevice([mock]);
  await dev.open();
  const s = new ViaSession(dev, RAW);
  await s.load();
  return { mock, dev, s };
}

test('requests are 32-byte reports answered by echo; unsupported commands are reported', async () => {
  const mock = board();
  const sent = [];
  const send = mock.sendReport.bind(mock);
  mock.sendReport = (id, data) => { sent.push([id, data.length]); return send(id, data); };
  const dev = new ViaDevice([{ collections: [] }, mock]);
  assert.equal(dev.dev, mock);
  await dev.open();
  assert.equal(await dev.protocolVersion(), 12);
  assert.equal(await dev.layerCount(), 2);
  assert.deepEqual(sent, [[0, 32], [0, 32]]);
  await assert.rejects(() => dev.request([0x0a]), /0x0a/); // 공장 초기화 명령은 이 파일이 내보내지 않지만, 모르는 명령의 처리 확인용
  assert.equal(dev.vendorProductId, 1363889410);
});

test('keymap and macro buffers are read in 28-byte chunks and the switch matrix is decoded', async () => {
  const keymap = Array.from({ length: 2 * 2 * 3 }, (_, i) => 0x100 * i + i);
  const mock = board({ keymap, matrix: [[0, 2], [1, 0]] });
  const dev = new ViaDevice([mock]);
  await dev.open();
  assert.deepEqual(Array.from(await dev.readKeymap(2, 2, 3)), keymap);
  const wide = new MockViaDevice({ rows: 6, cols: 16, matrix: [[5, 15], [0, 8]] });
  const dev2 = new ViaDevice([wide]);
  await dev2.open();
  const m = await dev2.switchMatrix(6, 16);
  assert.equal(m[5][15], true);
  assert.equal(m[0][8], true);
  assert.equal(m.flat().filter(Boolean).length, 2);
  assert.deepEqual((await dev.switchMatrix(2, 3)).map((r) => r.map(Number)), [[0, 0, 1], [1, 0, 0]]);
  // 실기기(QK80 MK2) 응답: A(3행 1열)를 누른 상태. 행 데이터는 3번 바이트부터다.
  const real = { collections: [{ usagePage: 0xff60, usage: 0x61 }], opened: true, addEventListener: (_, fn) => { real.fn = fn; }, removeEventListener() {},
    sendReport: async () => { const r = Uint8Array.from('0203000000000000000002'.padEnd(64, '0').match(/../g), (x) => parseInt(x, 16)); queueMicrotask(() => real.fn({ data: new DataView(r.buffer) })); } };
  const qk = new ViaDevice([real]);
  await qk.open();
  const pressed = (await qk.switchMatrix(6, 16)).flatMap((r, row) => r.map((on, col) => (on ? `${row},${col}` : null))).filter(Boolean);
  assert.deepEqual(pressed, ['3,1']);
  // 프로토콜 11 이하는 2번 바이트부터
  const old = new MockViaDevice({ protocol: 11, rows: 2, cols: 3, matrix: [[1, 2]] });
  const oldDev = new ViaDevice([old]);
  await oldDev.open();
  assert.deepEqual((await oldDev.switchMatrix(2, 3, 11)).map((r) => r.map(Number)), [[0, 0, 0], [0, 0, 1]]);
});

test('protocol 12 keycodes are named, labelled and parsed back', () => {
  const cases = {
    0x0000: 'KC_NO', 0x0001: 'KC_TRNS', 0x0004: 'KC_A', 0x0029: 'KC_ESC', 0x003a: 'KC_F1', 0x00e1: 'KC_LSFT', 0x00a9: 'KC_VOLU',
    0x0206: 'LSFT(KC_C)', 0x0306: 'LCTL(LSFT(KC_C))', 0x1206: 'RSFT(KC_C)', 0x2229: 'LSFT_T(KC_ESC)', 0x2329: 'MT(MOD_LCTL | MOD_LSFT, KC_ESC)',
    0x412c: 'LT(1, KC_SPC)', 0x5221: 'MO(1)', 0x5202: 'TO(2)', 0x5263: 'TG(3)', 0x52a2: 'OSM(MOD_LSFT)', 0x5022: 'LM(1, MOD_LSFT)',
    0x5703: 'TD(3)', 0x7700: 'MC_0', 0x770f: 'MC_15', 0x7820: 'RGB_TOG', 0x7c00: 'QK_BOOT', 0x7e03: 'QK_KB_3', 0x7e40: 'QK_USER_0', 0x6000: '0x6000',
  };
  for (const [code, name] of Object.entries(cases)) {
    assert.equal(K.keycodeName(+code), name);
    assert.equal(K.parseKeycode(name), +code, name);
  }
  assert.equal(K.parseKeycode('KC_ESCAPE'), 0x29);
  assert.equal(K.parseKeycode('LCTL(RSFT(KC_A))'), null); // 왼쪽·오른쪽 수정자를 섞을 수 없다
  assert.equal(K.parseKeycode('LT(16, KC_A)'), null);
  assert.equal(K.parseKeycode('nonsense'), null);
  assert.deepEqual(K.keycodeLabel(0x7e00, { customKeycodes: RAW.customKeycodes }), { label: 'USB', title: '[CNT_USB] Enter USB mode', danger: false });
  assert.equal(K.keycodeLabel(0x7c00).danger, true);
  assert.equal(K.isSupportedProtocol(11), false);
  const groups = K.keycodeGroups({ layers: 4, macroCount: 2, customKeycodes: RAW.customKeycodes, lighting: true });
  assert.deepEqual(groups.map((g) => g.id), ['basic', 'numpad', 'extra', 'media', 'mouse', 'layers', 'lighting', 'macro', 'custom', 'quantum', 'special']);
  assert.equal(groups.find((g) => g.id === 'layers').keys.length, 24);
  assert.ok(groups.every((g) => g.keys.every((k) => Number.isInteger(k.code) && k.title)));
});

test('the real QK80 MK2 keymap decodes to the expected keys', () => {
  assert.equal(captureKeymap.length, capture.layers * capture.rows * capture.cols);
  const names = captureKeymap.slice(0, 13).map(K.keycodeName);
  assert.deepEqual(names, ['KC_ESC', ...Array.from({ length: 12 }, (_, i) => `KC_F${i + 1}`)]);
  assert.ok(captureKeymap.includes(0x5221)); // MO(1)
  assert.ok(captureKeymap.every((c) => !K.keycodeName(c).startsWith('0x') || c >= 0x7e00), 'every code has a name');
});

test('raw KLE definitions are parsed with matrix positions, options, decals and encoders', () => {
  const def = D.parseDefinition(RAW);
  assert.equal(def.vendorId, 0x514b);
  assert.equal(def.version, 3);
  assert.deepEqual(def.keys.map((k) => [k.row, k.col, k.x, k.y, k.w]), [[0, 0, 0, 0, 1], [1, 2, 5, 1, 1]]);
  assert.equal(def.keys[1].encoder, 0);
  assert.deepEqual(def.options, [{ label: 'Split Backspace', choices: ['끔', '켬'], toggle: true }, { label: 'Bottom Row', choices: ['A', 'B', 'C'] }]);
  // 분할 백스페이스의 두 번째 선택은 첫 선택(x=1) 자리로 옮겨진다
  assert.deepEqual(def.optionKeys[0][1].map((k) => [k.row, k.col, k.x]), [[0, 1, 1], [0, 2, 2]]);
  assert.equal(def.optionKeys[1][0][0].color, 'mod');
  assert.deepEqual(D.visibleKeys(def, [1, 2]).map((k) => `${k.row},${k.col}`), ['0,0', '1,2', '0,1', '0,2', '1,1']);
  assert.deepEqual(def.menus.unsupported, ['qmk_audio']);
  assert.deepEqual(def.menus.items.map((i) => [i.id, i.type, i.size, i.action, i.danger]), [
    ['id_b', 'range', 1, false, false], ['id_e', 'dropdown', 1, false, false], ['id_s', 'range', 1, false, false], ['id_c', 'color', 2, false, false],
    ['id_d', 'dropdown', 1, false, false], ['id_cp_eeprom_reset', 'toggle', 1, true, true],
  ]);
  const connect = D.parseMenus([{ label: 'C', content: [{ label: 'Connect Mode', type: 'dropdown', options: ['USB', '2.4G'], content: ['id_cp_connect_mode', 18, 1] }] }]).items[0];
  assert.deepEqual([connect.action, connect.danger], [false, true]);
  assert.deepEqual(def.menus.items[4].choices, [{ label: '1 ms', value: 1 }, { label: '5 ms', value: 5 }]);
  assert.throws(() => D.parseDefinition({ ...RAW, matrix: { rows: 1, cols: 3 } }), /행렬 밖/);
  assert.throws(() => D.parseDefinition({ ...RAW, vendorId: undefined }), /ID/);
});

test('compiled definitions (usevia.app, vendor hubs) are read as they come', () => {
  const compiled = {
    name: 'Compiled', vendorProductId: 0x514b4d02, matrix: { rows: 1, cols: 3 }, menus: [],
    layouts: {
      labels: ['Split'], width: 3, height: 1,
      keys: [{ row: 0, col: 0, x: 0, y: 0, w: 1, h: 1, r: 0, rx: 0, ry: 0, color: 'alpha' }],
      optionKeys: { 0: { 0: [{ row: 0, col: 1, x: 1, y: 0, w: 2, h: 1, color: 'alpha' }], 1: [{ row: 0, col: 1, x: 1, y: 0, w: 1, h: 1 }, { row: 0, col: 2, x: 2, y: 0, w: 1, h: 1 }] } },
    },
  };
  const def = D.parseDefinition(compiled);
  assert.deepEqual([def.vendorId, def.productId, def.width, def.height], [0x514b, 0x4d02, 3, 1]);
  assert.deepEqual(D.visibleKeys(def, [1]).map((k) => k.col), [0, 1, 2]);
});

test('layout options pack the last option into the lowest bits', () => {
  const { options } = D.parseDefinition(RAW);
  assert.equal(D.encodeLayoutOptions([1, 2], options), 0b110);
  assert.deepEqual(D.decodeLayoutOptions(0b110, options), [1, 2]);
  assert.deepEqual(D.decodeLayoutOptions(0b011, options), [0, 2]); // 범위를 넘는 선택(3)은 마지막 선택으로
});

test('showIf expressions are evaluated without eval', () => {
  const v = { a: 3, b: 0, c: { hue: 5, sat: 9 } };
  assert.equal(D.evaluateShowIf('{a} != 0', v), true);
  assert.equal(D.evaluateShowIf('{a} == 3 && {b} == 1', v), false);
  assert.equal(D.evaluateShowIf('({a} == 1 || {b} == 0) && !{b}', v), true);
  assert.equal(D.evaluateShowIf('{a} > 2 && {a} <= 3', v), true);
  assert.equal(D.evaluateShowIf('{c} == 5', v), true);
  assert.equal(D.evaluateShowIf('alert(1)', v), true); // 풀 수 없는 식은 보여 준다
  assert.equal(D.evaluateShowIf(null, v), true);
});

test('definition sources: bundled copy first, then VIA, then the Qwertykeys download link', async () => {
  const sources = D.definitionSources(0x514b, 0x4d02);
  assert.deepEqual(sources.map((s) => s.kind), ['bundled', 'fetch', 'link']);
  assert.equal(sources[0].url, 'definitions/qwertykeys/1363889410.json');
  assert.equal(sources[2].url, 'https://cfg.qwertykeys.com/definitions/v3/1363889410.json');
  assert.deepEqual(D.definitionSources(0x514b, 0x1111).map((s) => s.kind), ['fetch', 'link']);
  assert.equal(D.definitionSources(0x1234, 0x5678).length, 1);
  const html = async () => ({ ok: true, headers: { get: () => 'text/html' }, json: async () => { throw new Error('html'); } });
  assert.equal(await D.fetchDefinition(0x514b, 0x4d02, html), null);
  const json = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => RAW });
  const found = await D.fetchDefinition(0x514b, 0x4d02, json);
  assert.deepEqual([found.def.name, found.source.kind], ['Test Board', 'bundled']);
  assert.equal(await D.fetchDefinition(0x1111, 0x2222, json), null); // 다른 키보드의 파일
});

test('definition sources: keyboards that share one ID → the user picks a bundled copy', async () => {
  const sources = D.definitionSources(0x320f, 0x5055);
  assert.deepEqual(sources.map((s) => s.kind), ['choice', 'choice', 'choice', 'fetch']);
  assert.deepEqual(sources.slice(0, 3).map((s) => s.name), ['WOBKEY Crush 80 (RGB)', 'WOBKEY Crush 80 (non-RGB)', 'archon RE:AL HX']);
  const calls = [];
  const json = async (url) => { calls.push(url); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ...RAW, vendorId: '0x320F', productId: '0x5055' }) }; };
  // 고르기 전에는 아무것도 받지 않는다
  assert.equal(await D.fetchDefinition(0x320f, 0x5055, json), null);
  assert.deepEqual(calls, []);
  // 「자동으로 찾기」는 내장 후보를 건너뛰고 VIA 목록만 본다
  const found = await D.fetchDefinition(0x320f, 0x5055, json, { force: true });
  assert.deepEqual([found.source.kind, calls], ['fetch', ['https://usevia.app/definitions/v3/839864405.json']]);
  // 고른 후보는 그 파일만 받고, 다른 키보드의 파일이면 거절한다
  const picked = await D.fetchSource(sources[2], 0x320f, 0x5055, json);
  assert.deepEqual([picked.source.name, calls.at(-1)], ['archon RE:AL HX', 'definitions/archon/839864405.json']);
  assert.equal(await D.fetchSource(sources[2], 0x320f, 0x5088, json), null);
});

test('every bundled definition file exists, parses, matches its ID and the README table', () => {
  const readme = readFileSync(new URL('../definitions/README.md', import.meta.url), 'utf8');
  const list = D.bundledList();
  assert.ok(list.length >= 13);
  for (const b of list) {
    const bytes = readFileSync(new URL('../' + b.path, import.meta.url));
    const def = D.parseDefinition(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
    assert.equal(def.vendorId * 65536 + def.productId, b.id, b.path);
    assert.ok(def.keys.length > 0, b.path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const row = readme.split('\n').find((l) => l.includes('`' + b.path.replace('definitions/', '') + '`'));
    assert.ok(row, 'README row: ' + b.path);
    assert.ok(row.includes('`' + hash.slice(0, 8) + '…' + hash.slice(-6) + '`'), 'README hash: ' + b.path);
    assert.ok(row.includes(b.fetchedAt), 'README date: ' + b.path);
  }
});

test('macros: text, taps, presses and delays round-trip; unknown bytes stay untouched', () => {
  const steps = [
    { kind: 'text', text: 'Hi!' }, { kind: 'key', down: true, mods: 0x01, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x06 },
    { kind: 'key', down: false, mods: 0, usage: 0x06 }, { kind: 'key', down: false, mods: 0x01, usage: 0 }, { kind: 'delay', ms: 250 },
  ];
  const bytes = M.encodeMacro(steps);
  assert.deepEqual(bytes, [0x48, 0x69, 0x21, 1, 2, 0xe0, 1, 1, 0x06, 1, 3, 0xe0, 1, 4, 0x32, 0x35, 0x30, 0x7c]);
  assert.deepEqual(M.decodeMacro(Uint8Array.from(bytes)), { steps, editable: true });
  assert.equal(M.decodeMacro(Uint8Array.of(0x48, 0x05, 0x01)).editable, false);
  const buffer = M.encodeMacros([{ steps }, { bytes: [0x05, 0x01] }, { steps: [] }], 40);
  const back = M.decodeMacros(buffer, 4);
  assert.deepEqual(back[0].steps, steps);
  assert.deepEqual([...back[1].bytes], [0x05, 0x01]);
  assert.equal(back[1].editable, false);
  assert.deepEqual(back[2].steps, []);
  assert.deepEqual(back[3].steps, []);
  assert.throws(() => M.encodeMacros([{ steps }], 10), /저장 공간/);
  assert.throws(() => M.encodeMacro([{ kind: 'text', text: '한글' }]), /ASCII/);
  assert.throws(() => M.encodeMacro([{ kind: 'key', down: true, mods: 0, usage: 0x1234 }]));
});

test('a session loads everything, stages edits and saves only what changed', async () => {
  const { mock, s } = await session({ encoders: { '0,0,0': 0xaa, '0,0,1': 0xa9 } });
  assert.equal(s.protocol, 12);
  assert.equal(s.editable, true);
  assert.equal(s.keycode(0, 0, 0), 0x04);
  assert.equal(s.encoder(0, 0, true), 0xa9);
  assert.deepEqual(s.work.custom, { id_b: 100, id_e: 1, id_s: 0, id_c: { hue: 0, sat: 0 }, id_d: 5 });
  assert.equal('id_cp_eeprom_reset' in s.work.custom, false); // 초기화 항목은 읽지 않는다
  assert.equal(s.isDirty(), false);
  assert.equal(s.itemVisible(s.def.menus.items[2]), true);
  s.setCustom('id_e', 0);
  assert.equal(s.itemVisible(s.def.menus.items[2]), false);
  s.setCustom('id_e', 1);
  assert.equal(s.isDirty(), false);

  s.setKeycode(1, 1, 2, K.parseKeycode('MO(1)'));
  s.setEncoder(0, 0, false, 0xab);
  s.setLayoutOption(1, 2);
  s.setMacro(2, [{ kind: 'text', text: 'ok' }]);
  s.setCustom('id_b', 200);
  s.setCustom('id_c', { hue: 10, sat: 20 });
  assert.deepEqual(s.changes().map((c) => c.kind), ['key', 'encoder', 'options', 'macro', 'custom', 'custom']);
  assert.throws(() => s.setMacro(0, [{ kind: 'text', text: 'x'.repeat(80) }]), /저장 공간/);
  await s.save();
  assert.equal(s.isDirty(), false);
  assert.equal(mock.keymap[(1 * 2 + 1) * 3 + 2], 0x5221);
  assert.equal(mock.layoutOptions, 2);
  assert.equal(mock.encoders.get('0,0,0'), 0xab);
  assert.deepEqual(Array.from(mock.macroBuffer.subarray(0, 6)), [0, 0, 0x6f, 0x6b, 0, 0]);
  assert.deepEqual(mock.custom.get('22,1')[0], 200);
  assert.deepEqual(mock.custom.get('22,4'), [10, 20]);
  assert.deepEqual(mock.saved, [22]);
  // 순서: 레이아웃 옵션 → 키 → 인코더 → 매크로 → 설정 값 → 저장 명령
  const order = [...new Set(mock.log.map((l) => l[0]))];
  assert.deepEqual(order, [CMD.SET_KEYBOARD_VALUE, CMD.SET_KEYCODE, CMD.SET_ENCODER, CMD.MACRO_SET_BUFFER, CMD.CUSTOM_SET, CMD.CUSTOM_SAVE]);
});

test('a session refuses mismatched definitions, old protocols and keys it could not write', async () => {
  const dev = new ViaDevice([board({ productId: 0x1111 })]);
  await dev.open();
  assert.throws(() => new ViaSession(dev, RAW), /다른 키보드/);
  const { s } = await session({ protocol: 11 });
  assert.equal(s.editable, false);
  assert.throws(() => s.setKeycode(0, 0, 0, 5), /프로토콜 11/);
  const { mock, s: s2 } = await session();
  mock.sendReport = ((send) => (id, data) => { if (data[0] === CMD.SET_KEYCODE) data = data.slice(0, 32).fill(0, 4, 6); return send(id, data); })(mock.sendReport.bind(mock));
  s2.setKeycode(0, 0, 1, 0x29);
  await assert.rejects(() => s2.save(), /그대로 기록되지/);
  assert.equal(s2.isDirty(), true);
});

test('backups round-trip into the staged edit and reject other keyboards', async () => {
  const { s } = await session();
  s.setKeycode(0, 1, 1, 0x2c);
  s.setMacro(0, [{ kind: 'delay', ms: 30 }, { kind: 'text', text: 'a' }]);
  await s.save();
  const backup = JSON.parse(JSON.stringify(s.exportBackup()));
  const { s: fresh } = await session();
  fresh.importBackup(backup);
  assert.deepEqual(fresh.changes().map((c) => c.kind), ['key', 'macro']);
  assert.deepEqual(fresh.macro(0).steps, [{ kind: 'delay', ms: 30 }, { kind: 'text', text: 'a' }]);
  assert.throws(() => fresh.importBackup({ ...backup, productId: 1 }), /다른 키보드/);
  assert.throws(() => fresh.importBackup({ ...backup, keymap: [1] }), /키맵/);
  assert.throws(() => fresh.importBackup({ type: 'x' }), /백업 파일이 아닙니다/);
});

test('the bundled QK80 MK2 definition parses and matches its keyboard', () => {
  const json = JSON.parse(readFileSync(new URL('../definitions/qwertykeys/1363889410.json', import.meta.url), 'utf8'));
  const def = D.parseDefinition(json);
  assert.deepEqual([def.name, def.vendorId, def.productId, def.rows, def.cols], ['QK80 MK2', 0x514b, 0x4d02, capture.rows, capture.cols]);
  assert.equal(D.visibleKeys(def, D.decodeLayoutOptions(0, def.options)).length, 86);
  assert.deepEqual(def.menus.sections.map((x) => x.label), ['Lighting', 'Config']);
  assert.deepEqual(def.menus.unsupported, []);
  assert.ok(def.menus.items.find((i) => i.id === 'id_cp_connect_mode').danger);
  assert.ok(def.menus.items.find((i) => i.id === 'id_cp_eeprom_reset').action);
  // 실기기에서 읽은 메뉴 값이 모두 정의 파일의 항목과 짝이 맞는다
  const heads = new Set(def.menus.items.map((i) => i.head.slice(0, 2).join(',')));
  assert.ok(Object.keys(capture.custom).every((k) => heads.has(k)));
});

test('the combination builder makes modifier, mod-tap and layer-tap codes', () => {
  assert.equal(K.withMods(1, false, 0x06), 0x0106); // Ctrl+C
  assert.equal(K.withMods(3, true, 0x04), 0x1304); // RCtrl+RShift+A
  assert.equal(K.modTap(2, false, 0x29), 0x2229); // LSFT_T(KC_ESC)
  assert.equal(K.layerTap(1, 0x2c), 0x412c); // LT(1, KC_SPC)
  assert.equal(K.withMods(0, false, 0x06), null);
  assert.equal(K.modTap(1, false, 0x5221), null);
  assert.equal(K.layerTap(16, 0x04), null);
  assert.deepEqual(K.splitCombo(0x412c), { kind: 'lt', mods: 0, right: false, layer: 1, kc: 0x2c });
  assert.deepEqual(K.splitCombo(0x3304), { kind: 'mt', mods: 3, right: true, layer: 0, kc: 0x04 });
  assert.equal(K.splitCombo(0x5221), null);
});

test('VIA layout file key names follow the VIA app', () => {
  const names = {
    0x29: 'KC_ESC', 0x47: 'KC_SLCK', 0xcd: 'KC_MS_UP', 0xd1: 'KC_MS_BTN1', 0x7c00: 'RESET', 0x0306: 'LCTL(LSFT(KC_C))', 0x1206: 'RSFT(KC_C)',
    0x2329: 'MT(MOD_LCTL | MOD_LSFT,KC_ESC)', 0x412c: 'LT(1,KC_SPC)', 0x5022: 'LM(1,MOD_LSFT)', 0x52a2: 'OSM(MOD_LSFT)',
    0x5221: 'MO(1)', 0x7700: 'MACRO(0)', 0x7e03: 'CUSTOM(3)', 0x7820: 'RGB_TOG', 0x6000: '0x6000',
  };
  for (const [code, name] of Object.entries(names)) {
    assert.equal(F.viaKeyName(+code), name);
    assert.equal(F.parseViaKey(name), +code, name);
  }
  // VIA가 쓰는 다른 표기들
  const more = { 'C(KC_C)': 0x0106, 'S(KC_1)': 0x021e, KC_TILD: 0x0235, 'MEH(KC_A)': 0x0704, 'RCS(KC_A)': 0x1304, MACRO05: 0x7705, USER01: 0x7e01,
    SPC_FN1: 0x412c, UG_TOGG: 0x7820, RM_TOGG: 0x7842, KC_GESC: 0x7c16, 'kc_a': 0x04, KC_ESCAPE: 0x29 };
  for (const [name, code] of Object.entries(more)) assert.equal(F.parseViaKey(name), code, name);
  assert.equal(F.parseViaKey('LCTL(RSFT(KC_A))'), null);
  assert.equal(F.parseViaKey('NOT_A_KEY'), null);
  // 실기기 키맵의 모든 코드가 VIA 이름으로 갔다가 그대로 돌아온다
  for (const code of new Set(captureKeymap)) assert.equal(F.parseViaKey(F.viaKeyName(code)), code, F.viaKeyName(code));
});

test('VIA macro expressions convert to and from macro steps', () => {
  const steps = [
    { kind: 'text', text: 'Hi {x}' }, { kind: 'key', down: true, mods: 0x01, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x06 },
    { kind: 'key', down: false, mods: 0, usage: 0x06 }, { kind: 'key', down: false, mods: 0x01, usage: 0 }, { kind: 'delay', ms: 250 },
  ];
  const text = F.stepsToExpression(steps);
  assert.equal(text, 'Hi \\{x}{+KC_LCTL}{KC_C}{-KC_LCTL}{250}');
  assert.deepEqual(F.expressionToSteps(text), steps);
  // 동시 입력은 차례로 누르고 거꾸로 뗀다
  assert.deepEqual(F.expressionToSteps('{KC_LCTL,KC_C}'), [
    { kind: 'key', down: true, mods: 0x01, usage: 0 }, { kind: 'key', down: true, mods: 0, usage: 0x06 },
    { kind: 'key', down: false, mods: 0, usage: 0x06 }, { kind: 'key', down: false, mods: 0x01, usage: 0 },
  ]);
  assert.deepEqual(F.expressionToSteps(''), []);
  assert.throws(() => F.expressionToSteps('{MO(1)}'), /MO\(1\)/);
});

test('VIA layout files export the saved state and import into the staged edit', async () => {
  const { s } = await session({ encoders: { '0,0,0': 0xaa, '0,0,1': 0xa9 } });
  s.setMacro(1, [{ kind: 'text', text: 'ok' }]);
  await s.save();
  const file = JSON.parse(JSON.stringify(F.exportViaLayout(s)));
  assert.equal(file.vendorProductId, 1363889410);
  assert.equal(file.layers.length, 2);
  assert.equal(file.layers[0].length, 6);
  assert.deepEqual(file.encoders, [[['KC_VOLD', 'KC_VOLU'], ['KC_NO', 'KC_NO']]]);
  assert.deepEqual(file.macros, ['', 'ok', '', '']);
  file.layers[1][4] = 'LT(1,KC_SPC)';
  file.encoders[0][0][1] = 'KC_MUTE';
  file.macros[0] = '{KC_A}';
  F.importViaLayout(s, file);
  assert.deepEqual(s.changes().map((c) => c.kind), ['key', 'encoder', 'macro']);
  assert.equal(s.keycode(1, 1, 1), 0x412c);
  s.revert();
  // 맞지 않는 파일은 편집본을 바꾸지 않는다
  assert.throws(() => F.importViaLayout(s, { ...file, vendorProductId: 1 }), /다른 키보드/);
  assert.throws(() => F.importViaLayout(s, { ...file, layers: [['KC_A']] }), /키 수/);
  assert.throws(() => F.importViaLayout(s, { ...file, layers: [file.layers[0].map(() => 'WHAT')] }), /WHAT/);
  assert.throws(() => F.importViaLayout(s, { ...file, macros: ['x'.repeat(80), '', '', ''] }), /저장 공간/);
  assert.equal(s.isDirty(), false);
});
