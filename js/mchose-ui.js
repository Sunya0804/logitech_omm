// MCHOSE(mchose.js) 기기의 설정 화면. 화면 자체는 상태 기반 마우스의 공용 화면(status-ui.js)을 쓴다.
import { filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot } from './mchose.js';
import { createStatusUi } from './status-ui.js';

const ui = createStatusUi({
  brand: 'MCHOSE', hub: 'M HUB', filters, catalog, createClient, changes, saveChanges, knownStatus, editableSnapshot,
  backupType: 'gomm-mchose-backup', diagType: 'omm-web-mchose-diagnostics',
  diagDetails: (diag) => [`제품군: ${diag.family}`], // i18n-ignore
  // V3는 DPI 버튼에 「기본값」을 쓸 수 없다
  buttonAllowed: (s, button, option) => !(s.family === 'V3' && button === 'DPI' && option === '기본값'),
});

export { filters, catalog };
export const { state, connected, isDirty, canEdit, ownsDevice, connect, disconnect, refreshBattery, summary, save, revert,
  exportDiagnostics, exportBackup, importBackup, renderProfiles, render } = ui;
