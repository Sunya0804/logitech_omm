// Razer(razer.js) 마우스의 설정 화면. 화면 자체는 상태 기반 마우스의 공용 화면(status-ui.js)을 쓴다.
import { filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot } from './razer.js';
import { createStatusUi } from './status-ui.js';
import { t } from './i18n.js';

const ui = createStatusUi({
  brand: 'Razer', hub: 'Razer Synapse', filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot,
  backupType: 'gomm-razer-backup', diagType: 'omm-web-razer-diagnostics',
  diagDetails: (diag) => [`기종: ${diag.status.model || '알 수 없음'}`], // i18n-ignore
  note: () => t('Razer는 DPI 단계·보고율·자동 절전만 편집합니다. 버튼과 조명은 Razer Synapse에서 바꾸세요. Synapse가 실행 중이면 이 화면과 통신이 엉킬 수 있습니다.'),
});

export { filters, catalog };
export const { state, connected, isDirty, canEdit, ownsDevice, connect, disconnect, refreshBattery, summary, save, revert,
  exportDiagnostics, exportBackup, importBackup, renderProfiles, render } = ui;
