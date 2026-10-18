# Codex 작업 지시: VIA 키보드 화면 (프런트엔드)

이 문서는 Codex가 GOMM에 VIA(QMK) 키보드 편집 화면을 만들 때 따를 지시문이다.
통신·해석·저장 쪽(백엔드)은 이미 있다. Codex는 **화면과 앱 연결만** 만든다. 백엔드 파일을 고쳐야 하면 먼저 이유를 보고한다.

## 0. 작업 규칙

- 브랜치: `codex/via-support`. 이 브랜치에만 커밋·푸시한다. `main`에는 합치지 않는다(사용자가 실기기 확인 뒤 정한다).
- 커밋 작성자: `Sunya0804 <2001woojin@gmail.com>`.
- 외부 라이브러리를 쓰지 않는다. 지금처럼 정적 ES 모듈 + `js/ui.js`의 `h()`·`tabs()`·`field()`·`tile()`·`busy()`·`ask()`·`toast()`·`download()`를 쓴다.
- 화면 문구는 한국어 원문을 `t('…')`로 쓰고, 같은 커밋에 `js/i18n-en.js`에 영어를 넣는다. 빠지면 `tests/i18n.test.mjs`가 실패한다.
- 주석은 주변 파일처럼 한국어로, 같은 정도로 쓴다. 이름 짓기와 코드 모양도 `compx-ui.js`·`mchose-ui.js`를 따른다.
- 끝나면 `npm test`가 모두 통과해야 한다. 실기기로 확인하지 않은 것은 확인했다고 쓰지 않는다.

## 1. 이미 있는 백엔드

| 파일 | 하는 일 |
|---|---|
| `js/via.js` | `ViaDevice`: raw HID(사용 페이지 0xFF60·용도 0x61) 32바이트 명령. `filters`, `hasViaInterface(device)`. 공장 초기화·부트로더·키맵 초기화 명령은 **일부러 없다**. |
| `js/via-keycodes.js` | 프로토콜 12 키 코드 ↔ 이름. `keycodeName`, `keycodeLabel(code, {customKeycodes})` → `{label, title, danger}`, `parseKeycode(text)`, `keycodeGroups(ctx)`, `isSupportedProtocol`. |
| `js/via-definition.js` | 정의 파일(JSON) 해석. `parseDefinition`, `definitionSources(vid, pid)`, `fetchDefinition`, `rememberDefinition` / `rememberedDefinition` / `forgetDefinition`(브라우저 저장), `visibleKeys`, `evaluateShowIf`. |
| `js/via-macro.js` | 매크로 버퍼 해석·기록. 단계 모양은 `macro-editor.js`와 같고, VIA 전용 `{kind: 'text', text}`가 더 있다. |
| `js/via-session.js` | **화면이 쓰는 유일한 창구.** `new ViaSession(dev, json)` → `await load(setMsg)` → 읽기·편집·`changes()`·`save(setMsg)`·`revert()`·`exportBackup()`·`importBackup(obj)`·`matrixState()`. |
| `js/mock-via.js` | 가상 키보드 `MockViaDevice` (시험·데모용). `log`에 쓰기 명령이 남는다. |
| `tests/via.test.mjs` | 위 모듈의 단위 시험. 동작을 모르겠으면 여기를 먼저 읽는다. |

`ViaSession`의 주요 값:

- `def`: `{name, vendorId, productId, rows, cols, keys, optionKeys, options, width, height, menus: {sections, items, unsupported}, customKeycodes, lighting}`
  - 키 하나: `{row, col, x, y, w, h, r, rx, ry, color: 'alpha'|'mod'|'accent', encoder?, shape?: {x2, y2, w2, h2}}` (단위는 키 1칸 = 1)
  - 메뉴 항목: `{id, label, type: 'range'|'dropdown'|'toggle'|'color'|'keycode', min?, max?, choices?, off?, on?, showIf, action, danger}`
- `protocol`, `editable`(프로토콜 12 이상만 true), `layers`, `macroCount`, `macroBufferSize`, `firmware`
- `keys()`: 지금 레이아웃 옵션으로 보이는 키, `keycode(layer, row, col)`, `encoder(layer, index, cw)`, `label(code)`, `keycodeGroups()`
- `macro(i)` → `{steps, editable, pending}`, `macroBytesUsed()`, `customValue(id)`, `itemVisible(item)`
- 편집: `setKeycode`, `setEncoder`, `setLayoutOption(i, choice)`, `setMacro(i, steps | null)`, `setCustom(id, value)`. 넘치거나 맞지 않으면 **오류를 던지고 바꾸지 않는다** → 화면은 `toast(e.message, 'error')`.
- `changes()` → `[{kind: 'key'|'encoder'|'options'|'macro'|'custom', …, danger?}]`

## 2. 만들 것

### 2-1. `js/via-ui.js` (새 파일)

다른 브랜드 화면과 같은 함수 묶음을 내보낸다. `app.js`가 이 이름들을 부른다.

```
filters, state, connected(), canEdit(), isDirty(), ownsDevice(device), dirtyText?(),
connect(devices, setMsg), disconnect(), refreshBattery() → false (키보드는 배터리 없음),
summary() → {name, modeText, dpi: null, rate: null, profileLabel: null, battery: null},
renderProfiles(root) → false (사이드바 없음; 레이어는 편집 칸 안에서 고른다),
render(root), save(), revert(), exportBackup(), importBackup(file), exportDiagnostics()
```

연결 흐름(`connect`):

1. `new ViaDevice(devices)` → `open()`.
2. 정의 파일 찾기: `rememberedDefinition(vid, pid)` → 없으면 `fetchDefinition(vid, pid)` (usevia.app은 받아 갈 수 있다).
3. 둘 다 없으면 연결은 유지한 채 **정의 파일 불러오기 화면**을 띄운다(아래 2-3). 정의 파일을 받으면 `new ViaSession` → `load` → `rememberDefinition(json)`.
4. 정의 파일이 다른 키보드의 것이면 `ViaSession`이 오류를 던진다 → 불러오기 화면에 오류를 보이고 다시 고르게 한다.

### 2-2. `js/app.js` 연결

- `UIS`에 via-ui를 넣는다.
- `requestConnect`의 `filters`에 `via.filters`를 더한다.
- 고른 기기 나누기: 지금의 마우스 판단(MCHOSE·ATK/VGN·Logitech)을 **먼저** 하고, 어디에도 안 맞고 `picked.some(hasViaInterface)`이면 VIA로 보낸다. 마우스 제조사 ID를 쓰는 VIA 키보드가 있을 수 있으니, 마우스 쪽 판단이 제품 ID까지 보지 않는 곳(Logitech 기본 경로)에서는 VIA 인터페이스가 있는지 먼저 본다.
- 홈 화면 문구("Logitech G, VGN, ATK·MCHOSE …")에 VIA 키보드를 더하고, 데모 버튼 "VIA 키보드"를 추가한다.
- `window.OMM`에 `viaUi`, `connectVia(devices, json?)`를 더한다(시험용).

### 2-3. 정의 파일 불러오기 화면

키보드 연결 뒤 정의 파일이 없을 때 보인다.

- 키보드 이름과 `VID:PID`를 보인다.
- `definitionSources(vid, pid)` 중 `kind: 'link'`인 것(지금은 Qwertykeys)이 있으면:
  - 「정의 파일 받기 ({name})」 링크 → `source.url` (새 탭, `rel="noopener"`). 예: QK80 MK2는 `https://cfg.qwertykeys.com/definitions/v3/1363889410.json`
  - 「제작사 웹 허브 열기」 링크 → `source.page`
  - 안내: "받은 JSON 파일을 아래에서 불러오세요. 한 번 불러오면 이 브라우저가 기억합니다."
- 파일 고르기 버튼과 끌어다 놓기 칸. `.json`만 받는다. `JSON.parse` 실패와 `ViaSession` 오류를 그 자리에 보인다.
- 연결된 상태에서 쓸 「정의 파일 바꾸기」(키보드 탭 위쪽): `forgetDefinition` 후 이 화면으로.
- 정의 파일 내용은 사용자가 준 데이터다. 이름·라벨은 `textContent`로만 넣는다(`innerHTML` 금지).

### 2-4. 편집 화면 탭

`tabs()`로 아래 탭을 만든다. 탭이 바뀌면 키 시험 폴링을 멈춘다.

1. **키맵**
   - 레이어 고르기(0 ~ `layers - 1`).
   - 키보드 그림: 키마다 절대 위치 `left = x * U`, `top = y * U`, `width = w * U - 간격`, 회전은 `transform: rotate(r deg)`, `transform-origin`은 `(rx - x) * U, (ry - y) * U`. `U`는 CSS 변수(`--via-unit`)로 두고, 화면 폭에 맞게 줄인다(모바일 16px 여백, 가로 스크롤 없음; 그림 칸만 `overflow-x: auto` 허용).
   - ISO 엔터처럼 `shape`가 있는 키는 두 사각형으로 그리거나 바깥 사각형만 그려도 된다.
   - 키캡 글자는 `session.label(code).label`(줄바꿈 `\n`은 두 줄로), `title`은 이름. `color`로 alpha/mod/accent 색을 나눈다(기존 색 토큰에서 고른다).
   - `KC_TRNS`(▽)는 흐리게. 저장 전 바뀐 키는 표시(점이나 테두리).
   - 키를 누르면 선택 → 아래 **키 고르기 칸**이 열린다.
   - 인코더 키(`encoder` 있음)는 시계/반시계 두 칸을 따로 고른다.
2. **키 고르기 칸**(키맵 탭 아래)
   - `session.keycodeGroups()`의 묶음을 작은 탭으로, 각 키를 버튼으로.
   - 찾기 입력: 이름·라벨에 들어 있는 것만 보인다.
   - 「직접 입력」: `parseKeycode`로 해석(`LT(1, KC_SPC)`, `LCTL(KC_C)`, `0x7e00` 등). 못 읽으면 오류를 보이고 바꾸지 않는다.
   - `danger: true`(부트로더·재부팅·EEPROM 초기화)를 고르면 `ask()`로 확인한다.
   - 키보드 자판을 눌러 고르기(선택된 키에 `KeyboardEvent.code` → HID 키): `keys.js`의 `CODE_TO_USAGE`를 쓴다.
3. **레이아웃**: `def.options`마다 토글이면 체크, 아니면 선택 상자. 바꾸면 키맵 그림이 바로 바뀐다.
4. **조명 / 설정**: `def.menus.sections`를 그대로 묶음으로 그린다(섹션 = 소제목, 그룹 = 칸).
   - range: 슬라이더 + 숫자, dropdown: 선택 상자(`choices[].value`), toggle: 스위치(`off`/`on` 값), color: 색상(hue)·채도(sat) 슬라이더와 미리보기 원(`hsl(hue / 255 * 360, sat / 255 * 100%, 50%)`), keycode: 키 고르기 칸 재사용.
   - `itemVisible(item)`이 false면 숨긴다(값이 바뀔 때마다 다시 계산).
   - `item.action`(초기화·페어링 삭제·DFU 등)은 **이번 단계에서 실행하지 않는다.** 이름과 "이 동작은 제작사 허브에서 실행하세요" 안내만 보인다.
   - `item.danger`(연결 방식 등)는 저장 확인 창에 따로 경고 줄을 넣는다.
   - `def.menus.unsupported`가 있으면 "이 정의 파일의 일부 메뉴(…)는 아직 표시하지 않습니다" 안내.
5. **매크로**: 칸 목록(M0 ~ M{n-1})과 요약(`macroSummary`), 사용량 `macroBytesUsed() / macroBufferSize`.
   - 편집은 `macro-editor.js`의 `macroEditor`를 재사용한다. VIA는 `text` 단계가 있으므로 `macro-editor.js`에 **선택 기능**으로 넣는다: `o.allowText`이면 「+ 글자」 버튼(ASCII만, 입력 칸), `stepName`/`stepText`가 `text`를 보이게. Logitech·ATK 동작은 바뀌면 안 된다(기존 브라우저 시험이 지켜 준다).
   - `minDelay: 0`, `size: (steps) => encodeMacro(steps).length`, `max: macroBufferSize`. `setMacro`가 던지는 오류는 알림으로.
6. **키 시험**: 탭이 보이는 동안만 100 ms마다 `session.matrixState()`를 부르고, 눌린 키를 그림에서 칠한다.
   - `app.busy`면 건너뛰고, 부르는 동안 `app.background`에 그 Promise를 넣는다(저장과 겹치지 않게; `ui.js`의 `busy()`가 기다린다).
   - 탭을 떠나거나 연결이 끊기면 멈춘다. 응답이 없으면 멈추고 안내한다.

### 2-5. 저장·되돌리기·백업·진단

- `save()`: `changes()`가 비면 아무것도 안 함. 확인 창(`ask`)에 바뀐 키 수·매크로·설정 수, `danger` 항목 경고를 넣는다. `busy(t('저장 중…'), (setMsg) => session.save(setMsg))`. 실패해도 편집본은 남는다(세션이 성공한 부분만 반영한다).
- `revert()`: `session.revert()`.
- 백업: `download(session.exportBackup(), 'via-backup', 이름)`. 불러오기는 `importBackup(JSON)` → 편집본. 연결 방식 같은 위험 항목은 세션이 되돌리지 않는다.
- 진단 정보: 프로토콜·레이어·행렬·펌웨어·VID:PID·정의 파일 이름과 받은 곳·키맵 16진수·`unsupported` 목록. 정의 파일 전체는 넣지 않는다.
- 프로토콜 11 이하(`editable === false`): 위쪽 안내 "이 키보드의 VIA 프로토콜({n})은 아직 편집하지 않습니다. 읽기만 합니다." 키 편집과 키 고르기를 막는다(조명·설정은 열어 둔다).

### 2-6. 데모

- `index.html`에 데모 버튼 `data-demo="via"`.
- 데모 정의 파일은 **직접 만든다**(예: 일반 65% 배열, 레이아웃 옵션 1개, 조명 메뉴 4항목, 키보드 전용 키 2개). 제작사 정의 파일을 저장소에 넣지 않는다(이용 조건을 모른다).
- `MockViaDevice`를 그 크기로 만들어 연결한다.

## 3. 시험 (`tests/browser.mjs`에 VIA 묶음 추가)

가상 키보드와 시험용 정의 파일(시험 안에 직접 적은 것)로 확인한다.

- 연결 → 키맵 그림의 키 수가 `session.keys().length`와 같다. 레이어 바꾸기.
- 정의 파일이 없을 때 불러오기 화면, Qwertykeys VID에서는 링크 주소가 `https://cfg.qwertykeys.com/definitions/v3/<id>.json`.
- 키를 골라 `LT(1, KC_SPC)` 직접 입력 → 저장 → `mock.log`에 `SET_KEYCODE`, 키캡 글자 바뀜.
- 레이아웃 옵션 바꾸기 → 보이는 키 바뀜 → 저장 → `mock.layoutOptions`.
- 조명 값 바꾸기 → `showIf`로 숨겨지는 항목 확인 → 저장 → `CUSTOM_SET` 뒤에 `CUSTOM_SAVE`.
- 매크로에 글자 단계 → 저장 → `mock.macroBuffer`.
- `action` 항목은 실행 버튼이 없다. `danger` 항목을 바꾸면 확인 창에 경고 줄.
- 백업 내보내기 → 새 연결에 불러오기 → `isDirty()`.
- 키 시험: `mock.matrix = [[0, 0]]` → 그 키가 칠해짐 → 탭을 떠나면 더 묻지 않음.
- 영어 화면에 한글이 남지 않음(기존 시험 방식), 390 px 폭에서 가로 스크롤 없음.
- Logitech·ATK 매크로 편집 기존 시험이 그대로 통과(macro-editor 변경 확인).

## 4. 안전 규칙 (꼭 지킨다)

- 키보드에 쓰는 것은 **저장을 누를 때 `ViaSession.save`를 통해서만**. 화면에서 `ViaDevice`의 쓰기 함수를 직접 부르지 않는다.
- 공장 초기화(0x0A), 부트로더 진입(0x0B), 키맵 초기화(0x06), 매크로 초기화(0x10)를 보내는 코드를 만들지 않는다. `via.js`에 넣지 않는다.
- `action` 메뉴 항목은 이번 단계에서 실행하지 않는다.
- 정의 파일·백업 파일은 남이 만든 데이터다. 화면에 넣을 때 `textContent`만 쓰고, 수식(`showIf`)은 `evaluateShowIf`로만 푼다(`eval` 금지).
- 다른 사이트에서 정의 파일을 몰래 받아 오지 않는다. 자동으로 받는 곳은 `fetchDefinition`(usevia.app)뿐이다.

## 5. 끝낼 때 보고할 것

- 만든·바꾼 파일과 이유, `npm test` 결과(숫자 그대로), 화면 캡처 경로(데스크톱·모바일·영어).
- 백엔드를 고쳤다면 무엇을 왜.
- 실기기로 확인하지 않았다는 사실. 실기기 확인은 사용자와 함께: QK80 MK2 연결 → 링크로 정의 파일 받기 → 불러오기 → Qwertykeys 웹 허브와 키맵·조명 값이 같은지 읽기만 비교 → 키 하나 바꿔 저장·확인 → 원래대로 되돌려 저장.
