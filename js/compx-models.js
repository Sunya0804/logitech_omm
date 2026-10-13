// 실기기로 확인하지 못한 ATK·VXE 기종의 식별값(CID,MID) → 기종 이름. DPI 저장 방식이 같은 센서끼리 묶었다.
// ATK HUB의 기종표를 OpenMouse(mouse-protocol)가 정리한 내용에서 식별값·이름·센서만 옮겨 적었다(코드는 가져오지 않음).
// 여기 있는 기종은 연결은 되지만, 읽힌 값이 ATK HUB와 같은지 사용자가 확인해야 편집이 열린다(compx-ui.js).
//
// 넣지 않은 것:
// - 같은 식별값을 DPI 저장 방식이 다른 기종이 함께 쓰는 경우. 무선 연결에서는 수신기의 제품 ID만 보여서 가려낼 수 없다.
// - 이 프로젝트가 해석하지 못하는 센서(PAW3955 Master, PAW3395 SE, PAW3315, PAW3311, PAW3320).
// 이름이 「A / B」인 항목은 같은 센서를 쓰는 여러 기종이 식별값을 함께 쓰는 경우다.
(function (OMM) {
  'use strict';

  OMM.compxCatalog = {
    // PAW3950 Ultra: 10~42,000 DPI, 10 단위부터
    ultra: {
      '1,2': 'ATK Duckbill Ultra / ATK A9 Ultimate 3.0',
      '1,3': 'ATK A9 Ultimate / ATK Ghost Ultimate',
      '1,5': 'ATK Y9 Ultimate',
      '1,7': 'ATK F1 EXTREME 2.0 / ATK A9 Ultra Max 2.0 +',
      '1,16': 'ATK U2 Ultimate 2.0 / ATK A9 Mini',
      '1,19': 'ATK Z1 Ultimate 2.0 / ATK F1 V3 Ultra Max',
      '1,22': 'ATK X1 EXTREME GT / ATK A9 Ultimate',
      '1,23': 'ATK Ghost EXTREME',
      '1,25': 'ATK Duckbill EXTREME',
      '1,26': 'ATK ZERO',
      '1,27': 'ATK A9 Mini',
      '1,28': 'ATK A9 Mini',
      '1,30': 'ATK X EXTREME',
      '1,32': 'ATK X1 Ultra Max 2.0',
      '1,33': 'ATK F1 Ultra Max 2.0',
      '1,37': 'ATK A9 Ultra Max 2.0 Tri-Mode',
      '1,38': 'ATK A9 Ultra Max 2.0',
      '1,85': 'ATK F1 V3 ULTIMATE',
      '2,13': 'ATK A9 Plus NK',
      '2,14': 'ATK A9 Pro Max 2.0 NK',
      '2,17': 'VXE R1 PRO MAX 2.0 NK',
      '2,23': 'VXE T1',
      '2,25': 'ATK U2 Plus NK',
      '2,34': 'ATK A9 Plus 3.0 NK',
      '2,35': 'ATK A9 Pro Max 3.0 NK',
      '2,42': 'ATK F1 Ultimate',
      '2,43': 'ATK X1 Ultra',
      '2,44': 'ATK FIERCE X',
      '2,45': 'ATK F1 Ultra',
      '2,46': 'ATK X1 Ultimate',
      '2,50': 'ATK F1 EXTREME',
      '2,53': 'ATK Z1 Ultra',
      '2,56': 'ATK F1 LEVIATAN',
      '2,65': 'ATK U2 Ultimate',
      '2,70': 'ATK X1 EXTREME',
      '2,87': 'ATK A9 Ultra',
      '2,115': 'ATK A9 NB ULTRA',
      '2,124': 'ATK U2 Plus NK',
      '2,125': 'VXE R1 PRO',
      '2,126': 'VXE R1 PRO MAX',
      '2,127': 'VXE R1',
      '2,128': 'ATK U2 Pro Max',
      '2,131': 'Flow 7',
      '2,132': 'ATK X1 S NK',
      '2,133': 'MAD R',
    },
    // PAW3950 / PAW3950 DM: 50~36,000 DPI, 50 단위
    paw3950: {
      '1,87': 'ATK X1 Ultra Max 2.0',
      '2,26': 'ATK A9 Plus NK',
      '2,36': 'ATK F1 PRO',
      '2,37': 'ATK F1 PRO MAX',
      '2,38': 'ATK X1 PRO',
      '2,40': 'ATK Z1 PRO',
      '2,41': 'ATK Z1 PRO MAX',
      '2,47': 'MAD R MAJOR',
      '2,55': 'MAD R MAJOR+',
      '2,64': 'ATK U2 MINI',
      '2,66': 'ATK U2 Ultra',
      '2,108': 'ATK Y9 PRO MAX',
    },
    // PAW3395 / PAW3395 Ultra: 100~30,000 DPI, 50 단위
    paw3395: {
      '1,11': 'ATK X1 Ultra Max 2.0',
      '1,20': 'VXE R1 Ultra',
      '2,1': 'ATK U2 Pro / ATK A9 Pro Max 2.0 NK',
      '2,4': 'ATK A9 Plus NK',
      '2,7': 'VXE V3 Plus',
      '2,49': 'MAD R',
      '2,54': 'MAD R +',
      '2,76': 'ATK X1 S NK',
      '2,78': 'ATK U2 Plus NK',
      '2,85': 'ATK A9 Pro Max',
      '2,89': 'ATK X1 Lite',
      '2,93': 'DRAGONFLY F1 V2 Plus NK',
      '2,96': 'ATK Y9 Plus NK',
      '2,100': 'ATK U2 Pro Max',
      '2,110': 'DRAGONFLY F1 V2 PRO MAX',
      '2,114': 'VXE R1 UlTRA',
      '4,2': 'DRAGONFLY F1 V2 Pro',
    },
    // CORE26K: 50~26,000 DPI, 50 단위
    core26k: {
      '2,15': 'VXE V3 PRO Max',
      '2,22': 'VXE R1 SE+',
      '2,28': 'VXE R1N NK',
      '2,30': 'VXE V3 PRO NK',
      '2,33': 'ATK X1 SE NK',
    },
  };
})((window.OMM = window.OMM || {}));
