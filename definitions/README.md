# 내장 VIA 정의 파일

이 폴더의 파일은 키보드 제작사가 배포한 VIA 정의 파일을 그대로 복사한 것입니다.
**이 저장소의 라이선스(LICENSE) 대상이 아니며, 권리는 각 제작사에 있습니다.**
GOMM은 사용자가 정의 파일을 따로 받지 않아도 되도록 아래 키보드의 파일을 함께 싣습니다.
제작사가 요청하면 바로 지웁니다.

| 파일 | 키보드 | 받은 곳 | 받은 날 | SHA-256 |
|---|---|---|---|---|
| `qwertykeys/1363889410.json` | Qwertykeys QK80 MK2 (514B:4D02) | https://cfg.qwertykeys.com/definitions/v3/1363889410.json | 2026-10-18 | `9a16e15d…af7b5b` |
| `qwertykeys/1363889411.json` | Qwertykeys QK65 MK3 (514B:4D03) | https://cfg.qwertykeys.com/definitions/v3/1363889411.json | 2026-10-23 | `c4b78043…939e57` |
| `neo/1313159216.json` | Neo80 유선 PCB (4E45:3830) — Neo80 Cu 유선·솔더 PCB도 같은 ID | https://qwertykeys.com/pages/fw → Neo80 → Wired JSON (neo80_wired_v3.json) | 2026-10-23 | `871a8b92…379083` |
| `neo/4294836278.json` | Neo80 트라이모드 PCB (FFFE:0036) | https://qwertykeys.com/pages/fw → Neo80 → Tri-mode JSON (neo80_wireless.json) | 2026-10-23 | `471cddaf…7cefec` |
| `neo/917516482.json` | Neo80 Cu 트라이모드 ANSI (36B0:30C2) | https://qwertykeys.com/pages/fw → Neo80 Cu → Tri-mode ANSI JSON (Neo80_Cu_ansi.JSON) | 2026-10-23 | `3b470378…73013e` |
| `neo/917516504.json` | Neo80 Cu 트라이모드 ISO (36B0:30D8) | https://qwertykeys.com/pages/fw → Neo80 Cu → Tri-mode ISO JSON (Neo80_Cu_tri-mode_iso.JSON) | 2026-10-23 | `aa3444cb…39dbcb` |
| `evoworks/917516302.json` | Evoworks(Ticktype) Evo80 (36B0:300E) | https://mechanicalkeyboards.com/products/evoworks-evo80-polypropylene-plate-keyboard → EVO80_0924.JSON (mecha.com.my 다운로드 페이지의 Evo80.zip과 내용 동일) | 2026-10-23 | `a97d6669…f7b2c0` |
| `wobkey/839864405-rgb.json` | WOBKEY Crush 80 RGB(Reboot Pro) 유선 (320F:5055) | https://wobkey.com/pages/support-for-crush-80 → Crush_80_【RGB】Json.zip → 【RGB -USB wired】.JSON | 2026-10-23 | `3d42a207…b01d31` |
| `wobkey/839864405-lite.json` | WOBKEY Crush 80 non-RGB(Reboot Lite) 유선 (320F:5055) | https://wobkey.com/pages/support-for-crush-80 → Crush_80_【NO_RGB】Json.zip → 【NO RGB -USB wired】.JSON | 2026-10-23 | `e557f3bf…1d0373` |
| `wobkey/839864456-rgb.json` | WOBKEY Crush 80 RGB(Reboot Pro) 2.4G 수신기 (320F:5088) | https://wobkey.com/pages/support-for-crush-80 → Crush_80_【RGB】Json.zip → 【RGB- 2.4G】.JSON | 2026-10-23 | `92c723f2…215110` |
| `wobkey/839864456-lite.json` | WOBKEY Crush 80 non-RGB(Reboot Lite) 2.4G 수신기 (320F:5088) | https://wobkey.com/pages/support-for-crush-80 → Crush_80_【NO_RGB】Json.zip → 【NO RGB-2.4G】.JSON | 2026-10-23 | `274cceb3…06b386` |
| `archon/839864405.json` | archon RE:AL HX 유선 (320F:5055) | 프리플로우 자료실 「아콘 archon RE:AL HX VIA 파일 다운로드」 https://preflow.co.kr/article/자료실/7/100/ → Google Drive 1ayCj3ix… → RE AL HX-USB.JSON | 2026-10-23 | `f07c62e0…d9999f` |
| `archon/839864456.json` | archon RE:AL HX 2.4G 수신기 (320F:5088) | 프리플로우 자료실 「아콘 archon RE:AL HX VIA 파일 다운로드」 https://preflow.co.kr/article/자료실/7/100/ → Google Drive 1ayCj3ix… → RE AL HX-2.4G.JSON | 2026-10-23 | `a7aba074…681efd` |

- 내용은 고치지 않습니다. 새 펌웨어로 정의가 바뀌면 같은 곳에서 다시 받아 바꾸고, 표의 날짜와 해시를 고칩니다. `tests/via.test.mjs`가 파일·ID·해시가 이 표와 맞는지 확인합니다.
- 사용자가 직접 불러온 정의 파일이 있으면 그쪽을 먼저 씁니다(`js/via-definition.js`의 `BUNDLED`).
- 같은 USB ID를 여러 키보드가 쓰는 경우(320F:5055·320F:5088: Crush 80 RGB·non-RGB, RE:AL HX) 키보드가 USB로 알려 주는 제품 이름(WebHID productName)으로 먼저 가립니다. 한 후보만 맞으면 바로 열고, 'Crush 80'처럼 RGB·non-RGB를 가릴 수 없으면 연결 화면에서 맞는 후보를 강조해 사용자가 고르게 합니다. 고른 파일은 브라우저가 기억합니다. (실제 제품 이름 문자열은 아직 기기로 확인하지 못했습니다.) usevia.app의 같은 ID는 GMMK Numpad라서 「자동으로 찾기」를 누르면 그 파일이 옵니다.
- Neo80 Cu의 유선·솔더 PCB는 Neo80 유선 PCB와 같은 ID(4E45:3830)입니다. 세 파일의 키 자리는 같고 유선 PCB 파일만 「Split Right Shift」 옵션이 더 있어서 그 파일 하나를 싣습니다. 화면에 뜨는 이름은 「NEO80 Wired PCB」입니다.
- 이 파일들은 GOMM의 정의 파일 해석기와 가상 키보드로만 시험했고, 실제 키보드에 연결해 확인하지는 않았습니다(QK80 MK2 제외).
