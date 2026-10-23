# WLMouse·Razer 지원 범위와 출처

2026-10-23 작성. 두 브랜드 모두 **이 프로젝트에서 실기기로 읽기·저장을 확인한 적이 없습니다.**
데모(가상 기기)와 자동 시험으로만 확인했습니다.

## 출처

- [OpenMouse](https://github.com/OpenMouse-Project/openmouse)의 통신 라이브러리 `@openmouse/protocol` 0.45.2(npm, AGPL-3.0-or-later)를 읽고,
  명령 번호·바이트 위치·기종별 값 같은 **사실 정보만** 참고했습니다. 코드는 가져오지 않았고 `js/wlmouse.js`, `js/razer.js`는 이 프로젝트에서 새로 작성했습니다.
- Razer의 90바이트 요청 틀과 명령 번호는 [OpenRazer](https://github.com/openrazer/openrazer)가 오래전부터 공개한 것과 같습니다.
- 기종별 「실기기 확인」 표시는 OpenMouse의 지원 목록(`supported-devices-data.ts`)이 `supported`로 적은 기종을 따릅니다.

## WLMouse

- 설정 통로: 기능 보고서 0번, 64바이트. `[0]=0, [2]=대상, [3]=인자 길이, [4]=페이지, [5]=명령, [6..]=인자`.
  답의 `[0]`이 0xa1이면 성공, 0xa2면 그 기종에 없는 명령입니다. Windows는 답 앞에 보고서 번호를 붙이기도 해서 한 칸 밀린 답도 받습니다.
- 대상: 0 수신기, 1 수신기가 아는 짝 마우스, 2 마우스. 읽기 명령은 0x80 비트가 켜져 있고 쓰기는 그 비트를 끈 같은 번호입니다.
- 편집 항목: DPI 단계(최대 6, 50~30,000, 50 단위), 현재 단계, 보고율, 리프트오프(0.7·1·2 mm), 디바운스(0~15 ms), 자동 절전,
  모션 싱크·각도 스냅·리플 컨트롤·고속 모드·터보 모드, 센서 각도(±30°). 기종에 없는 항목은 숨깁니다.
- 1K 수신기(36A7:A882)는 짝 마우스의 제품 ID를 따로 물어 기종을 알아냅니다. 알아내지 못하면 읽기 전용입니다.
- Beast X 4K(36A7:A887)는 다른 규격(보고서 4번)을 써서 연결을 거절합니다.
- OpenMouse가 실기기로 확인한 기종: Beast X, Beast Mini, Beast X Pro, Sword X, Beast Max.
  나머지(Beast G, Huan, Beast Miao, Beast Mini Pro, Strider, Ying)는 같은 규격이라고만 알려져 있어 화면에 그렇게 표시합니다.

## Razer

- 설정 통로: 기능 보고서 0번, 90바이트. `[0]=상태, [1]=트랜잭션 ID, [5]=인자 길이, [6]=명령 묶음, [7]=명령, [8..87]=인자, [88]=[2..87]의 XOR`.
- 트랜잭션 ID는 기종마다 다르고, 틀리면 마우스가 답하지 않습니다. 그래서 OpenMouse가 실기기로 확인한 기종만 등록했습니다.
- 편집 항목: DPI 단계(최대 5)와 현재 단계, 보고율(유선 125~1000 Hz, HyperPolling 기종 무선 최대 8000 Hz), 무선 기종의 자동 절전.
  버튼·조명·리프트오프는 다루지 않습니다.
- 등록 기종: DeathAdder V2, DeathAdder V2 Pro, DeathAdder Essential(3종), DeathAdder V3, DeathAdder V3 Pro, DeathAdder V4 Pro(카본 포함),
  Viper V2 Pro, Viper V3 Pro, Viper V3 HyperSpeed, Naga V2 Pro.

### Chrome 153 이후 Windows에서 막힘

OpenMouse 이슈 [#253](https://github.com/OpenMouse-Project/openmouse/issues/253)에 따르면 Chrome 153(2026-09-08 배포)부터
Windows에서 Razer 설정 채널(마우스 컬렉션)의 기능 보고서를 브라우저가 거절합니다. 같은 PC에서 Chrome 152는 동작했다고 합니다.
2026-10-23 기준 이슈는 열려 있고, OpenMouse는 별도 데스크톱 프로그램(OpenMouse Bridge)으로 우회합니다.

GOMM은 설치 없는 웹앱이라 이런 우회 수단이 없습니다. 브라우저가 거절하면 연결할 때 그 이유와 현재 브라우저 버전을 알려 줍니다.
이 PC의 Chrome·Edge는 155라서, Windows에서는 Razer 마우스를 실제로 설정하지 못할 가능성이 큽니다.
