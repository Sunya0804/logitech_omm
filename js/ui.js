// 여러 화면이 함께 쓰는 DOM 도우미와 앱 상태.
import { t } from './i18n.js';

export const $ = (sel) => document.querySelector(sel);

// busy: 기기와 통신하는 작업이 진행 중인지, demo: 가상 기기(데모)에 연결돼 있는지
// background: 화면 뒤에서 기기에 묻는 중인 작업(배터리 갱신)의 Promise. busy 작업은 이것이 끝난 뒤 시작한다.
export const app = { busy: false, demo: false, background: null };

// app.js가 채우는 화면 갱신 함수. 각 브랜드 화면은 값을 바꾼 뒤 이것을 부른다.
export const shell = { refresh() {}, refreshActions() {} };

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}

export function ask(title, lines, okLabel) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').replaceChildren(...lines.map((l) => h('p', null, l)));
  $('#confirm-ok').textContent = okLabel;
  dlg.showModal();
  // close 이벤트는 탭이 가려져 있으면 늦게 오므로 버튼 제출과 Esc(cancel)를 직접 받는다.
  return new Promise((resolve) => {
    const form = dlg.querySelector('form');
    const finish = (ok) => {
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('cancel', onCancel);
      // submit은 대화상자가 닫히기 전에 온다. 바로 다음 ask가 연 대화상자를 이 닫기가 닫지 않도록 한 박자 늦춘다.
      setTimeout(() => resolve(ok));
    };
    const onSubmit = (e) => finish(!!e.submitter && e.submitter.value === 'ok');
    const onCancel = () => finish(false);
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('cancel', onCancel);
  });
}

// 기기와 통신하는 작업을 한 번에 하나만 실행하고, 실패하면 알림을 띄운다.
export async function busy(message, fn) {
  if (app.busy) return false;
  app.busy = true;
  const setMsg = (m) => ($('#busy-msg').textContent = m);
  setMsg(message);
  $('#busy').hidden = false;
  // 덮개는 마우스만 막으므로, 키보드로 버튼을 누르지 못하게 화면을 비활성으로 둔다.
  for (const id of ['#rail', '#stage']) $(id).inert = true;
  try {
    await app.background;
    await fn(setMsg);
    return true;
  } catch (e) {
    console.error(e);
    toast(t(e.message || String(e)), 'error');
    return false;
  } finally {
    app.busy = false;
    $('#busy').hidden = true;
    for (const id of ['#rail', '#stage']) $(id).inert = false;
  }
}

export function download(data, suffix, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: `${String(name).replace(/[^\w-]+/g, '_')}-${suffix}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 여러 선택지 중 하나를 고르는 버튼 묶음. options: [[값, 표시]].
export function choice(label, options, current, ro, onPick, extraClass = '') {
  return h('div', { class: 'choice ' + extraClass, role: 'group', 'aria-label': label }, options.map(([v, text]) => h('button', {
    type: 'button', class: v === current ? 'active' : '', disabled: ro, 'aria-pressed': String(v === current),
    onclick: () => { if (v !== current) onPick(v); },
  }, text)));
}

// 설정 화면의 탭 줄. 화살표·Home·End 키로 탭 사이를 옮길 수 있다. items: [[id, 표시]].
export function tabs(items, current, onPick, label) {
  const buttons = items.map(([id, text]) => h('button', {
    type: 'button', role: 'tab', id: `tab-${id}`, class: id === current ? 'active' : '',
    'aria-selected': String(id === current), 'aria-controls': 'tab-panel', tabindex: id === current ? '0' : '-1',
    onclick: () => onPick(id),
  }, text));
  const nav = h('nav', {
    class: 'tabs', role: 'tablist', 'aria-label': label,
    onkeydown: (e) => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = (next + buttons.length) % buttons.length;
      onPick(items[target][0]);
      document.getElementById(`tab-${items[target][0]}`)?.focus();
    },
  }, buttons);
  return nav;
}

// 탭 내용을 담는 칸. tabs()의 aria-controls와 짝을 이룬다.
export const tabPanel = (current, body) => h('div', { class: 'panel', role: 'tabpanel', id: 'tab-panel', 'aria-labelledby': `tab-${current}` }, body);

// 개요 화면의 숫자 칸
export const tile = (label, value, sub) => h('div', { class: 'stat' }, h('small', null, label), h('b', null, value), sub && h('span', null, sub));

// 이름표와 입력 칸 한 줄. 이름표를 입력 칸(또는 버튼 묶음)에 연결해 화면 읽기 프로그램이 함께 읽게 한다.
let fieldSeq = 0;
export function field(label, unit, control) {
  const id = `field-${++fieldSeq}`;
  const labelEl = h('label', { id: `${id}-label` }, label, unit && h('small', null, unit));
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
    control.id ||= id;
    labelEl.htmlFor = control.id;
  } else if (control) {
    control.setAttribute('aria-labelledby', labelEl.id);
  }
  return h('div', { class: 'field' }, labelEl, control);
}
