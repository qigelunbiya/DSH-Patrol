window.__ModuleLoader__.load({ id: 'dsh-patrol-client-host', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react');

  const PATROL_TOOL = /^patrol_/u;
  const PATROL_PRESET_ID = 'patrol';
  const DASHBOARD_UI = '/patrol-browser-bridge/dashboard/ui';
  const TOTP_TAB_ID = 'dsh-patrol:totp';
  const TOTP_ENTRY_SELECTOR = '[data-dsh-patrol-token-entry]';
  const TOTP_OPEN_EVENT = 'dsh-patrol:open-token-manager';
  const TOTP_API_ROOT = '/patrol-browser-bridge/totp';
  const BORDER = 'var(--dsh-color-border, rgba(127,127,127,.24))';
  const TEXT = 'var(--dsh-color-text, #172033)';
  const MUTED = 'var(--dsh-color-text-secondary, #667085)';
  const BG = 'var(--dsh-color-bg, #fff)';
  const CARD = { border: `1px solid ${BORDER}`, borderRadius: '12px', background: BG, padding: '14px 16px' };
  const BUTTON = { border: `1px solid ${BORDER}`, borderRadius: '9px', background: BG, color: TEXT, height: '34px', padding: '0 11px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 };
  const INPUT = { width: '100%', height: '36px', boxSizing: 'border-box', border: `1px solid ${BORDER}`, borderRadius: '9px', background: BG, color: TEXT, padding: '0 10px', fontSize: '12px' };

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || '操作失败');
  }

  function TokenIcon({ size = 16 }) {
    return React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.45, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    },
    React.createElement('circle', { cx: 8, cy: 8, r: 5.5 }),
    React.createElement('path', { d: 'M8 4.5v3.75l2.35 1.55' }),
    React.createElement('path', { d: 'M5.4 1.55h5.2' }));
  }

  async function loadTotpSession() {
    const response = await fetch(`${TOTP_API_ROOT}/session`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || typeof payload.csrf !== 'string') throw new Error(payload?.error || '无法读取 TOTP 管理会话');
    return payload;
  }

  async function totpPost(action, csrf, body) {
    if (!csrf) throw new Error('TOTP 管理会话尚未就绪');
    const response = await fetch(`${TOTP_API_ROOT}/${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-patrol-csrf': csrf },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `TOTP ${action} failed`);
    return payload;
  }

  function profileIdFromOtpAuth(uri) {
    try {
      const url = new URL(uri);
      const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const issuer = url.searchParams.get('issuer') || label.split(':')[0] || '';
      const account = label.includes(':') ? label.slice(label.indexOf(':') + 1) : label;
      return `${issuer}-${account}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || `token-${Date.now().toString(36)}`;
    } catch {
      return `token-${Date.now().toString(36)}`;
    }
  }

  function TokenManager({ embedded = false }) {
    const [csrf, setCsrf] = React.useState('');
    const [profiles, setProfiles] = React.useState([]);
    const [profileId, setProfileId] = React.useState('');
    const [uri, setUri] = React.useState('');
    const [status, setStatus] = React.useState('正在读取本机令牌配置…');
    const [statusError, setStatusError] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const fileRef = React.useRef(null);

    const reload = React.useCallback(async () => {
      try {
        const payload = await loadTotpSession();
        setCsrf(payload.csrf);
        const next = Array.isArray(payload.profiles) ? payload.profiles : [];
        setProfiles(next);
        setStatus(`已加载 ${next.length} 个令牌配置。`);
        setStatusError(false);
      } catch (error) {
        setStatus(errorMessage(error));
        setStatusError(true);
      }
    }, []);

    React.useEffect(() => { reload(); }, [reload]);

    const importProfile = async () => {
      const id = profileId.trim();
      const value = uri.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) { setStatus('Profile ID 格式不正确。'); setStatusError(true); return; }
      if (!/^otpauth:\/\/totp\//i.test(value)) { setStatus('请输入有效的 otpauth://totp/... URI。'); setStatusError(true); return; }
      setBusy(true);
      try {
        const payload = await totpPost('import', csrf, { profileId: id, uri: value });
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setUri('');
        setStatus(`令牌 ${id} 已安全导入。`);
        setStatusError(false);
      } catch (error) {
        setUri('');
        setStatus(errorMessage(error));
        setStatusError(true);
      } finally { setBusy(false); }
    };

    const removeProfile = async (id) => {
      if (!window.confirm(`删除令牌配置 ${id}？`)) return;
      setBusy(true);
      try {
        const payload = await totpPost('delete', csrf, { profileId: id });
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setStatus(`已删除 ${id}。`);
        setStatusError(false);
      } catch (error) {
        setStatus(errorMessage(error));
        setStatusError(true);
      } finally { setBusy(false); }
    };

    const readQrImage = async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { setStatus('二维码图片不能超过 8 MiB。'); setStatusError(true); return; }
      if (typeof window.BarcodeDetector !== 'function') { setStatus('当前 Chromium 不支持 BarcodeDetector，请直接粘贴 otpauth URI。'); setStatusError(true); return; }
      let bitmap;
      setBusy(true);
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        bitmap = await createImageBitmap(file);
        const codes = await detector.detect(bitmap);
        const raw = codes.map(item => String(item.rawValue || '')).find(value => /^otpauth:\/\/totp\//i.test(value));
        if (!raw) throw new Error('图片中没有识别到普通 TOTP 二维码');
        setUri(raw);
        if (!profileId.trim()) setProfileId(profileIdFromOtpAuth(raw));
        setStatus('二维码识别成功，确认 Profile ID 后点击导入。');
        setStatusError(false);
      } catch (error) {
        setUri('');
        setStatus(errorMessage(error));
        setStatusError(true);
      } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
        setBusy(false);
      }
    };

    return React.createElement('div', { style: { height: embedded ? '100%' : 'auto', overflow: embedded ? 'auto' : 'visible', padding: embedded ? '18px' : '0', boxSizing: 'border-box', color: TEXT } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', marginBottom: '14px' } },
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: '18px', fontWeight: 720 } }, '令牌'),
          React.createElement('div', { style: { color: MUTED, fontSize: '12px', marginTop: '5px' } }, '管理 Patrol 自动登录使用的 TOTP 动态口令配置。'),
        ),
        React.createElement('button', { type: 'button', style: BUTTON, disabled: busy, onClick: reload }, '刷新'),
      ),
      React.createElement('div', { style: { ...CARD, color: MUTED, fontSize: '12px', lineHeight: 1.65, marginBottom: '10px' } }, 'TOTP seed 使用 Patrol vault 加密保存在本机；界面和巡检日志不会显示 seed 或当前动态码。'),
      React.createElement('div', { role: statusError ? 'alert' : 'status', style: { minHeight: '20px', color: statusError ? '#dc2626' : MUTED, fontSize: '12px', marginBottom: '10px' } }, status),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, margin: '10px 0 8px' } }, '已配置令牌'),
      profiles.length === 0
        ? React.createElement('div', { style: { ...CARD, color: MUTED, fontSize: '12px', marginBottom: '14px' } }, '还没有配置 TOTP 令牌。')
        : React.createElement('div', { style: { display: 'grid', gap: '8px', marginBottom: '16px' } }, profiles.map(profile => React.createElement('div', { key: profile.id, style: { ...CARD, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' } }, profile.issuer || profile.label || profile.id),
            React.createElement('div', { style: { color: MUTED, fontSize: '11px', marginTop: '3px' } }, `${profile.account || ''} · ${profile.id} · ${profile.digits || 6}位/${profile.period || 30}s`),
          ),
          React.createElement('button', { type: 'button', style: BUTTON, disabled: busy, onClick: () => removeProfile(profile.id) }, '删除'),
        ))),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, margin: '10px 0 8px' } }, '导入令牌'),
      React.createElement('input', { value: profileId, onChange: event => setProfileId(event.target.value), disabled: busy, placeholder: 'Profile ID，例如 anheng-ops', autoComplete: 'off', style: INPUT }),
      React.createElement('input', { value: uri, onChange: event => setUri(event.target.value), disabled: busy, placeholder: '粘贴 otpauth://totp/...', type: 'password', autoComplete: 'off', spellCheck: false, style: { ...INPUT, marginTop: '8px' }, 'data-dsh-patrol-totp-uri': 'true' }),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } },
        React.createElement('button', { type: 'button', style: BUTTON, disabled: busy || !csrf, onClick: importProfile }, busy ? '处理中…' : '导入'),
        React.createElement('button', { type: 'button', style: BUTTON, disabled: busy, onClick: () => fileRef.current?.click() }, '识别二维码图片'),
        React.createElement('input', { ref: fileRef, type: 'file', accept: 'image/*', hidden: true, onChange: readQrImage }),
      ),
    );
  }

  function setTokenEntryActive(active) {
    const entry = typeof document === 'undefined' ? null : document.querySelector(TOTP_ENTRY_SELECTOR);
    if (!(entry instanceof HTMLElement)) return;
    if (active) entry.setAttribute('data-active', 'true'); else entry.removeAttribute('data-active');
  }

  function TokenBetterSidebarTab() {
    React.useEffect(() => { setTokenEntryActive(true); return () => setTokenEntryActive(false); }, []);
    return React.createElement(TokenManager, { embedded: true });
  }

  function TokenDialogBridge({ openTokenTab }) {
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => {
      const onOpen = () => { if (!(typeof openTokenTab === 'function' && openTokenTab())) setOpen(true); };
      window.addEventListener(TOTP_OPEN_EVENT, onOpen);
      return () => window.removeEventListener(TOTP_OPEN_EVENT, onOpen);
    }, [openTokenTab]);
    React.useEffect(() => { setTokenEntryActive(open); return () => { if (open) setTokenEntryActive(false); }; }, [open]);
    if (!open) return null;
    return React.createElement('div', { role: 'presentation', onMouseDown: event => { if (event.target === event.currentTarget) setOpen(false); }, style: { position: 'fixed', inset: 0, zIndex: 10050, display: 'grid', placeItems: 'center', padding: '20px', background: 'rgba(15,23,42,.42)' } },
      React.createElement('section', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '令牌管理', style: { width: 'min(720px, calc(100vw - 40px))', maxHeight: 'min(820px, calc(100vh - 40px))', overflow: 'auto', border: `1px solid ${BORDER}`, borderRadius: '15px', background: BG, boxShadow: '0 24px 80px rgba(0,0,0,.28)', padding: '20px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' } }, React.createElement('button', { type: 'button', style: BUTTON, onClick: () => setOpen(false) }, '关闭')),
        React.createElement(TokenManager, null),
      ),
    );
  }

  function installTokenEntryStyles() {
    if (typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.setAttribute('data-dsh-patrol-token-entry-style', 'true');
    style.textContent = `${TOTP_ENTRY_SELECTOR}{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 10px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,var(--dsh-color-text-secondary,#667085));cursor:pointer;font-size:13px;text-align:left}${TOTP_ENTRY_SELECTOR}:hover,${TOTP_ENTRY_SELECTOR}[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,var(--dsh-color-text,inherit))}${TOTP_ENTRY_SELECTOR}[data-rail]{justify-content:center;padding:0}${TOTP_ENTRY_SELECTOR}[data-rail] .dsh-patrol-token-label{display:none}`;
    document.head.appendChild(style);
    return () => style.remove();
  }

  function sidebarRoot() {
    const column = typeof document === 'undefined' ? null : document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
    if (!(column instanceof HTMLElement)) return undefined;
    const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
    return logoOwner instanceof HTMLElement ? logoOwner : (column.firstElementChild instanceof HTMLElement ? column.firstElementChild : undefined);
  }

  function mountTokenSidebarEntry() {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
    const disposeStyle = installTokenEntryStyles();
    const entry = document.createElement('button');
    entry.type = 'button'; entry.setAttribute('data-dsh-patrol-token-entry', ''); entry.setAttribute('data-dsh-plugin', 'patrol-token'); entry.setAttribute('data-dsh-part', 'sidebar-entry'); entry.title = '令牌';
    entry.innerHTML = '<span style="display:inline-flex;width:22px;justify-content:center"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v3.75l2.35 1.55"/></svg></span><span class="dsh-patrol-token-label">令牌</span>';
    entry.addEventListener('click', () => window.dispatchEvent(new Event(TOTP_OPEN_EVENT)));
    let root;
    const place = () => {
      root = sidebarRoot();
      if (!root) return;
      const ssh = root.querySelector('[data-dsh-ssh-entry]');
      if (ssh instanceof HTMLElement && ssh.parentElement === root) root.insertBefore(entry, ssh.nextElementSibling);
      else {
        const button = root.querySelector('button[class*="newSession"]') || Array.from(root.children).find(child => child instanceof HTMLButtonElement);
        if (button instanceof HTMLElement) root.insertBefore(entry, button.nextElementSibling);
      }
      if (root.getBoundingClientRect().width <= 88) entry.setAttribute('data-rail', 'true'); else entry.removeAttribute('data-rail');
    };
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', place);
    place();
    return () => { observer.disconnect(); window.removeEventListener('resize', place); entry.remove(); disposeStyle(); };
  }

  function registerTokenSurfaces(ctx) {
    let betterSidebar = null;
    ctx.inject(['betterSidebar'], scope => {
      const service = scope.get?.('betterSidebar') ?? scope.betterSidebar;
      if (!service || typeof service.registerTab !== 'function') return;
      betterSidebar = service;
      scope.effect(() => service.registerTab({ id: TOTP_TAB_ID, title: () => '令牌', icon: size => React.createElement(TokenIcon, { size }), order: 46, single: true, component: TokenBetterSidebarTab }), 'dsh-patrol-client-host: Better Sidebar token tab');
      scope.effect(() => () => { if (betterSidebar === service) betterSidebar = null; }, 'dsh-patrol-client-host: clear Better Sidebar token handle');
    });
    const footerDispose = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'dsh-patrol-token-bridge', order: 1000,
      inject: () => ({ openTokenTab: () => {
        if (!betterSidebar || typeof betterSidebar.openTab !== 'function') return false;
        try { betterSidebar.openTab({ type: TOTP_TAB_ID, title: '令牌' }); return true; } catch { return false; }
      } }),
    }, TokenDialogBridge));
    const entryDispose = mountTokenSidebarEntry();
    return () => { entryDispose(); footerDispose(); setTokenEntryActive(false); };
  }

  function parseArguments(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function inspectionIdFromArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const value = args.inspectionId || args.id || args.inspection;
    return typeof value === 'string' ? value : '';
  }

  function currentInspectionId(nodes, runningCalls) {
    const candidates = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || node.kind !== 'tool-result' || !node.call || !PATROL_TOOL.test(String(node.call.name || ''))) continue;
      const id = inspectionIdFromArgs(parseArguments(node.call.argsRaw));
      if (id) candidates.push({ id, time: typeof node.callTime === 'number' ? node.callTime : node.time || 0 });
    }
    for (const call of Array.isArray(runningCalls) ? runningCalls : []) {
      if (!call || !PATROL_TOOL.test(String(call.name || ''))) continue;
      const id = inspectionIdFromArgs(parseArguments(call.argsRaw));
      if (id) candidates.push({ id, time: call.time || Number.MAX_SAFE_INTEGER });
    }
    candidates.sort((a, b) => a.time - b.time);
    return candidates.at(-1)?.id || '';
  }

  function DashboardFrame({ useSession, workspaceRoot, mode }) {
    const nodes = useSession(snapshot => snapshot.nodes);
    const runningCalls = useSession(snapshot => snapshot.runningCalls);
    const current = React.useMemo(() => currentInspectionId(nodes, runningCalls), [nodes, runningCalls]);
    const src = React.useMemo(() => {
      const params = new URLSearchParams({ mode, workspace: workspaceRoot || '' });
      if (mode === 'flows' && current) params.set('current', current);
      return `${DASHBOARD_UI}?${params.toString()}`;
    }, [mode, workspaceRoot, current]);
    return React.createElement('iframe', {
      src,
      title: mode === 'flows' ? '流程管理' : '巡检记录',
      style: { display: 'block', width: '100%', height: '100%', minHeight: '520px', border: 0, background: '#f6f8fb' },
    });
  }

  function FlowView(props) { return React.createElement(DashboardFrame, { ...props, mode: 'flows' }); }
  function RecordsView(props) { return React.createElement(DashboardFrame, { ...props, mode: 'records' }); }

  function registerView(ctx, id, order, label, Component) {
    return ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view', id, order, label,
      inject: sessionId => {
        const binding = ctx.sessions.binding(sessionId);
        if (!binding) throw new Error(`dsh-patrol client: session ${sessionId} is unavailable`);
        const state = ctx.sessions.list.getSnapshot();
        const summary = state.byId && state.byId[sessionId];
        return { workspaceRoot: typeof summary?.cwd === 'string' ? summary.cwd : '' };
      },
    }, Component));
  }

  function currentSessionUsesPatrol(ctx) {
    const state = ctx.sessions.list.getSnapshot();
    const sessionId = state.current;
    if (sessionId === undefined) return false;
    const summary = state.byId && state.byId[sessionId];
    if (!summary) return false;
    if (summary.agentPreset === PATROL_PRESET_ID) return true;
    return summary.projectionValues && summary.projectionValues.agentPreset === PATROL_PRESET_ID;
  }

  exports.name = 'dsh-patrol-client-host';
  exports.inject = ['slots', 'sessions'];
  exports.apply = function apply(ctx) {
    ctx.effect(() => registerTokenSurfaces(ctx), 'dsh-patrol-client-host: token management surfaces');
    ctx.effect(() => {
      let disposeViews = null;
      const sync = () => {
        const active = currentSessionUsesPatrol(ctx);
        if (active && disposeViews === null) {
          const flow = registerView(ctx, 'patrol-flow', 30, '流程管理', FlowView);
          const records = registerView(ctx, 'patrol-records', 40, '巡检记录', RecordsView);
          disposeViews = () => { records(); flow(); };
          return;
        }
        if (!active && disposeViews !== null) { disposeViews(); disposeViews = null; }
      };
      sync();
      const stop = ctx.sessions.list.subscribe(sync);
      return () => { stop(); if (disposeViews !== null) disposeViews(); };
    }, 'dsh-patrol-client-host: patrol product dashboard views');
  };

  return module.exports; } });
