// WLMouse(wlmouse.js) 마우스의 설정 화면. 화면 자체는 상태 기반 마우스의 공용 화면(status-ui.js)을 쓴다.
import { filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot } from './wlmouse.js';
import { createStatusUi } from './status-ui.js';

const ui = createStatusUi({
  brand: 'WLMouse', hub: 'WLMouse HUB', filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot,
  backupType: 'gomm-wlmouse-backup', diagType: 'omm-web-wlmouse-diagnostics',
  diagDetails: (diag) => [`기종: ${diag.status.model || '알 수 없음'}`], // i18n-ignore
});

export { filters, catalog };
export const { state, connected, isDirty, canEdit, ownsDevice, connect, disconnect, refreshBattery, summary, save, revert,
  exportDiagnostics, exportBackup, importBackup, renderProfiles, render } = ui;
