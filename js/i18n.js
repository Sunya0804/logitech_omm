// 화면 문구 번역. 코드에는 한국어 원문을 그대로 쓰고, 영어일 때 i18n-en.js의 표에서 바꿔 보여 준다.
// 원문의 {이름} 자리는 vars 값으로 채운다. 표에 없는 문구는 원문 그대로 나온다(tests/i18n.test.mjs가 빠진 문구를 찾는다).
import EN from './i18n-en.js';

const STORAGE_KEY = 'gomm-lang';
export const LANGS = [['ko', '한국어'], ['en', 'English']]; // i18n-ignore: 언어 이름은 그 언어로 보여 준다
const listeners = new Set();

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.some(([id]) => id === saved)) return saved;
  } catch { /* 저장소를 쓸 수 없는 환경 */ }
  const preferred = globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'ko';
  return preferred.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

let lang = detect();

export const getLang = () => lang;

export function t(text, vars) {
  let s = lang === 'en' ? (EN[text] ?? text) : text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
  return s;
}

// 숫자 표기(천 단위 구분)를 화면 언어에 맞춘다.
export const num = (n) => Number(n).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US');

// HTML에 직접 쓴 문구: data-i18n(글자), data-i18n-attr="속성 이름"(그 속성의 값)을 원문 기준으로 바꾼다.
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.dataset.i18nSource ??= el.textContent.trim();
    el.textContent = t(el.dataset.i18nSource);
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const attr of el.dataset.i18nAttr.split(/\s+/)) {
      const key = `i18nSource${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`;
      el.dataset[key] ??= el.getAttribute(attr) || '';
      el.setAttribute(attr, t(el.dataset[key]));
    }
  }
  document.documentElement.lang = lang;
  document.title = t('GOMM — Global Onboard Memory Manager');
}

export function setLang(next) {
  if (next === lang || !LANGS.some(([id]) => id === next)) return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 저장하지 못해도 이번 화면에는 적용된다 */ }
  if (globalThis.document) translateDom(); // Node 시험에서는 화면이 없다
  for (const fn of listeners) fn(lang);
}

export const onLangChange = (fn) => listeners.add(fn);
