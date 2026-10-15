// MCHOSE 기종표. 이름, USB 제품 ID, DPI 상한, 리프트오프 단계(mm), 연결별 보고율 상한처럼
// M HUB(제조사 웹 드라이버)의 기종표에 있는 사실 정보만 적었다. 출처: docs/mchose-support.md.

const LOD2 = [1, 2];
const LOD3 = [0.7, 1, 2];
const LOD5 = [0.7, 0.9, 1.2, 1.4, 1.7];

// V2 세대. hosts는 {이 기종이 잡히는 USB 제품 ID: 그 연결의 보고율 상한}이다.
// hosts가 없는 A7 V2 계열은 공용 수신기 ID(V2_LINK)로 잡히며 보고율 상한은 maxRate를 따른다.
function v2(name, pid, dpiMax, lod, hosts = null) {
  const maxRate = hosts ? Math.max(...Object.values(hosts)) : 8000;
  // G3 Ultra 8K/4K는 USB ID가 같아 지금 어느 연결인지 가릴 수 없다.
  return { family: 'V2', name, pid, dpiMax, lod, hosts, maxRate, readOnly: name.startsWith('G3 Ultra') };
}
const on = (ids, rates) => Object.fromEntries(ids.map((id, i) => [id, rates[i]]));
const STD = (own, ownRate) => on([own, 0x1021, 0x1020], [ownRate, 1000, 8000]);

// V3 세대. 리프트오프가 5단계인 기종은 설정 바이트가 아니라 별도 명령으로 리프트오프를 다룬다.
const v3 = (name, pid, dpiMax, lod, maxRate = 8000) =>
  ({ family: 'V3', name, pid, dpiMax, lod, maxRate, lodCommand: lod.length > 3, readOnly: false });

// A5 1세대. 제조사 ID부터 다르고 통신 방식도 따로다.
const a5 = (name, pid, wired) => ({ family: 'A5 Gen1', name, pid, wired, readOnly: false });

export const MODELS = [
  v2('A7 V2 Pro', 0x4018, 26000, LOD2),
  v2('A7 V2 Pro+', 0x4023, 26000, LOD2),
  v2('A7 V2 Ultra', 0x4019, 42000, LOD3),
  v2('A7 V2 Ultra+', 0x4021, 42000, LOD3),
  v2('M7', 0x0020, 26000, LOD2, STD(0x0020, 1000)),
  v2('M7 1K', 0x0020, 26000, LOD2, STD(0x0020, 1000)),
  v2('M7 Pro', 0x0030, 26000, LOD2, STD(0x0030, 8000)),
  v2('M7 Ultra', 0x0031, 42000, LOD3, STD(0x0031, 8000)),
  v2('L7', 0x00c0, 26000, LOD2, STD(0x00c0, 1000)),
  v2('L7 Pro', 0x00b0, 26000, LOD2, STD(0x00b0, 8000)),
  v2('L7 Pro+', 0x4015, 26000, LOD2, STD(0x4015, 8000)),
  v2('L7 Ultra', 0x00b1, 42000, LOD3, STD(0x00b1, 8000)),
  v2('L7 Ultra+', 0x4016, 42000, LOD3, STD(0x4016, 8000)),
  v2('A7', 0x0070, 26000, LOD2, STD(0x0070, 1000)),
  v2('A7 Pro', 0x0010, 26000, LOD2, STD(0x0010, 8000)),
  v2('A7 Ultra', 0x0011, 42000, LOD3, STD(0x0011, 8000)),
  v2('A7X Ultra', 0x4011, 42000, LOD3, on([0x4011, 0x100a, 0x1009], [8000, 1000, 8000])),
  v2('A7 Ultra(RE)', 0x4110, 42000, LOD3, STD(0x4110, 8000)),
  v2('K7 Ultra', 0x4150, 42000, LOD3, on([0x4150, 0x1001, 0x1021, 0x1020], [8000, 8000, 1000, 8000])),
  v2('AX5 V2', 0x4010, 42000, LOD3, on([0x4010, 0x00a1, 0x1021, 0x1020], [8000, 8000, 1000, 8000])),
  v2('A5 V2 Ultra', 0x1101, 26000, LOD2, on([0x1101, 0x1102, 0x100c], [8000, 4000, 4000])),
  v2('G3 Ultra 8K', 0x4762, 26000, LOD2, on([0x4762, 0x1020], [8000, 8000])),
  v2('G3 Ultra 4K', 0x4762, 26000, LOD2, on([0x4762, 0x1020, 0x100c], [8000, 8000, 4000])),

  v3('A5 V3 Pro', 0x4035, 26000, LOD2),
  v3('A5 V3 Ultra+', 0x4026, 42000, LOD3),
  v3('A5 V3 Ultra+ (3955)', 0x4034, 50000, LOD5),
  v3('K7 V2 Pro+', 0x4027, 42000, LOD3),
  v3('K7 V2 Ultra+', 0x4028, 50000, LOD5),
  v3('A7 V3', 0x4030, 26000, LOD2),
  v3('A7 V3 Pro', 0x4031, 42000, LOD3),
  v3('A7 V3 Pro+', 0x4032, 42000, LOD3),
  v3('A7 V3 Ultra+', 0x4033, 50000, LOD5),
  v3('K5 Pro', 0x4037, 26000, LOD2),
  v3('K5 Ultra', 0x4038, 50000, LOD5),
  v3('R7 Ultra', 0x4036, 50000, LOD5),
  v3('V7', 0x402a, 26000, LOD2, 1000),
  v3('G3 V3', 0x4029, 12000, LOD2, 1000),

  a5('A5 Pro Max', 0xf019, true),
  a5('A5 Pro Max (1K 수신기)', 0xf013, false),
  a5('A5 Pro Max (4K 수신기)', 0xf015, false),
];

// 여러 기종이 함께 쓰는 수신기·블루투스 ID. 이 ID로는 기종을 알 수 없어 기기에 직접 묻는다.
export const V2_BLUETOOTH = 0x100a;
export const V3_LINKS = [0x1014, 0x1016, 0x1018];
// MagDock(충전 독)은 같은 제조사 ID를 쓰지만 마우스가 아니다.
export const DOCK_PID = 0x1012;

export const V3_PIDS = [...MODELS.filter(m => m.family === 'V3').map(m => m.pid), ...V3_LINKS];
