# 제품 사진

`js/device-images.js`는 공식 제품 페이지에서 확인한 원본 이미지 주소·출처와
홈에 표시할 로컬 PNG를 관리합니다. 기종을 정확히 매칭하고 미등록·모호한 기종이나
로딩 실패에는 기본 마우스 그림을 사용합니다. 홈에는 제품 페이지 링크를 표시하지 않습니다.

사진은 `assets/mice/`에 저장합니다. 2026-10-14 기준 **84장**이며 기존 6장에
미검증 기종용 사진 78장을 추가했습니다. 제조사 제품 페이지와 공식 웹 허브에서
기종·외형을 대조했습니다. 사진 등록은 해당 기기의 통신·저장 기능 검증을 뜻하지 않습니다.

| 제조사 | 사진 수 | 준비한 주요 제품군 |
| --- | ---: | --- |
| ATK / VXE | 26 | A9·A9 Mini, F1·F1 V2·V3, X1·X1 V2, Z1·Z1 V2, U2·U2 Mini, Y9, Ghost, Duckbill, ZERO, FIERCE X, R1, V3, MAD R |
| MCHOSE | 20 | A7·A7 V2·V3·A7X·RE, A5 V2·V3, AX5 V2, M7, L7, G3·G3 V3, K7·K7 V2, K5, R7, V7 |
| VGN | 15 | F1·F1S·MOBA·Pro·Pro Max·SE, F1 V2·V5, F2·Master·Turbo, Y2·Y2 V2, Dragonfly 3·Mini, Falcon 3 |
| Logitech | 23 | SUPERLIGHT·2·2c·DEX·SE, SUPERSTRIKE 2·3, PRO 2, G304/305·X·X SUPERLIGHT, G309, G502 HERO·LIGHTSPEED·X·X PLUS, G403, G703, G903, G102/203 |

총 342개의 기종명·제조사 접두어 별칭을 정확히 매칭합니다. 같은 외형의 세부 모델은
공식 허브의 공통 사진을 공유하며, A9 Mini와 Dragonfly 3 Mini는 일반형과 분리했습니다.
로지텍은 기기에서 이름을 읽어 등록 사진을 선택하므로 표에 없는 모델은 기본 그림을 사용합니다.

원본이 이미 투명한 78장은 그 투명도를 보존해 PNG로 저장했습니다. 기존 5장과 새
A9 Mini 1장은 imagegen으로 흰 배경을 제거했습니다. 마우스의 흰 몸체·로고·하이라이트는
유지했습니다. 제품 색상은 대표 색상이며 연결된 기기의 실제 색상을 감지하지 않습니다.
사진 권리는 각 제조사에 있으며 원본 출처 정보는 코드에 보존합니다.

모든 사진의 투명 배경과 브라우저 로딩, 별칭 매칭, 미등록 기종의 기본 그림 처리를
확인하고 어두운 배경에서 화면 검수했습니다. 가상 기기를 사용하는 기존 브라우저 회귀
검사도 통과했습니다. 이 사진 준비 작업에서는 실제 마우스에 명령을 보내지 않았습니다.

## 아직 공식 사진을 확인하지 못한 기종

- MCHOSE A5 Pro Max 1세대: 유선·1K 수신기·4K 수신기 항목 모두 기본 그림 유지.
  A5 V2/V3나 AX5 사진으로 대신 표시하지 않습니다.
- ATK X EXTREME, VXE T1, Flow 7: 공식 허브의 해당 항목에 제품 사진 매핑이 없고,
  제품 페이지에서도 일치하는 사진을 확인하지 못해 기본 그림 유지.
- Logitech PRO Wireless 1세대: 확인한 공식 제품 페이지가 403/404로 응답해 사진 미등록.

제품명이 여러 모델을 함께 나타내는 경우에도 하나를 임의로 선택하지 않습니다.
공식 사진이 확인되면 해당 기종의 정확한 이름으로 별칭과 로컬 이미지를 추가합니다.

배경 제거 프롬프트:

> Edit the attached official mouse product photograph. Remove ONLY the plain white background and replace it with genuine transparent alpha. Preserve every product object, exact silhouette, proportions, colors, textures, buttons, logos, lettering, orientation and arrangement. Preserve the white mouse body, white logos and product highlights; these are foreground, not background. Preserve any accessories and RGB lighting. For a perforated shell, remove background visible through holes but preserve internal components. Do not redesign, add text, stylize, recolor, crop, or add shadows. Output a clean product cutout PNG for a dark website.

공식 원본 확인 경로:

- [ATK 공식 허브](https://v3-hub.atk.store/) 및 [ATK 공식 스토어](https://www.atk.store/)
- [MCHOSE 공식 허브](https://www.mchose.com.cn/) 및 [MCHOSE 공식 스토어](https://www.mchose.store/)
- [VGN 공식 허브](https://hub.vgnlab.com/) 및 [VGN 공식 스토어](https://vgnlab.com/)
- [Logitech G 공식 제품 목록](https://www.logitechg.com/en-us/shop/c/gaming-mice)
