(function (OMM) {
  'use strict';

  const P = OMM.profile;
  const K = OMM.keys;
  const $ = (sel) => document.querySelector(sel);

  // 실기기 데이터로 확인한 (프로필 형식 → 레이아웃): 4는 PRO X Wireless, 5는 G502 X PLUS, 7은 PRO X 2 DEX
  const VERIFIED_LAYOUTS = { 1: 'classic', 2: 'classic', 3: 'classic', 4: 'classic', 5: 'classic', 7: 'extended' };
  const CLASSIC_REPORT_RATES = [[1, '1000 Hz'], [2, '500 Hz'], [4, '250 Hz'], [8, '125 Hz']]; // 값 = 보고 간격(ms)
  const EXTENDED_RATE_INDEXES = [0, 1, 2, 3, 4, 5, 6]; // 값 = 인덱스, 125 << i Hz
  const DEFAULT_DPI_RANGE = { min: 100, max: 25600, step: 50 };
  const ROM_BASE = 0x0100;
  const ISSUE_URL = 'https://github.com/Sunya0804/logitech_omm/issues/new';

  const st = {
    transport: null, hidpp: null, op: null,
    name: '', battery: null, desc: null, dpiRange: DEFAULT_DPI_RANGE, rateIndexes: null, layout: null,
    profiles: [], dirValid: false, crcTrusted: false,
    current: 0, mode: OMM.MODE.ONBOARD,
    selected: 0, tab: 'dpi', layer: 'buttons', unlock: false, busy: false,
  };

  // ---------- DOM 도우미 ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function toast(message, kind = 'info') {
    const el = h('div', { class: 'toast ' + kind }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
  }

  function ask(title, lines, okLabel) {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-body').replaceChildren(...lines.map((l) => h('p', null, l)));
    $('#confirm-ok').textContent = okLabel;
    dlg.showModal();
    // close 이벤트는 탭이 가려져 있으면 늦게 오므로 버튼 제출과 Esc(cancel)를 직접 받는다.
    return new Promise((resolve) => {
      const form = dlg.querySelector('form');
      const finish = (ok) => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('cancel', onCancel);
        resolve(ok);
      };
      const onSubmit = (e) => finish(!!e.submitter && e.submitter.value === 'ok');
      const onCancel = () => finish(false);
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('cancel', onCancel);
    });
  }

  // 기기와 통신하는 작업을 한 번에 하나만 실행하고, 실패하면 알림을 띄운다.
  async function busy(message, fn) {
    if (st.busy) return false;
    st.busy = true;
    const setMsg = (m) => ($('#busy-msg').textContent = m);
    setMsg(message);
    $('#busy').hidden = false;
    try {
      await fn(setMsg);
      return true;
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 'error');
      return false;
    } finally {
      st.busy = false;
      $('#busy').hidden = true;
    }
  }

  // ---------- 연결 / 읽기 ----------

  async function connect(transport) {
    await disconnect();
    const ok = await busy('기기 검색 중…', async (setMsg) => {
      await transport.open();
      st.transport = transport;
      const hidpp = (st.hidpp = new OMM.Hidpp(transport));
      if (!(await hidpp.probe())) {
        throw new Error('HID++ 2.0 기기가 응답하지 않습니다. 무선 기기라면 전원이 켜져 있는지 확인하세요.');
      }
      st.name = (await hidpp.getName()) || transport.name || 'Logitech 기기';
      const featIdx = await hidpp.getFeature(OMM.FEATURE.ONBOARD_PROFILES);
      if (!featIdx) throw new Error(`${st.name}: 온보드 메모리(HID++ 0x8100)를 지원하지 않는 기기입니다.`);
      st.op = new OMM.OnboardProfiles(hidpp, featIdx);
      st.battery = await hidpp.getBattery().catch(() => null);
      st.dpiRange = (await hidpp.getDpiRange().catch(() => null)) || DEFAULT_DPI_RANGE;
      st.rateIndexes = await hidpp.getReportRateIndexes().catch(() => null);
      hidpp.onEvent = (idx, fn, params) => {
        if (idx !== featIdx || fn !== 0) return;
        st.current = (params[0] << 8) | params[1];
        renderSidebar();
      };
      await loadProfiles(setMsg);
    });
    if (!ok) await disconnect();
    render();
  }

  async function disconnect() {
    if (st.transport) await st.transport.close().catch(() => {});
    Object.assign(st, { transport: null, hidpp: null, op: null, desc: null, layout: null, profiles: [], selected: 0, unlock: false });
  }

  async function loadProfiles(setMsg) {
    const op = st.op;
    const d = (st.desc = await op.getDescription());
    st.mode = await op.getMode();
    st.crcTrusted = false;

    // CRC가 맞는 섹터만 돌려준다. 맞는 섹터를 하나라도 읽으면 CRC 구현이 이 기기와 일치함이 확인된다.
    const readValid = async (sector) => {
      try {
        const data = await op.readSector(sector, d.sectorSize);
        if (!P.hasValidCrc(data)) return null;
        st.crcTrusted = true;
        return data;
      } catch (e) {
        if (e instanceof OMM.HidppError) return null;
        throw e;
      }
    };

    setMsg('프로필 목록 읽는 중…');
    const dirSector = await readValid(0x0000);
    const dir = dirSector && P.parseDirectory(dirSector, d.profileCount);
    st.dirValid = !!dir;

    const profiles = [];
    for (let i = 0; i < d.profileCount; i++) {
      setMsg(`프로필 ${i + 1}/${d.profileCount} 읽는 중…`);
      const entry = dir && dir[i];
      let source = 'user';
      let sector = entry ? entry.sector : i + 1;
      let raw = entry ? await readValid(sector) : null;
      if (!raw) {
        // 사용자 영역이 비어 있으면 기기는 ROM(공장 초기값) 프로필을 쓴다.
        source = 'rom';
        sector = ROM_BASE + (i < d.profileCountOob ? i + 1 : 1);
        raw = await readValid(sector);
      }
      const enabled = entry ? entry.enabled : !dir && i < Math.max(1, d.profileCountOob);
      profiles.push({ index: i, sector, source, raw, orig: raw && raw.slice(), enabled: !!raw && enabled, origEnabled: !!raw && enabled });
    }
    st.profiles = profiles;
    const sample = profiles.find((p) => p.raw);
    st.layout = sample ? P.detectLayout(sample.raw, d.profileFormatId, d.buttonCount, st.dpiRange) : null;
    st.current = await op.getCurrentProfile();
    if (st.selected >= profiles.length) st.selected = 0;
    const cur = profiles.findIndex(isCurrent);
    if (cur >= 0) st.selected = cur;
  }

  // ---------- 상태 판정 ----------

  const isCurrent = (p) => (st.current & 0xff) === p.index + 1;
  const isDirty = (p) => !!p.raw && (!P.sameData(p.raw, p.orig) || p.enabled !== p.origEnabled);
  const needsSectorWrite = (p) => !!p.raw && (p.source !== 'user' || p.sector !== p.index + 1 || !P.sameData(p.raw, p.orig));
  const layoutKnown = () => !!st.layout;
  const formatVerified = () => layoutKnown() && VERIFIED_LAYOUTS[st.desc.profileFormatId] === st.layout.id;
  const canEdit = () => st.crcTrusted && layoutKnown() && (formatVerified() || st.unlock);

  function profileTitle(p) {
    const name = p.raw && layoutKnown() ? P.parse(p.raw, st.layout).name : '';
    return name || `프로필 ${p.index + 1}`;
  }

  // ---------- 기기에 쓰는 동작 ----------

  async function save() {
    const dirty = st.profiles.filter(isDirty);
    if (!dirty.length || !canEdit()) return;
    if (!st.profiles.some((p) => p.enabled)) return toast('최소 한 개의 프로필은 사용 상태여야 합니다.', 'error');
    const ok = await ask('기기에 저장', [
      `${dirty.map(profileTitle).join(', ')}의 변경 내용을 ${st.name}의 온보드 메모리에 씁니다.`,
      '쓰는 동안 기기를 분리하거나 전원을 끄지 마세요. 저장 전에 「백업 내보내기」로 현재 상태를 보관해 두는 것을 권장합니다.',
    ], '저장');
    if (!ok) return;

    let reloadFailed = false;
    const done = await busy('저장 중…', async (setMsg) => {
      const { op } = st;
      const writeVerified = async (sector, data, label) => {
        setMsg(`${label} 쓰는 중…`);
        await op.writeSector(sector, data);
        const back = await op.readSector(sector, data.length);
        if (P.toHex(back) !== P.toHex(data)) throw new Error(`${label}: 기록 후 검증에 실패했습니다. 다시 저장해 보세요.`);
      };

      const sectorWrites = st.profiles.filter(needsSectorWrite);
      const dirChanged = !st.dirValid || sectorWrites.some((p) => p.source !== 'user' || p.sector !== p.index + 1)
        || st.profiles.some((p) => p.enabled !== p.origEnabled);

      for (const p of sectorWrites) {
        await writeVerified(p.index + 1, P.finalize(p.raw), profileTitle(p));
        Object.assign(p, { source: 'user', sector: p.index + 1, orig: p.raw.slice() });
      }
      if (dirChanged) {
        await writeVerified(0x0000, P.buildDirectory(st.desc.sectorSize, st.profiles.map((p) => p.enabled)), '프로필 목록');
        st.dirValid = true;
        st.profiles.forEach((p) => (p.origEnabled = p.enabled));
      }

      // 현재 프로필을 다시 지정해야 기기가 새 내용을 불러온다. 호스트 모드에서는 온보드 프로필이
      // 쓰이지 않아 기기가 이 명령을 거부하므로 건너뛴다. 온보드 모드로 바꾸면 그때 불러온다.
      if (st.mode !== OMM.MODE.ONBOARD) return;
      const active = st.profiles.find((p) => isCurrent(p) && p.enabled) || st.profiles.find((p) => p.enabled);
      try {
        await op.setCurrentProfile(active.index + 1);
        st.current = active.index + 1;
      } catch (e) {
        // 기록과 검증은 이미 끝났으므로 저장 실패로 취급하지 않는다.
        if (!(e instanceof OMM.HidppError)) throw e;
        reloadFailed = true;
      }
    });
    if (done && st.mode !== OMM.MODE.ONBOARD) toast('저장했습니다. 기기가 호스트 모드라서, 온보드 메모리 모드로 바꿔야 적용됩니다.', 'ok');
    else if (done && reloadFailed) toast('저장했습니다. 기기가 프로필 다시 불러오기를 거부했으니, 마우스를 껐다 켜면 적용됩니다.', 'ok');
    else if (done) toast('저장했습니다.', 'ok');
    render();
  }

  function revert() {
    for (const p of st.profiles) {
      if (p.raw) p.raw.set(p.orig);
      p.enabled = p.origEnabled;
    }
    render();
  }

  async function activate(p) {
    await busy('프로필 전환 중…', async () => {
      await st.op.setCurrentProfile(p.sector);
      st.current = await st.op.getCurrentProfile();
    });
    render();
  }

  async function setMode(mode) {
    await busy('모드 변경 중…', async () => {
      await st.op.setMode(mode);
      st.mode = await st.op.getMode();
      st.current = await st.op.getCurrentProfile();
    });
    render();
  }

  // ---------- 백업 ----------

  function exportBackup() {
    const { desc } = st;
    const backup = {
      type: 'omm-web-backup', version: 1, device: st.name, exportedAt: new Date().toISOString(),
      profileFormatId: desc.profileFormatId, sectorSize: desc.sectorSize,
      profiles: st.profiles.map((p) => ({ index: p.index, enabled: p.enabled, data: p.raw ? P.toHex(P.finalize(p.raw.slice())) : null })),
    };
    download(backup, 'profiles');
  }

  function download(data, suffix) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `${st.name.replace(/[^\w-]+/g, '_')}-${suffix}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 새 기기 지원을 위한 읽기 전용 덤프: 기능 목록과 온보드 메모리의 모든 섹터.
  async function exportDiagnostics() {
    const ok = await ask('진단 정보 내보내기', [
      '기기의 기능 목록과 온보드 메모리 전체(프로필, 버튼 할당, 매크로 포함)를 읽어 파일로 저장합니다. 기기에는 아무것도 쓰지 않습니다.',
      '매크로에 입력해 둔 문구가 있다면 파일에 그대로 들어가니, 공유하기 전에 확인하세요.',
    ], '내보내기');
    if (!ok) return;
    let diag;
    const done = await busy('진단 정보 읽는 중…', async (setMsg) => {
      const { hidpp, op, desc } = st;
      const hex4 = (n) => n.toString(16).padStart(4, '0');
      const descRaw = P.toHex(await hidpp.request(op.idx, 0x0));
      const sectors = {};
      const romCount = Math.max(1, desc.profileCountOob);
      const numbers = [...Array(desc.sectorCount).keys(), ...Array.from({ length: romCount }, (_, i) => ROM_BASE + i + 1)];
      for (const n of numbers) {
        setMsg(`섹터 0x${hex4(n)} 읽는 중…`);
        try {
          sectors[hex4(n)] = P.toHex(await op.readSector(n, desc.sectorSize));
        } catch (e) {
          if (!(e instanceof OMM.HidppError)) throw e;
          sectors[hex4(n)] = `error: ${e.message}`;
        }
      }
      diag = {
        type: 'omm-web-diagnostics', version: 1, exportedAt: new Date().toISOString(),
        device: st.name, deviceIndex: hidpp.devIdx,
        features: (await hidpp.getFeatureList()).map((f) => `${f.index}:${hex4(f.id)}`),
        onboard: { ...desc, descriptionRaw: descRaw, mode: st.mode, currentProfile: hex4(await op.getCurrentProfile()) },
        dpiRange: st.dpiRange, reportRateIndexes: st.rateIndexes,
        detectedLayout: st.layout ? st.layout.id : null,
        sectors,
      };
    });
    if (!done) return;
    download(diag, 'diagnostics');
    const send = await ask('진단 정보 보내기', [
      '진단 파일을 저장했습니다. 이 기기를 지원 목록에 추가할 수 있도록 GitHub 이슈로 보내시겠어요?',
      'GitHub 계정이 필요합니다. 열리는 이슈 작성 화면에 방금 저장한 파일을 끌어다 놓고 등록하면 됩니다. 이슈는 누구나 볼 수 있습니다.',
    ], '이슈 작성 화면 열기');
    if (!send) return;
    const body = [
      `기기: ${diag.device}`,
      `프로필 형식: ${diag.onboard.profileFormatId} (${diag.detectedLayout || '알 수 없는 구조'})`,
      '',
      '아래에 진단 파일(.json)을 끌어다 놓아 첨부해 주세요.',
      '',
      '추가로 알려 줄 내용(잘못 표시되는 값, G HUB에서 바꾼 설정 등):',
    ].join('\n');
    window.open(`${ISSUE_URL}?title=${encodeURIComponent(`[진단] ${diag.device}`)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  }

  async function importBackup(file) {
    try {
      const b = JSON.parse(await file.text());
      if (b.type !== 'omm-web-backup' || !Array.isArray(b.profiles)) throw new Error('OMM 웹 백업 파일이 아닙니다.');
      if (b.profileFormatId !== st.desc.profileFormatId || b.sectorSize !== st.desc.sectorSize) {
        throw new Error(`이 기기와 호환되지 않는 백업입니다 (${b.device || '알 수 없는 기기'}).`);
      }
      const loaded = b.profiles.filter((e) => st.profiles[e.index] && e.data).map((e) => {
        const data = P.fromHex(e.data);
        if (data.length !== st.desc.sectorSize || !P.hasValidCrc(data)) throw new Error(`프로필 ${e.index + 1}의 백업 데이터가 손상되었습니다.`);
        return [st.profiles[e.index], data, !!e.enabled];
      });
      for (const [p, data, enabled] of loaded) {
        if (p.raw) p.raw.set(data);
        else Object.assign(p, { raw: data, orig: new Uint8Array(data.length), source: 'rom' });
        p.enabled = enabled;
      }
      toast(`프로필 ${loaded.length}개를 불러왔습니다. 「기기에 저장」을 눌러야 기기에 반영됩니다.`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
    render();
  }

  // ---------- 렌더링 ----------

  function render() {
    const connected = !!st.desc;
    $('#welcome').hidden = connected;
    $('#workspace').hidden = !connected;
    $('#actionbar').hidden = !connected;
    $('#btn-disconnect').hidden = !connected;
    renderDeviceBar();
    if (!connected) return;
    renderSidebar();
    renderEditor();
    renderActionBar();
  }

  function renderDeviceBar() {
    const bar = $('#device');
    if (!st.desc) return bar.replaceChildren();
    const b = st.battery;
    bar.replaceChildren(
      h('strong', null, st.name),
      b && h('span', { class: 'chip' }, `배터리 ${b.percent}%${b.charging ? ' ⚡' : ''}`),
      h('label', { class: 'chip' }, '모드 ',
        h('select', { onchange: (e) => setMode(Number(e.target.value)) },
          h('option', { value: OMM.MODE.ONBOARD, selected: st.mode === OMM.MODE.ONBOARD }, '온보드 메모리'),
          h('option', { value: OMM.MODE.HOST, selected: st.mode !== OMM.MODE.ONBOARD }, '호스트(소프트웨어)'))),
    );
  }

  function renderSidebar() {
    if (!st.desc) return;
    const romActive = st.current >= ROM_BASE;
    $('#sidebar').replaceChildren(
      h('h2', null, '프로필'),
      ...st.profiles.map((p) => h('div', {
        class: 'profile' + (p.index === st.selected ? ' selected' : '') + (p.enabled ? '' : ' off'),
        onclick: () => { st.selected = p.index; render(); },
      },
        h('div', { class: 'profile-main' },
          h('span', { class: 'profile-name' }, profileTitle(p), isDirty(p) && h('span', { class: 'dot', title: '저장되지 않은 변경' })),
          h('span', { class: 'profile-sub' },
            !p.raw ? '읽을 수 없음' : [
              isCurrent(p) ? (romActive ? '사용 중 (ROM)' : '사용 중') : p.enabled ? '사용' : '사용 안 함',
              p.source === 'rom' ? ' · 초기값' : '',
            ].join(''))),
        h('input', {
          type: 'checkbox', title: '프로필 사용', checked: p.enabled, disabled: !p.raw || !canEdit(),
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => { p.enabled = e.target.checked; render(); },
        }))),
    );
  }

  function renderActionBar() {
    const n = st.profiles.filter(isDirty).length;
    $('#dirty-count').textContent = n ? `저장되지 않은 변경: 프로필 ${n}개` : '변경 사항 없음';
    $('#btn-save').disabled = !n || !canEdit();
    $('#btn-revert').disabled = !n;
    $('#btn-import').disabled = !canEdit();
  }

  // 편집으로 값이 바뀐 뒤 호출. 포커스를 잃지 않도록 편집 영역은 필요할 때만 다시 그린다.
  function touched(rerenderEditor) {
    renderSidebar();
    renderActionBar();
    if (rerenderEditor) renderEditor();
  }

  function renderEditor() {
    const p = st.profiles[st.selected];
    const root = $('#editor');
    const notices = [];
    if (!st.crcTrusted) {
      notices.push('기기에서 체크섬이 맞는 프로필을 하나도 읽지 못했습니다. 안전을 위해 편집과 저장을 막았습니다.');
    } else if (!layoutKnown()) {
      notices.push(`이 기기의 프로필 형식(${st.desc.profileFormatId})은 알려진 어떤 구조로도 해석되지 않아 편집할 수 없습니다.`);
    } else if (!formatVerified()) {
      notices.push(h('label', null,
        h('input', { type: 'checkbox', checked: st.unlock, onchange: (e) => { st.unlock = e.target.checked; render(); } }),
        ` 이 기기의 프로필 형식(${st.desc.profileFormatId})은 검증되지 않았습니다. 값이 잘못 해석될 수 있음을 이해하고 편집을 허용합니다. 먼저 백업을 내보내세요.`));
    }
    if (st.mode !== OMM.MODE.ONBOARD) {
      notices.push('기기가 호스트 모드입니다. 온보드 프로필은 온보드 메모리 모드에서만 적용됩니다. G HUB가 실행 중이면 기기를 호스트 모드로 되돌리니 먼저 종료하세요.');
    }

    const tabs = [['dpi', '감도 (DPI)'], ['buttons', '버튼 할당'], ['info', '기기 정보']];
    const body = st.tab === 'info' ? renderInfo(p)
      : !p.raw ? h('p', { class: 'empty' }, '이 프로필은 기기에서 읽을 수 없습니다.')
      : !layoutKnown() ? h('p', { class: 'empty' }, '알 수 없는 프로필 형식입니다.')
      : st.tab === 'dpi' ? renderDpi(p) : renderButtons(p);

    root.replaceChildren(
      ...notices.map((n) => h('div', { class: 'notice' }, n)),
      h('div', { class: 'editor-head' },
        h('h2', null, profileTitle(p)),
        // 기기에 저장된 상태 그대로인 프로필만 바로 전환할 수 있다.
        p.raw && !isCurrent(p) && p.origEnabled && !isDirty(p) && st.mode === OMM.MODE.ONBOARD
          && h('button', { onclick: () => activate(p) }, '이 프로필로 전환')),
      h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', {
        class: id === st.tab ? 'active' : '', onclick: () => { st.tab = id; renderEditor(); },
      }, label))),
      h('div', { class: 'panel' }, body),
    );
  }

  // 기기가 지원하는 DPI 값으로 맞춘다. 구간마다 간격이 다를 수 있다.
  function snapDpi(v) {
    const { min, max, step, segments } = st.dpiRange;
    v = Math.min(max, Math.max(min, v));
    const seg = (segments || []).find((s) => v <= s.to);
    return seg ? Math.min(seg.to, seg.from + Math.round((v - seg.from) / seg.step) * seg.step)
      : Math.min(max, Math.round((v - min) / step) * step + min);
  }

  function reportRateField(p, m, ro) {
    const L = st.layout;
    const options = L.id === 'classic' ? [...CLASSIC_REPORT_RATES]
      : (st.rateIndexes || EXTENDED_RATE_INDEXES).map((i) => [i, `${125 << i} Hz`]).reverse();
    const uniform = m.reportRates.every((r) => r === m.reportRates[0]);
    const cur = uniform ? m.reportRates[0] : -1;
    // 연결 방식별 보고율이 서로 다르게 저장돼 있으면 바꾸기 전까지 그대로 둔다.
    if (!uniform) options.unshift([-1, `연결 방식별 설정 유지 (${m.reportRates.join(' / ')})`]);
    else if (!options.some(([v]) => v === cur)) options.push([cur, `기타 (${cur})`]);
    return h('div', { class: 'field' },
      h('label', null, '보고율'),
      h('select', {
        disabled: ro,
        onchange: (e) => { if (Number(e.target.value) >= 0) P.setReportRate(p.raw, L, Number(e.target.value)); touched(true); },
      }, options.map(([v, label]) => h('option', { value: v, selected: v === cur }, label))));
  }

  function renderDpi(p) {
    const ro = !canEdit();
    const L = st.layout;
    const { min, max, step } = st.dpiRange;
    const m = P.parse(p.raw, L);
    const slots = m.dpi.map((entry, slot) => ({ entry, slot })).filter((s) => s.entry);
    const stages = slots.map((s) => ({ ...s.entry }));
    let def = Math.max(0, slots.findIndex((s) => s.slot === m.defaultDpi));
    let shift = Math.max(0, slots.findIndex((s) => s.slot === m.shiftDpi));
    const commit = (rerender) => { P.setDpi(p.raw, L, stages, def, shift); touched(rerender); };
    const setStage = (i, v) => { stages[i].x = stages[i].y = v; };

    const rows = stages.map((stage, i) => {
      const number = h('input', {
        type: 'number', min, max, step, value: stage.x, disabled: ro,
        onchange: (e) => { setStage(i, snapDpi(Number(e.target.value) || min)); commit(true); },
      });
      return h('div', { class: 'dpi-row' },
        h('span', { class: 'dpi-idx' }, `${i + 1}단계`),
        h('input', {
          type: 'range', min, max, step, value: stage.x, disabled: ro,
          oninput: (e) => { setStage(i, snapDpi(Number(e.target.value))); number.value = stages[i].x; commit(false); },
        }),
        number,
        h('label', null, h('input', { type: 'radio', name: 'dpi-def', checked: i === def, disabled: ro, onchange: () => { def = i; commit(false); } }), ' 기본'),
        h('label', null, h('input', { type: 'radio', name: 'dpi-shift', checked: i === shift, disabled: ro, onchange: () => { shift = i; commit(false); } }), ' 시프트'),
        h('button', {
          class: 'ghost', title: '단계 삭제', disabled: ro || stages.length <= 1,
          onclick: () => {
            stages.splice(i, 1);
            const fix = (idx) => (idx === i ? 0 : idx > i ? idx - 1 : idx);
            def = fix(def);
            shift = fix(shift);
            commit(true);
          },
        }, '✕'));
    });

    return h('div', null,
      L.name !== null && h('div', { class: 'field' },
        h('label', null, '프로필 이름'),
        h('input', {
          type: 'text', maxlength: P.NAME_CHARS, value: m.name, placeholder: `프로필 ${p.index + 1}`, disabled: ro,
          oninput: (e) => { P.setName(p.raw, L, e.target.value); touched(false); },
          onchange: () => renderEditor(),
        })),
      reportRateField(p, m, ro),
      h('h3', null, `DPI 단계 (${min}~${max})`),
      rows,
      h('button', {
        disabled: ro || stages.length >= P.DPI_SLOTS,
        onclick: () => { stages.push({ ...stages[stages.length - 1] }); commit(true); },
      }, '+ 단계 추가'),
      h('p', { class: 'hint' }, '시프트: 「DPI 시프트」 버튼을 누르고 있는 동안 적용되는 단계입니다.'),
      L.id === 'extended' && h('p', { class: 'hint' }, '이 기기의 프로필 형식에서는 프로필 이름을 편집할 수 없습니다. 가로·세로 DPI는 같은 값으로 설정되며 리프트오프 거리는 기존 값을 유지합니다.'));
  }

  function renderButtons(p) {
    const ro = !canEdit();
    const count = Math.min(st.desc.buttonCount, P.MAX_BUTTONS);
    const L = st.layout;
    const hasGShift = st.desc.hasGShift && L.gshift !== null;
    const layer = hasGShift ? st.layer : 'buttons';

    const row = (i) => {
      const bytes = P.getBinding(p.raw, L, layer, i);
      const a = P.decodeBinding(bytes);
      const apply = (action) => { P.setBinding(p.raw, L, layer, i, P.encodeBinding(action)); touched(true); };
      const editable = ['mouse', 'key', 'consumer', 'special', 'disabled'];
      const kinds = [['mouse', '마우스 버튼'], ['key', '키보드'], ['consumer', '미디어'], ['special', '특수 기능'], ['disabled', '사용 안 함']];
      if (!editable.includes(a.kind)) kinds.push([a.kind, a.kind === 'macro' ? '매크로 (편집 불가)' : '기타 (편집 불가)']);
      const defaults = {
        mouse: { kind: 'mouse', mask: 1 }, key: { kind: 'key', mods: 0, usage: 0 },
        consumer: { kind: 'consumer', usage: 0xcd }, special: { kind: 'special', code: 0x05 }, disabled: { kind: 'disabled' },
      };

      let detail = null;
      if (a.kind === 'mouse') {
        const bit = Math.max(0, Math.log2(a.mask & -a.mask) | 0);
        detail = h('select', { disabled: ro, onchange: (e) => apply({ kind: 'mouse', mask: 1 << Number(e.target.value) }) },
          [...Array(16).keys()].map((b) => h('option', { value: b, selected: b === bit }, K.mouseButtonName(b))));
      } else if (a.kind === 'special' || a.kind === 'consumer') {
        const table = a.kind === 'special' ? K.SPECIALS : K.CONSUMER;
        const cur = a.kind === 'special' ? a.code : a.usage;
        const codes = Object.keys(table).map(Number);
        if (!codes.includes(cur)) codes.push(cur);
        detail = h('select', {
          disabled: ro,
          onchange: (e) => apply(a.kind === 'special' ? { kind: 'special', code: Number(e.target.value) } : { kind: 'consumer', usage: Number(e.target.value) }),
        }, codes.map((c) => h('option', { value: c, selected: c === cur }, K.describe(a.kind === 'special' ? { kind: 'special', code: c } : { kind: 'consumer', usage: c }))));
      } else if (a.kind === 'key') {
        const keyLabel = a.usage ? K.keyName(0, a.usage) : '키 지정';
        detail =h('span', { class: 'key-edit' },
          K.MODIFIERS.map(([bit, name]) => h('label', null,
            h('input', {
              type: 'checkbox', checked: !!(a.mods & (bit | (bit << 4))), disabled: ro,
              onchange: (e) => apply({ kind: 'key', usage: a.usage, mods: e.target.checked ? a.mods | bit : a.mods & ~(bit | (bit << 4)) }),
            }), ' ' + name)),
          h('button', {
            disabled: ro, class: 'capture',
            onclick: (e) => { e.target.textContent = '키를 누르세요…'; e.target.classList.add('armed'); },
            onblur: (e) => { e.target.textContent = keyLabel; e.target.classList.remove('armed'); },
            onkeydown: (e) => {
              if (!e.target.classList.contains('armed')) return;
              e.preventDefault();
              if (K.MODIFIER_CODES.includes(e.code)) return;
              const usage = K.CODE_TO_USAGE[e.code];
              if (!usage) return toast(`지원하지 않는 키입니다: ${e.code}`, 'error');
              const mods = (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
              apply({ kind: 'key', mods, usage });
            },
          }, keyLabel));
      }

      return h('tr', null,
        h('td', { class: 'btn-idx' }, `버튼 ${i + 1}`),
        h('td', { class: 'btn-desc' }, K.describe(a, bytes)),
        h('td', null, h('select', { disabled: ro, onchange: (e) => apply(defaults[e.target.value]) },
          kinds.map(([kind, label]) => h('option', { value: kind, selected: kind === a.kind, disabled: !editable.includes(kind) }, label)))),
        h('td', null, detail));
    };

    return h('div', null,
      hasGShift && h('div', { class: 'segmented' },
        [['buttons', '기본'], ['gshift', 'G-Shift']].map(([id, label]) => h('button', {
          class: id === layer ? 'active' : '', onclick: () => { st.layer = id; renderEditor(); },
        }, label))),
      h('table', { class: 'buttons' },
        h('thead', null, h('tr', null, ['버튼', '현재 동작', '종류', '설정'].map((t) => h('th', null, t)))),
        h('tbody', null, [...Array(count).keys()].map(row))),
      h('p', { class: 'hint' }, '버튼 번호는 기기 내부 순서입니다. 보통 1=왼쪽, 2=오른쪽, 3=휠 클릭 순이며 나머지는 기기마다 다릅니다.'),
      st.desc.hasGShift && !hasGShift && h('p', { class: 'hint' }, '이 기기의 프로필 형식에서는 G-Shift 할당을 편집할 수 없습니다. 기존 값은 그대로 유지됩니다.'));
  }

  function renderInfo(p) {
    const d = st.desc;
    const rows = [
      ['기기', st.name],
      ['프로필 형식', `${d.profileFormatId} · ${!layoutKnown() ? '알 수 없는 구조' : st.layout.id === 'classic' ? '기본 구조' : '확장 구조'}${formatVerified() ? '' : ' (미검증)'}`],
      ['메모리 모델 / 매크로 형식', `${d.memoryModelId} / ${d.macroFormatId}`],
      ['프로필 수 (초기 활성)', `${d.profileCount} (${d.profileCountOob})`],
      ['버튼 수', d.buttonCount],
      ['섹터', `${d.sectorCount}개 × ${d.sectorSize}바이트`],
      ['G-Shift / DPI 시프트', `${d.hasGShift ? '지원' : '미지원'} / ${d.hasDpiShift ? '지원' : '미지원'}`],
      ['프로필 목록(디렉터리)', st.dirValid ? '정상' : '비어 있음 (ROM 프로필 사용 중)'],
      ['선택한 프로필 위치', `섹터 0x${p.sector.toString(16).padStart(4, '0')} (${p.source === 'rom' ? 'ROM' : '사용자 영역'})`],
    ];
    return h('table', { class: 'info' }, rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, String(v)))));
  }

  // ---------- 초기화 ----------

  function init() {
    const supported = 'hid' in navigator;
    $('#unsupported').hidden = supported;
    for (const btn of document.querySelectorAll('.btn-connect')) {
      btn.disabled = !supported;
      btn.addEventListener('click', async () => {
        try {
          const transport = await OMM.WebHidTransport.request();
          if (transport) await connect(transport);
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
    $('#btn-disconnect').addEventListener('click', async () => { await disconnect(); render(); });
    $('#btn-save').addEventListener('click', save);
    $('#btn-revert').addEventListener('click', revert);
    $('#btn-export').addEventListener('click', exportBackup);
    $('#btn-diagnostics').addEventListener('click', exportDiagnostics);
    $('#btn-import').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      if (e.target.files[0]) importBackup(e.target.files[0]);
      e.target.value = '';
    });
    if (supported) {
      navigator.hid.addEventListener('disconnect', async (e) => {
        if (!st.transport || !st.transport.devices || !st.transport.devices.includes(e.device)) return;
        await disconnect();
        render();
        toast('기기 연결이 끊어졌습니다.', 'error');
      });
    }
    window.addEventListener('beforeunload', (e) => {
      if (st.profiles.some(isDirty)) e.preventDefault();
    });
    render();
  }

  // 개발용: 콘솔에서 js/mock.js의 가상 기기를 OMM.connect(new OMM.MockTransport())로 연결할 수 있다.
  OMM.state = st;
  OMM.connect = connect;
  init();
})(window.OMM);
