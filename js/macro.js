// Logitech 온보드 매크로(HID++ 0x8100, 매크로 형식 1)의 해석과 기록.
// 버튼 할당 [0x00, 섹터, 0x00, 위치]가 매크로의 시작점을 가리키고, 매크로는 그 섹터 안의 3바이트(일부 1·2·5바이트)
// 명령들의 나열이다. 명령 번호와 길이는 libratbag(hidpp20.h)에 공개된 사실 정보를 따랐다. 코드는 가져오지 않았다.
// 이 프로젝트에서 실기기로 확인한 적은 없다. OpenMouse는 할당을 [0x00, 버튼, 섹터, 0x00]으로 쓰고 있어 서로 다르다.
import { finalize } from './profile.js';
import { CODE_TO_USAGE } from './keys.js';

const OP = {
  NOOP: 0x00, WAIT_RELEASE: 0x01, REPEAT_WHILE_PRESSED: 0x02, REPEAT_UNTIL_CANCELED: 0x03,
  ROLLER: 0x20, ACPAN: 0x21,
  DELAY: 0x40, BUTTON_DOWN: 0x41, BUTTON_UP: 0x42, KEY_DOWN: 0x43, KEY_UP: 0x44, CONSUMER_DOWN: 0x45, CONSUMER_UP: 0x46,
  JUMP: 0x60, XY: 0x61, END: 0xff,
};
const LENGTH = { 0x00: 1, 0x01: 1, 0x02: 1, 0x03: 1, 0x20: 2, 0x21: 2, 0x40: 3, 0x41: 3, 0x42: 3, 0x43: 3, 0x44: 3, 0x45: 3, 0x46: 3, 0x60: 3, 0x61: 5 };
const MAX_STEPS = 1024; // 점프가 순환해도 멈추도록
const MAX_DELAY_MS = 0xffff;
// 수정자 키 → 수정자 비트 (오른쪽 키는 << 4)
const MODIFIER_BITS = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
};

// 버튼 할당 4바이트가 매크로면 {sector, offset}, 아니면 null
function macroTarget(binding) {
  return binding[0] === 0x00 ? { sector: binding[1], offset: binding[3] } : null;
}
const macroBinding = (sector, offset = 0) => [0x00, sector, 0x00, offset];

// 명령 하나를 단계로 바꾼다. 화면에서 편집할 수 없는 명령은 kind 'other'로 원래 바이트를 남긴다.
function stepFrom(b) {
  const u16 = (b[1] << 8) | b[2];
  switch (b[0]) {
    case OP.DELAY: return { kind: 'delay', ms: u16 };
    case OP.KEY_DOWN: case OP.KEY_UP: return { kind: 'key', down: b[0] === OP.KEY_DOWN, mods: b[1], usage: b[2] };
    case OP.BUTTON_DOWN: case OP.BUTTON_UP: return { kind: 'mouse', down: b[0] === OP.BUTTON_DOWN, mask: u16 };
    case OP.CONSUMER_DOWN: case OP.CONSUMER_UP: return { kind: 'consumer', down: b[0] === OP.CONSUMER_DOWN, usage: u16 };
  }
  return { kind: 'other', bytes: Array.from(b) };
}

function stepBytes(s) {
  switch (s.kind) {
    case 'delay': return [OP.DELAY, s.ms >> 8, s.ms & 0xff];
    case 'key': return [s.down ? OP.KEY_DOWN : OP.KEY_UP, s.mods & 0xff, s.usage & 0xff];
    case 'mouse': return [s.down ? OP.BUTTON_DOWN : OP.BUTTON_UP, s.mask >> 8, s.mask & 0xff];
    case 'consumer': return [s.down ? OP.CONSUMER_DOWN : OP.CONSUMER_UP, s.usage >> 8, s.usage & 0xff];
  }
  throw new Error('기록할 수 없는 매크로 단계입니다.');
}

// 매크로를 읽는다. sectorAt(n)은 섹터 n의 바이트(없으면 null)를 돌려준다. 끝 표시를 만나기 전에 섹터 끝(CRC 앞)에
// 닿거나 모르는 명령이 나오면 error를 채운다. editable은 화면에서 그대로 다시 기록할 수 있는 단계들뿐인지다.
function readMacro(sectorAt, start, sectorSize) {
  const steps = [];
  const sectors = [];
  let { sector, offset } = start;
  let data = sectorAt(sector);
  if (data) sectors.push(sector);
  for (let guard = 0; data && guard < MAX_STEPS; guard++) {
    const op = data[offset];
    if (op === OP.END) return { steps, sectors, error: null, editable: steps.every((s) => s.kind !== 'other') };
    const len = LENGTH[op];
    if (!len) return { steps, sectors, error: 'unknown', editable: false };
    if (offset + len > sectorSize - 2) return { steps, sectors, error: 'overrun', editable: false };
    const b = data.subarray(offset, offset + len);
    if (op === OP.JUMP) {
      ({ sector, offset } = { sector: b[2], offset: b[1] });
      data = sectorAt(sector);
      if (data && !sectors.includes(sector)) sectors.push(sector);
      continue;
    }
    steps.push(stepFrom(b));
    offset += len;
  }
  // unreadable이면 missing은 아직 읽지 않은(또는 읽지 못한) 섹터 번호다.
  return { steps, sectors, error: data ? 'loop' : 'unreadable', editable: false, missing: data ? null : sector };
}

// 한 섹터에 담을 수 있는 단계 수 (끝 표시 1바이트와 CRC 2바이트를 뺀다)
const capacity = (sectorSize) => Math.floor((sectorSize - 3) / 3);

// 단계들을 한 섹터에 담는다. 남는 자리는 0xFF이고 마지막 2바이트는 CRC다.
function encodeMacro(steps, sectorSize) {
  if (!steps.length) throw new Error('매크로에 단계가 없습니다.');
  if (steps.length > capacity(sectorSize)) throw new Error('매크로가 너무 깁니다.');
  const out = new Uint8Array(sectorSize).fill(0xff);
  steps.forEach((s, i) => out.set(stepBytes(s), 3 * i));
  out[3 * steps.length] = OP.END;
  return finalize(out);
}

// 키보드 녹화 결과 [{code, down, time}]를 단계로 바꾼다. 눌림 사이의 시간은 지연 단계로 넣는다.
// 수정자 키는 수정자 비트만 담은 키 단계가 된다. 매크로에 넣을 수 없는 키는 건너뛰고 그 code를 skipped에 모은다.
// 녹화 전부터 누르고 있던 키의 뗌은 버리고, 녹화가 끝날 때까지 떼지 않은 키는 끝에 뗌을 붙여 키가 눌린 채 남지 않게 한다.
function stepsFromKeys(events) {
  const steps = [];
  const skipped = new Set();
  const held = new Set();
  let last = null;
  const push = (code, down, time) => {
    const mod = MODIFIER_BITS[code];
    if (time !== null && last !== null) {
      const ms = Math.min(MAX_DELAY_MS, Math.max(0, Math.round(time - last)));
      if (ms > 0) steps.push({ kind: 'delay', ms });
    }
    if (time !== null) last = time;
    steps.push({ kind: 'key', down, mods: mod || 0, usage: mod ? 0 : CODE_TO_USAGE[code] });
  };
  for (const e of events) {
    if (!MODIFIER_BITS[e.code] && !CODE_TO_USAGE[e.code]) { skipped.add(e.code); continue; }
    if (e.down ? held.has(e.code) : !held.has(e.code)) continue; // 자동 반복, 녹화 전부터 누른 키
    if (e.down) held.add(e.code); else held.delete(e.code);
    push(e.code, e.down, e.time);
  }
  for (const code of [...held].reverse()) push(code, false, null);
  return { steps, skipped: [...skipped] };
}

// 누름과 뗌을 한 쌍으로 넣는 마우스 클릭
const mouseClick = (mask) => [{ kind: 'mouse', down: true, mask }, { kind: 'mouse', down: false, mask }];

export { OP, MAX_DELAY_MS, macroTarget, macroBinding, readMacro, encodeMacro, capacity, stepsFromKeys, mouseClick };
