// ATK(compx.js) 온보드 매크로의 해석과 기록. ATK V3 HUB(v3-hub.atk.store)의 동작을 보고 정리했다. 코드는 가져오지 않았다.
// 프로필마다 매크로 칸 12개가 0x0300부터 384바이트 간격으로 있다(설정과 같이 지금 프로필의 것이 읽힌다).
// 칸의 앞 31바이트는 HUB가 늘 같은 값으로 쓰는 머리이고, 이어서 이벤트 수(1~70), 5바이트 이벤트들,
// 검사 바이트(0x55 - 이벤트 수와 이벤트 바이트의 합)가 온다. 이벤트 수가 0이거나 70을 넘으면 빈 칸이다.
// 이벤트 [상태, 값 1, 값 2, 대기 상위, 대기 하위]: 상태의 비트 7은 누름, 비트 6은 뗌이고 둘 다 없으면 휠이다.
// 하위 3비트는 종류다 (0 수정자: 값 1이 수정자 비트, 1 일반 키: 값 1이 HID 키 번호, 2 미디어, 3 전원, 4 마우스: 값 1이 버튼 비트, 5 이동, 6 휠).
// 대기는 그 이벤트 뒤에 기다리는 ms이고 HUB는 1 이상으로 쓴다.
// 버튼 기록은 [6, 칸 번호, 반복 방식]이다. 반복 방식: 1~252 그 횟수만큼, 253 다시 누를 때까지, 254 누르는 동안, 255 아무 키나 누를 때까지.
// 이 프로젝트에서 실기기로 확인한 적은 없다.
import { t } from './i18n.js';

const BASE = 0x0300;
const SLOT_LENGTH = 384;
const SLOT_COUNT = 12;
const HEADER = [8, ...Array(8).fill(2), ...Array(22).fill(0xff)];
const COUNT_OFFSET = HEADER.length;
const MAX_EVENTS = 70;
const MAX_DELAY_MS = 0xffff;
const KEY_CLASS = 6;
const REPEAT = { ONCE: 1, MAX_TIMES: 252, UNTIL_PRESSED_AGAIN: 253, WHILE_HELD: 254, UNTIL_ANY_KEY: 255 };
const TYPE = { MODIFIER: 0, KEY: 1, MOUSE: 4 };
const DOWN = 0x80;
const UP = 0x40;

const slotAddress = (slot) => BASE + SLOT_LENGTH * slot;
const check = (bytes) => (0x55 - bytes.reduce((a, b) => a + b, 0)) & 0xff;

// 버튼 기록이 매크로면 칸 번호, 아니면 null
const keySlot = (key) => (key.cls === KEY_CLASS ? key.param >> 8 : null);
const keyRepeat = (key) => key.param & 0xff;
const keyParam = (slot, repeat) => (slot << 8) | repeat;

// 칸의 이벤트 수부터 읽은 바이트를 단계로 바꾼다. 화면에서 다룰 수 없는 이벤트는 kind 'other'로 원래 3바이트를 남기고,
// 그대로 다시 기록한다. 1 ms 이하의 대기는 단계로 보이지 않는다 (기록할 때 다시 1 ms가 된다).
function decodeSlot(body) {
  const count = body[0];
  if (!count || count > MAX_EVENTS) return { steps: [], empty: true, error: null, editable: true };
  const end = 1 + 5 * count;
  if (body.length < end + 1) return { steps: [], empty: false, error: 'short', editable: false };
  if (check(Array.from(body.subarray(0, end))) !== body[end]) return { steps: [], empty: false, error: 'checksum', editable: false };
  const steps = [];
  for (let o = 1; o < end; o += 5) {
    const [status, v1, v2] = body.subarray(o, o + 3);
    const ms = (body[o + 3] << 8) | body[o + 4];
    const type = status & 0x07;
    const down = status & DOWN ? true : status & UP ? false : null;
    if (down !== null && type === TYPE.MODIFIER && v1) steps.push({ kind: 'key', down, mods: v1, usage: 0 });
    else if (down !== null && type === TYPE.KEY && v1) steps.push({ kind: 'key', down, mods: 0, usage: v1 });
    else if (down !== null && type === TYPE.MOUSE && v1) steps.push({ kind: 'mouse', down, mask: v1 });
    else steps.push({ kind: 'other', bytes: [status, v1, v2] });
    if (ms > 1) steps.push({ kind: 'delay', ms });
  }
  return { steps, empty: false, error: null, editable: true };
}

function eventBytes(s) {
  const state = s.down ? DOWN : UP;
  if (s.kind === 'key' && s.mods && !s.usage && s.mods <= 0xff) return [state | TYPE.MODIFIER, s.mods, 0];
  if (s.kind === 'key' && s.usage && !s.mods && s.usage <= 0xff) return [state | TYPE.KEY, s.usage, 0];
  if (s.kind === 'mouse' && s.mask && s.mask <= 0xff) return [state | TYPE.MOUSE, s.mask, 0];
  if (s.kind === 'other' && s.bytes.length === 3) return s.bytes;
  throw new Error('기록할 수 없는 매크로 단계입니다.');
}

// 이벤트가 몇 개가 되는지 (대기는 앞 이벤트에 붙으므로 세지 않는다)
const eventCount = (steps) => steps.filter((s) => s.kind !== 'delay').length;

// 단계들을 칸 하나(머리부터 검사 바이트까지)로 만든다. 대기는 바로 앞 이벤트의 대기에 더하고, 첫 이벤트 앞의 대기는 버린다.
function encodeSlot(steps) {
  const events = [];
  for (const s of steps) {
    if (s.kind === 'delay') {
      if (events.length) events[events.length - 1].ms += s.ms;
      continue;
    }
    events.push({ bytes: eventBytes(s), ms: 0 });
  }
  if (!events.length) throw new Error('매크로에 단계가 없습니다.');
  if (events.length > MAX_EVENTS) throw new Error('매크로가 너무 깁니다.');
  const body = [events.length];
  for (const e of events) {
    const ms = Math.min(MAX_DELAY_MS, Math.max(1, Math.round(e.ms)));
    body.push(...e.bytes, ms >> 8, ms & 0xff);
  }
  body.push(check(body));
  return Uint8Array.from([...HEADER, ...body]);
}

// 기기에서 칸을 읽는다: 이벤트 수 1바이트를 먼저 읽고, 매크로가 있으면 나머지를 읽는다. 돌려주는 값은 이벤트 수부터의 바이트다.
async function readSlot(dev, slot) {
  const address = slotAddress(slot) + COUNT_OFFSET;
  const [count] = await dev.readFlash(address, 1);
  if (!count || count > MAX_EVENTS) return Uint8Array.of(count);
  return dev.readFlash(address, 2 + 5 * count);
}

// 칸을 기록하고 다시 읽어 대조한다. 대조한 바이트(이벤트 수부터)를 돌려준다.
async function writeSlot(dev, slot, steps) {
  const data = encodeSlot(steps);
  await dev.writeFlash(slotAddress(slot), data);
  const back = await readSlot(dev, slot);
  const want = data.subarray(COUNT_OFFSET);
  if (back.length !== want.length || back.some((b, i) => b !== want[i])) throw new Error(t('매크로가 기기에 그대로 기록되지 않았습니다.'));
  return back;
}

export {
  SLOT_COUNT, MAX_EVENTS, KEY_CLASS, REPEAT, COUNT_OFFSET, slotAddress, keySlot, keyRepeat, keyParam,
  decodeSlot, encodeSlot, eventCount, readSlot, writeSlot,
};
