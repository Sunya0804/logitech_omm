import * as protocol from '../vendor/openmouse/mchose/index.js';
import { MchoseHidClient } from '../vendor/openmouse/drivers/mchose/hid.js';
import { MchoseV3HidClient } from '../vendor/openmouse/drivers/mchose/v3-hid.js';
import { MchoseA5ProMaxHidClient } from '../vendor/openmouse/drivers/mchose/a5-gen1-hid.js';
import { additionalModels } from './mchose-models.js';

// The upstream table is shared by the codecs and driver. Add model facts once.
protocol.MCHOSE_PRODUCTS.push(...additionalModels);

export const filters = [
  { vendorId: 0x3837, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x2023, usagePage: 0xffff },
  { vendorId: 0x5253, productId: 4128, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x5253, productId: 4129, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x41e4, productId: 4353, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x41e4, productId: 4354, usagePage: 0xff01, usage: 1 },
  { vendorId: 0x0bda, productId: 18274, usagePage: 0xff01, usage: 1 },
];
export const catalog = [
  ...protocol.MCHOSE_PRODUCTS.map(p => ({ ...p, family: 'V2', vendorId: 0x3837 })),
  ...protocol.MCHOSE_V3_PRODUCTS.map(p => ({ ...p, family: 'V3', vendorId: 0x3837 })),
  ...[...protocol.MCHOSE_A5_GEN1_PRODUCTS].map(([productId, p]) => ({ ...p, productId, family: 'A5 Gen1', vendorId: 0x2023 })),
];

class ExtendedV2Client extends MchoseHidClient {
  async readConfigPayload() {
    const raw = await super.readConfigPayload();
    if (!raw || raw.length < 50 || raw[0] >= 3 || raw[16] < 1 || raw[16] > 6
      || (raw[1] & 15) >= raw[16] || (raw[2] & 15) >= raw[16] || raw[18] > 20) return null;
    this.stageCount = raw[16];
    return raw;
  }
  linkRates(product) {
    if (product?.hostIds) {
      const max = product.rates[product.hostIds.indexOf(this.device.productId)];
      return max ? protocol.MCHOSE_POLLING_RATES[max] : [];
    }
    return super.linkRates(product);
  }
  async readStatus() {
    const s = await super.readStatus();
    if (s.dpiStages) s.dpiStages = s.dpiStages.slice(0, this.stageCount);
    // Do not resolve an unknown PID by a partial name such as "A7" in "A7 Future".
    const exact = protocol.MCHOSE_PRODUCTS.find(p => this.device.productName.trim() === `MCHOSE ${p.name}`);
    if (!exact || (exact.hostIds && !exact.hostIds.includes(this.device.productId)) || !s.pollingRateHz
      || !s.dpiStages?.every(dpi => dpi >= 50 && dpi <= exact.dpiMax)) s.ui.settingsReady = false;
    return s;
  }
}

export function createClient(devices) {
  // Never open the firmware-update collection (ff0b) or a MagDock as a mouse.
  const alternate = devices.find(d => {
    const model = additionalModels.find(p => d.productName.trim() === `MCHOSE ${p.name}` && p.hostIds.includes(d.productId));
    return model && d.vendorId !== 0x3837 && filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId)
      && d.collections.some(c => c.usagePage === 0xff01 && c.usage === 1
        && [0x11, 0x12].every(id => c.featureReports.some(r => r.reportId === id)));
  });
  if (alternate) return new ExtendedV2Client(alternate);
  for (const Class of [MchoseA5ProMaxHidClient, MchoseV3HidClient, MchoseHidClient]) {
    const device = devices.find(d => Class.isSupported(d));
    if (device) {
      return new (Class === MchoseHidClient ? ExtendedV2Client : Class)(device);
    }
  }
  throw new Error('지원하는 MCHOSE 설정 인터페이스가 없습니다. MagDock·펌웨어 업데이트 인터페이스는 마우스 설정 대상이 아닙니다.');
}

export const scalarSetters = {
  pollingRateHz: 'setPollingRate', activeDpiStage: 'setActiveDpiStage',
  debounceMs: 'setDebounceTime', sleepTimeout: 'setSleepTimeout',
  liftOffDistance: 'setLiftOffDistance', motionSync: 'setMotionSync',
  angleSnapping: 'setAngleSnapping', rippleControl: 'setRippleControl',
  powerMode: 'setPowerMode', angleTuning: 'setAngleTuning',
};
export function editableSnapshot(s) {
  return Object.fromEntries([...Object.keys(scalarSetters), 'dpiStages', 'buttonMappings', 'activeProfile']
    .map(key => [key, s[key] ?? null]));
}
export function changes(before, after) {
  const result = [];
  for (const [key, setter] of Object.entries(scalarSetters)) {
    if (after[key] !== before[key]) result.push({ key, setter, args: [after[key]] });
  }
  (after.dpiStages || []).forEach((dpi, i) => {
    if (dpi !== before.dpiStages?.[i]) result.push({ key: `dpiStages.${i}`, setter: 'setDpiStageValue', args: [i, dpi] });
  });
  for (const [button, action] of Object.entries(after.buttonMappings || {})) {
    if (action !== before.buttonMappings?.[button]) {
      if (button === 'Left') throw new Error('왼쪽 버튼은 기본 클릭을 유지합니다.');
      result.push({ key: `buttonMappings.${button}`, setter: 'setButtonMapping', args: [button, action] });
    }
  }
  return result;
}
const valueAt = (s, key) => key.split('.').reduce((value, part) => value?.[part], s);
export async function saveChanges(client, before, desired) {
  const plan = changes(before, desired);
  const fresh = await client.readStatus();
  if (!fresh.ui?.settingsReady || !knownStatus(fresh) || fresh.name !== before.name || fresh.connectionType !== before.connectionType) {
    throw new Error('기기 또는 편집 가능 상태가 바뀌었습니다. 다시 연결해 주세요.');
  }
  if (JSON.stringify(editableSnapshot(fresh)) !== JSON.stringify(editableSnapshot(before))) {
    throw new Error('기기 설정이 외부에서 바뀌었습니다. 다시 읽은 뒤 수정해 주세요.');
  }
  for (const change of plan) {
    if (typeof client[change.setter] !== 'function') throw new Error('이 기종이 지원하지 않는 설정입니다.');
    await client[change.setter](...change.args);
  }
  const back = await client.readStatus();
  const failed = plan.filter(c => valueAt(back, c.key) !== valueAt(desired, c.key));
  if (back.activeProfile !== before.activeProfile || failed.length) {
    throw new Error(`기록 후 검증에 실패했습니다: ${failed.map(c => c.key).join(', ') || '프로필 변경'}`);
  }
  return back;
}

export function knownStatus(s) {
  return catalog.some(p => !p.readOnly && s.name === (p.name.startsWith('MCHOSE ') ? p.name : `MCHOSE ${p.name}`));
}
