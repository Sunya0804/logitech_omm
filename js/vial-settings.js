// Vial의 QMK 설정 항목. 번호(qsid)·바이트 수·비트·범위는 Vial 펌웨어가 정한 값이고, 이름은 이 앱에서 새로 붙였다.
// 키보드는 지원하는 번호만 알려 주므로(qmkSettingsList) 그 번호의 항목만 보여 준다.
// width: 값의 바이트 수(작은 쪽이 앞), bit: 한 값 안의 켜고 끄는 비트. bit가 없는 켜기/끄기는 값 0·1이다.
const SETTINGS = [
  { id: 'magic', label: '키 바꾸기', fields: [
    ...[
      'Caps Lock과 왼쪽 Ctrl 맞바꾸기', 'Caps Lock을 Ctrl로 쓰기', '왼쪽 Alt와 GUI 맞바꾸기', '오른쪽 Alt와 GUI 맞바꾸기', 'GUI(Windows) 키 끄기',
      '` 와 Esc 맞바꾸기', 'Backslash와 Backspace 맞바꾸기', 'N키 롤오버 켜기', '왼쪽 Ctrl과 GUI 맞바꾸기', '오른쪽 Ctrl과 GUI 맞바꾸기',
    ].map((label, bit) => ({ qsid: 21, width: 4, bit, label })),
  ] },
  { id: 'grave', label: 'Grave Escape', fields: [
    'Alt를 누르고 있으면 늘 Esc', 'Ctrl을 누르고 있으면 늘 Esc', 'GUI를 누르고 있으면 늘 Esc', 'Shift를 누르고 있으면 늘 Esc',
  ].map((label, bit) => ({ qsid: 1, width: 1, bit, label })) },
  { id: 'taphold', label: '탭·홀드', fields: [
    { qsid: 7, width: 2, min: 0, max: 10000, label: '탭 판정 시간 (ms)' },
    { qsid: 8, width: 1, bit: 0, label: 'Permissive Hold' },
    { qsid: 8, width: 1, bit: 1, label: '모드 탭 중간 입력 무시' },
    { qsid: 8, width: 1, bit: 2, label: 'Tapping Force Hold' },
    { qsid: 8, width: 1, bit: 3, label: 'Retro Tapping' },
    { qsid: 22, width: 1, label: 'Permissive Hold' },
    { qsid: 23, width: 1, label: '다른 키를 누르면 홀드로 판정' },
    { qsid: 24, width: 1, label: 'Retro Tapping' },
    { qsid: 25, width: 2, min: 0, max: 10000, label: '빠른 탭 판정 시간 (ms)' },
    { qsid: 18, width: 2, min: 0, max: 1000, label: '탭 입력 지연 (ms)' },
    { qsid: 19, width: 2, min: 0, max: 1000, label: 'Caps Lock 탭 홀드 지연 (ms)' },
    { qsid: 20, width: 1, min: 0, max: 100, label: '토글까지 탭 횟수' },
    { qsid: 26, width: 1, label: 'Chordal Hold' },
    { qsid: 27, width: 2, min: 0, max: 10000, label: 'Flow Tap (ms)' },
  ] },
  { id: 'autoshift', label: '자동 Shift', fields: [
    { qsid: 3, width: 1, bit: 0, label: '켜기' },
    { qsid: 3, width: 1, bit: 1, label: '수정자 키에도 적용' },
    { qsid: 4, width: 2, min: 0, max: 1000, label: '판정 시간 (ms)' },
    { qsid: 3, width: 1, bit: 2, label: '특수 키는 제외' },
    { qsid: 3, width: 1, bit: 3, label: '숫자 키는 제외' },
    { qsid: 3, width: 1, bit: 4, label: '알파벳 키는 제외' },
    { qsid: 3, width: 1, bit: 5, label: '키 반복 켜기' },
    { qsid: 3, width: 1, bit: 6, label: '판정 시간을 넘기면 키 반복 끄기' },
  ] },
  { id: 'combo', label: '콤보', fields: [{ qsid: 2, width: 2, min: 0, max: 10000, label: '콤보 판정 시간 (ms)' }] },
  { id: 'oneshot', label: '원샷 키', fields: [
    { qsid: 5, width: 1, min: 0, max: 50, label: '이 횟수만큼 탭하면 다시 탭할 때까지 유지' },
    { qsid: 6, width: 2, min: 0, max: 60000, label: '원샷 키가 풀리는 시간 (ms)' },
  ] },
  { id: 'mouse', label: '마우스 키', fields: [
    { qsid: 9, width: 2, min: 0, max: 10000, label: '이동 시작 지연 (ms)' },
    { qsid: 10, width: 2, min: 0, max: 10000, label: '이동 간격 (ms)' },
    { qsid: 11, width: 2, min: 0, max: 1000, label: '한 번에 움직이는 거리' },
    { qsid: 12, width: 2, min: 0, max: 1000, label: '최고 속도' },
    { qsid: 13, width: 2, min: 0, max: 1000, label: '최고 속도까지 걸리는 시간' },
    { qsid: 14, width: 2, min: 0, max: 10000, label: '휠 시작 지연 (ms)' },
    { qsid: 15, width: 2, min: 0, max: 10000, label: '휠 간격 (ms)' },
    { qsid: 16, width: 2, min: 0, max: 1000, label: '휠 한 번의 최대 단계' },
    { qsid: 17, width: 2, min: 0, max: 1000, label: '휠 최고 속도까지 걸리는 시간' },
  ] },
];

// qsid → 바이트 수
const WIDTH = new Map(SETTINGS.flatMap((g) => g.fields.map((f) => [f.qsid, f.width])));

export { SETTINGS, WIDTH };
