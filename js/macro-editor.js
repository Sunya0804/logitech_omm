// 매크로 편집 칸: 단계 목록과 녹화·대기·마우스 클릭 추가. Logitech(logitech-ui.js)과 ATK(compx-ui.js)가 함께 쓴다.
// 단계의 모양은 js/macro.js와 같다: delay{ms}, key{down, mods, usage}, mouse{down, mask}, consumer{down, usage}, other{bytes}.
import * as K from './keys.js';
import { stepsFromKeys, mouseClick, MAX_DELAY_MS } from './macro.js';
import { t, num } from './i18n.js';
import { h, toast } from './ui.js';

const DELAY_STEP_MS = 50; // 「+ 대기」로 넣는 기본 대기
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// 화면에 녹화는 하나뿐이다.
let recording = null;

function stopRecording() {
  const rec = recording;
  if (!rec) return null;
  window.removeEventListener('keydown', rec.listener, true);
  window.removeEventListener('keyup', rec.listener, true);
  window.removeEventListener('blur', rec.stop);
  recording = null;
  return rec;
}

// 매크로 단계의 이름과 한 줄 설명
function stepName(s) {
  switch (s.kind) {
    case 'key': return K.keyName(s.mods, s.usage);
    case 'mouse': return K.describe({ kind: 'mouse', mask: s.mask });
    case 'consumer': return K.describe({ kind: 'consumer', usage: s.usage });
    case 'delay': return t('{ms} ms 대기', { ms: num(s.ms) });
  }
  return t('기타 명령 ({bytes})', { bytes: toHex(s.bytes) });
}
const stepText = (s) => (s.kind === 'key' || s.kind === 'mouse' || s.kind === 'consumer' ? `${s.down ? '↓' : '↑'} ${stepName(s)}` : stepName(s));

// m: {steps, error, pending}
function macroSummary(m) {
  if (m.error && !m.steps.length) return t('매크로 (읽을 수 없음)');
  const names = m.steps.filter((s) => s.kind !== 'delay' && s.down !== false).map(stepName);
  const keys = names.length ? names.slice(0, 4).join(' → ') + (names.length > 4 ? ' …' : '') : t('비어 있음');
  return t('매크로: {keys}', { keys }) + (m.pending ? ' ' + t('(저장 전)') : '');
}

// o.title: 제목, o.current(): 지금 매크로 {steps, editable} 또는 null, o.max: 최대 단계 수, o.readOnly,
// o.minDelay: 대기의 최솟값(ms), o.onChange(steps): 바뀐 단계들, o.onClose(), o.rerender(): 편집 칸을 다시 그린다,
// o.size(steps): 차지하는 칸 수(없으면 단계 수), o.extra: 머리 아래에 넣을 요소(반복 방식 등), o.notice: 표시할 수 없는 명령이 있을 때의 안내.
function macroEditor(o) {
  const minDelay = o.minDelay || 0;
  const now = () => { const m = o.current(); return m && m.editable ? m.steps : []; };
  const m = o.current();
  const steps = now();
  const rec = recording;
  const { max } = o;
  const size = o.size || ((list) => list.length);
  const delay = { kind: 'delay', ms: DELAY_STEP_MS };

  const startRecording = () => {
    const events = [];
    const listener = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      events.push({ code: e.code, down: e.type === 'keydown', time: e.timeStamp });
      const btn = document.getElementById('macro-record');
      if (btn) btn.textContent = t('녹화 중지 ({n})', { n: events.length });
    };
    const stop = () => {
      if (!stopRecording()) return;
      const { steps: added, skipped } = stepsFromKeys(events);
      if (skipped.length) toast(t('매크로에 넣을 수 없는 키는 뺐습니다: {keys}', { keys: skipped.join(', ') }), 'error');
      const next = [...now(), ...added];
      if (size(next) > max) {
        toast(t('매크로가 너무 깁니다 (최대 {max}단계).', { max }), 'error');
        return o.rerender();
      }
      if (added.length) o.onChange(next);
      else o.rerender();
    };
    recording = { listener, stop, events };
    window.addEventListener('keydown', listener, true);
    window.addEventListener('keyup', listener, true);
    window.addEventListener('blur', stop);
    o.rerender();
    document.getElementById('macro-record')?.focus();
  };

  const busyRec = o.readOnly || !!rec;
  return h('section', { class: 'macro-editor', 'aria-label': o.title },
    h('div', { class: 'macro-head' },
      h('h3', null, o.title),
      h('span', { class: 'hint' }, t('{n} / {max}단계', { n: size(steps), max }))),
    o.extra,
    m && !m.editable && h('p', { class: 'notice' }, o.notice),
    steps.length
      ? h('ol', { class: 'macro-steps' }, steps.map((s, n) => h('li', null,
        s.kind === 'delay'
          ? h('label', null, h('input', {
            type: 'number', min: minDelay, max: MAX_DELAY_MS, step: 10, value: s.ms, disabled: busyRec,
            'aria-label': t('{n}번째 단계 대기 시간', { n: n + 1 }),
            onchange: (e) => {
              const ms = Math.min(MAX_DELAY_MS, Math.max(minDelay, Math.round(Number(e.target.value) || 0)));
              o.onChange(steps.map((x, k) => (k === n ? { ...x, ms } : x)));
            },
          }), ' ' + t('ms 대기'))
          : h('span', null, stepText(s)),
        h('button', { class: 'ghost', disabled: busyRec, 'aria-label': t('{n}번째 단계 삭제', { n: n + 1 }), onclick: () => o.onChange(steps.filter((_, k) => k !== n)) }, '✕'))))
      : h('p', { class: 'empty' }, t('단계가 없습니다. 「녹화」를 누르고 키보드로 입력하세요.')),
    h('div', { class: 'row-actions' },
      h('button', { id: 'macro-record', class: rec ? 'primary' : '', disabled: o.readOnly, onclick: rec ? rec.stop : startRecording },
        rec ? t('녹화 중지 ({n})', { n: rec.events.length }) : t('녹화')),
      h('button', { disabled: busyRec || size([...steps, delay]) > max, onclick: () => o.onChange([...steps, delay]) }, t('+ 대기')),
      h('select', {
        disabled: busyRec || size([...steps, ...mouseClick(1)]) > max, 'aria-label': t('마우스 클릭 추가'),
        onchange: (e) => { if (e.target.value !== '') o.onChange([...steps, ...mouseClick(1 << Number(e.target.value))]); },
      }, h('option', { value: '' }, t('+ 마우스 클릭')), [0, 1, 2, 3, 4].map((b) => h('option', { value: b }, K.mouseButtonName(b)))),
      h('button', { class: 'ghost', disabled: busyRec || !steps.length, onclick: () => o.onChange([]) }, t('모두 지우기')),
      h('button', { class: 'ghost', onclick: () => { stopRecording(); o.onClose(); } }, t('닫기'))),
    h('p', { class: 'hint' }, t('녹화하는 동안 키보드 입력은 매크로에만 기록되고 다른 곳에 전달되지 않습니다. 키 사이의 시간도 대기로 기록됩니다.')
      + ' ' + t('매크로 기록은 아직 실제 기기로 확인하지 않았습니다.')));
}

export { stopRecording, stepName, stepText, macroSummary, macroEditor };
