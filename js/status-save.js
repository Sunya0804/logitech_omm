// 상태 기반 마우스(WLMouse·Razer)의 편집 비교와 저장. MCHOSE(mchose.js)와 같은 순서로 동작한다:
// 저장 직전에 다시 읽어 화면이 보던 값과 같은지 확인하고, 바뀐 항목만 기록한 뒤 다시 읽어 하나씩 대조한다.
import { t } from './i18n.js';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const valueAt = (s, key) => key.split('.').reduce((v, part) => v?.[part], s);

// fields: 한 값으로 비교하는 항목 이름. dpiStages는 칸마다 따로 비교한다.
export function statusSaver(fields, knownStatus) {
  const editableSnapshot = (s) => Object.fromEntries([...fields, 'dpiStages', 'activeProfile'].map((key) => [key, s[key] ?? null]));
  function changes(before, after) {
    const keys = fields.filter((key) => after[key] !== before[key]);
    (after.dpiStages || []).forEach((dpi, i) => { if (dpi !== before.dpiStages?.[i]) keys.push(`dpiStages.${i}`); });
    return keys;
  }
  async function saveChanges(client, before, desired) {
    const keys = changes(before, desired);
    const fresh = await client.readStatus();
    need(fresh.ui?.settingsReady && knownStatus(fresh) && fresh.name === before.name && fresh.connectionType === before.connectionType,
      t('기기 또는 편집 가능 상태가 바뀌었습니다. 다시 연결해 주세요.'));
    need(JSON.stringify(editableSnapshot(fresh)) === JSON.stringify(editableSnapshot(before)), t('기기 설정이 외부에서 바뀌었습니다. 다시 읽은 뒤 수정해 주세요.'));
    if (keys.length) await client.apply(keys, desired);
    const back = await client.readStatus();
    const failed = keys.filter((key) => valueAt(back, key) !== valueAt(desired, key));
    need(back.activeProfile === before.activeProfile && !failed.length,
      t('기록 후 검증에 실패했습니다: {items}', { items: failed.join(', ') || t('프로필 변경') }));
    return back;
  }
  return { editableSnapshot, changes, saveChanges };
}
