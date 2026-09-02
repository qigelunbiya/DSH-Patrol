window.__ModuleLoader__.load({ id: 'dsh-patrol-client-host', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react');

  const PATROL_TOOL = /^patrol_/u;
  const PATROL_PRESET_ID = 'patrol';
  const TOTP_TAB_ID = 'dsh-patrol:totp';
  const TOTP_ENTRY_SELECTOR = '[data-dsh-patrol-token-entry]';
  const TOTP_OPEN_EVENT = 'dsh-patrol:open-token-manager';
  const TOTP_API_ROOT = '/patrol-browser-bridge/totp';
  const VIEW_STYLE = {
    height: '100%', overflow: 'auto', padding: '20px 24px 36px', boxSizing: 'border-box',
    background: 'var(--dsh-color-bg, transparent)', color: 'var(--dsh-color-text, inherit)',
  };
  const HEADER_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '16px' };
  const TITLE_STYLE = { margin: 0, fontSize: '18px', fontWeight: 650 };
  const MUTED_STYLE = { color: 'var(--dsh-color-text-secondary, #6b7280)', fontSize: '13px', lineHeight: 1.6 };
  const CARD_STYLE = {
    border: '1px solid var(--dsh-color-border, rgba(127,127,127,.22))', borderRadius: '10px',
    padding: '14px 16px', marginBottom: '12px', background: 'var(--dsh-color-bg-secondary, rgba(127,127,127,.04))',
  };
  const MONO_STYLE = {
    margin: '10px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px', lineHeight: 1.55, maxHeight: '320px', overflow: 'auto',
  };
  const BADGE_STYLE = {
    display: 'inline-flex', alignItems: 'center', borderRadius: '999px', padding: '2px 8px',
    fontSize: '12px', background: 'var(--dsh-color-bg-tertiary, rgba(127,127,127,.12))', marginRight: '8px',
  };
  const BUTTON_STYLE = {
    border: '1px solid var(--dsh-color-border, rgba(127,127,127,.28))', borderRadius: '8px', padding: '6px 10px',
    background: 'var(--dsh-color-bg-secondary, transparent)', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  };
  const INPUT_STYLE = {
    width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsh-color-border, rgba(127,127,127,.28))',
    borderRadius: '8px', padding: '8px 10px', background: 'var(--dsh-color-bg-secondary, transparent)', color: 'inherit', fontSize: '12px',
  };

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  function short(value, limit = 8000) {
    const text = typeof value === 'string' ? value : safeJson(value);
    return text.length <= limit ? text : `${text.slice(0, limit)}\n…（内容已截断）`;
  }

  function parseArguments(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function formatTime(time) {
    if (typeof time !== 'number') return '';
    try { return new Date(time).toLocaleString(); } catch { return ''; }
  }

  function contentText(content) {
    if (!Array.isArray(content)) return '';
    const text = content
      .map((block) => block && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n');
    return text || safeJson(content);
  }

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

  function setTokenEntryActive(active) {
    if (typeof document === 'undefined') return;
    const entry = document.querySelector(TOTP_ENTRY_SELECTOR);
    if (!(entry instanceof HTMLElement)) return;
    if (active) entry.setAttribute('data-active', 'true');
    else entry.removeAttribute('data-active');
  }

  async function loadTotpSession() {
    const response = await fetch(`${TOTP_API_ROOT}/session`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || typeof payload.csrf !== 'string') {
      throw new Error(payload?.error || '无法读取 TOTP 管理会话');
    }
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
      const raw = `${issuer}-${account}`.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56);
      return raw || `token-${Date.now().toString(36)}`;
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

    const updateStatus = React.useCallback((message, isError = false) => {
      setStatus(message);
      setStatusError(isError);
    }, []);

    const reload = React.useCallback(async () => {
      try {
        const payload = await loadTotpSession();
        setCsrf(payload.csrf);
        const next = Array.isArray(payload.profiles) ? payload.profiles : [];
        setProfiles(next);
        updateStatus(`已加载 ${next.length} 个令牌配置。`);
      } catch (error) {
        updateStatus(`${errorMessage(error)}。请确认已更新并重启 DSH Patrol。`, true);
      }
    }, [updateStatus]);

    React.useEffect(() => {
      let active = true;
      loadTotpSession().then((payload) => {
        if (!active) return;
        setCsrf(payload.csrf);
        const next = Array.isArray(payload.profiles) ? payload.profiles : [];
        setProfiles(next);
        updateStatus(`已加载 ${next.length} 个令牌配置。`);
      }).catch((error) => {
        if (active) updateStatus(`${errorMessage(error)}。请确认已更新并重启 DSH Patrol。`, true);
      });
      return () => {
        active = false;
        setUri('');
      };
    }, [updateStatus]);

    const importProfile = async () => {
      const normalizedId = profileId.trim();
      const normalizedUri = uri.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalizedId)) {
        updateStatus('Profile ID 只能使用字母、数字、点、下划线和连字符，长度 1-64。', true);
        return;
      }
      if (!/^otpauth:\/\/totp\//i.test(normalizedUri)) {
        updateStatus('请粘贴普通 otpauth://totp/... URI，或先识别二维码图片。', true);
        return;
      }
      setBusy(true);
      try {
        updateStatus('正在加密保存令牌…');
        const payload = await totpPost('import', csrf, { profileId: normalizedId, uri: normalizedUri });
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setUri('');
        updateStatus(`令牌 ${normalizedId} 已安全导入。`);
      } catch (error) {
        setUri('');
        updateStatus(errorMessage(error), true);
      } finally {
        setBusy(false);
      }
    };

    const removeProfile = async (id) => {
      if (!window.confirm(`删除令牌配置 ${id}？`)) return;
      setBusy(true);
      try {
        updateStatus('正在删除…');
        const payload = await totpPost('delete', csrf, { profileId: id });
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        updateStatus(`已删除 ${id}。`);
      } catch (error) {
        updateStatus(errorMessage(error), true);
      } finally {
        setBusy(false);
      }
    };

    const readQrImage = async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        updateStatus('二维码图片不能超过 8 MiB。', true);
        return;
      }
      if (typeof window.BarcodeDetector !== 'function') {
        updateStatus('当前 Chromium 不支持 BarcodeDetector，请直接粘贴 otpauth URI。', true);
        return;
      }
      let bitmap;
      setBusy(true);
      try {
        updateStatus('正在当前浏览器内本地识别二维码…');
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        bitmap = await createImageBitmap(file);
        const codes = await detector.detect(bitmap);
        const raw = codes.map((item) => String(item.rawValue || '')).find((value) => /^otpauth:\/\/totp\//i.test(value));
        if (!raw) throw new Error('图片中没有识别到普通 TOTP 二维码');
        setUri(raw);
        if (!profileId.trim()) setProfileId(profileIdFromOtpAuth(raw));
        updateStatus('二维码识别成功。确认 Profile ID 后点击“导入”。');
      } catch (error) {
        setUri('');
        updateStatus(errorMessage(error), true);
      } finally {
        if (bitmap && typeof bitmap.close === 'function') bitmap.close();
        setBusy(false);
      }
    };

    const rootStyle = embedded
      ? { height: '100%', overflow: 'auto', padding: '16px', boxSizing: 'border-box', color: 'inherit' }
      : { color: 'inherit' };

    return React.createElement('div', { style: rootStyle, 'data-dsh-patrol-token-manager': 'true' },
      React.createElement('div', { style: HEADER_STYLE },
        React.createElement('div', null,
          React.createElement('h2', { style: TITLE_STYLE }, '令牌'),
          React.createElement('div', { style: MUTED_STYLE }, '管理 Patrol 自动登录使用的 TOTP 动态口令配置。'),
        ),
        React.createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: reload }, '刷新'),
      ),
      React.createElement('div', { style: { ...CARD_STYLE, fontSize: '12px', lineHeight: 1.65 } },
        'TOTP seed 使用现有 AES-256-GCM Patrol vault 加密保存在本机。界面、Runbook、模型工具参数与工具结果都不会显示 seed 或当前动态码。',
      ),
      React.createElement('div', {
        role: statusError ? 'alert' : 'status',
        style: { minHeight: '20px', marginBottom: '10px', fontSize: '12px', color: statusError ? 'var(--dsh-color-danger, #dc2626)' : 'var(--dsh-color-text-secondary, #6b7280)' },
      }, status),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } }, '已配置令牌'),
      profiles.length === 0
        ? React.createElement('div', { style: { ...CARD_STYLE, ...MUTED_STYLE } }, '还没有配置 TOTP 令牌。')
        : profiles.map((profile) => React.createElement('div', { key: profile.id, style: { ...CARD_STYLE, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, profile.issuer || profile.label || profile.id),
            React.createElement('div', { style: { ...MUTED_STYLE, fontSize: '11px', wordBreak: 'break-word' } },
              `${profile.account || ''} · id=${profile.id} · ${profile.algorithm || 'SHA1'} · ${profile.digits || 6}位/${profile.period || 30}s`,
            ),
          ),
          React.createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: () => removeProfile(profile.id) }, '删除'),
        )),
      React.createElement('div', { style: { height: '1px', background: 'var(--dsh-color-border, rgba(127,127,127,.18))', margin: '18px 0' } }),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' } }, '导入令牌'),
      React.createElement('input', {
        value: profileId, onChange: (event) => setProfileId(event.target.value), disabled: busy,
        placeholder: 'Profile ID，例如 anheng-ops', autoComplete: 'off', style: INPUT_STYLE,
      }),
      React.createElement('input', {
        value: uri, onChange: (event) => setUri(event.target.value), disabled: busy,
        placeholder: '粘贴 otpauth://totp/...', type: 'password', autoComplete: 'off', spellCheck: false,
        style: { ...INPUT_STYLE, marginTop: '8px' }, 'data-dsh-patrol-totp-uri': 'true',
      }),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } },
        React.createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy || !csrf, onClick: importProfile }, busy ? '处理中…' : '导入'),
        React.createElement('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: () => fileRef.current?.click() }, '识别二维码图片'),
        React.createElement('input', { ref: fileRef, type: 'file', accept: 'image/*', hidden: true, onChange: readQrImage }),
      ),
      React.createElement('div', { style: { ...MUTED_STYLE, marginTop: '8px', fontSize: '11px' } },
        '二维码图片只在当前 Chromium 内通过 BarcodeDetector 解析，不上传图片。当前支持普通 otpauth://totp 二维码；Google Authenticator 批量迁移码暂不支持。',
      ),
    );
  }

  function TokenBetterSidebarTab() {
    React.useEffect(() => {
      setTokenEntryActive(true);
      return () => setTokenEntryActive(false);
    }, []);
    return React.createElement(TokenManager, { embedded: true });
  }

  function TokenFooterBridge({ openTokenTab }) {
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
      const onOpen = () => {
        if (typeof openTokenTab === 'function' && openTokenTab()) return;
        setOpen(true);
      };
      window.addEventListener(TOTP_OPEN_EVENT, onOpen);
      return () => window.removeEventListener(TOTP_OPEN_EVENT, onOpen);
    }, [openTokenTab]);

    React.useEffect(() => {
      setTokenEntryActive(open);
      if (!open) return undefined;
      const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [open]);

    if (!open) return null;
    return React.createElement('div', {
      role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false); },
      style: { position: 'fixed', inset: 0, zIndex: 10050, display: 'grid', placeItems: 'center', padding: '20px', background: 'rgba(0,0,0,.36)', boxSizing: 'border-box' },
    }, React.createElement('section', {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': '令牌管理',
      style: {
        width: 'min(720px, calc(100vw - 40px))', maxHeight: 'min(820px, calc(100vh - 40px))', overflow: 'auto',
        border: '1px solid var(--dsh-color-border, rgba(127,127,127,.26))', borderRadius: '14px',
        background: 'var(--dsh-color-bg, #fff)', color: 'var(--dsh-color-text, #111827)', boxShadow: '0 24px 80px rgba(0,0,0,.28)',
        padding: '20px', boxSizing: 'border-box',
      },
    },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' } },
      React.createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: () => setOpen(false) }, '关闭'),
    ),
    React.createElement(TokenManager, null)));
  }

  function sidebarRoot() {
    if (typeof document === 'undefined') return undefined;
    const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
    if (!(column instanceof HTMLElement)) return undefined;
    const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
    return logoOwner instanceof HTMLElement ? logoOwner : (column.firstElementChild instanceof HTMLElement ? column.firstElementChild : undefined);
  }

  function newSessionButton(root) {
    const nested = root.querySelector('button[class*="newSession"]');
    if (nested instanceof HTMLButtonElement) return nested;
    for (const child of root.children) {
      if (child instanceof HTMLButtonElement) return child;
    }
    return undefined;
  }

  function installTokenEntryStyles() {
    const existing = document.querySelector('style[data-dsh-patrol-token-entry-style]');
    if (existing instanceof HTMLStyleElement) return { element: existing, owned: false };
    const style = document.createElement('style');
    style.setAttribute('data-dsh-patrol-token-entry-style', 'true');
    style.textContent = `
${TOTP_ENTRY_SELECTOR}{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 10px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,var(--dsh-color-text-secondary,#6b7280));cursor:pointer;font-size:13px;white-space:nowrap;text-align:left}
${TOTP_ENTRY_SELECTOR}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,var(--dsh-color-text,inherit))}
${TOTP_ENTRY_SELECTOR}[data-active]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,var(--dsh-color-text,inherit));font-weight:600}
${TOTP_ENTRY_SELECTOR} .dsh-patrol-token-entry-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none}
${TOTP_ENTRY_SELECTOR} .dsh-patrol-token-entry-icon svg{display:block;width:18px;height:18px}
${TOTP_ENTRY_SELECTOR} .dsh-patrol-token-entry-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${TOTP_ENTRY_SELECTOR}[data-rail] {justify-content:center;padding:0;gap:0}
${TOTP_ENTRY_SELECTOR}[data-rail] .dsh-patrol-token-entry-label{display:none}
`;
    document.head.appendChild(style);
    return { element: style, owned: true };
  }

  function createTokenSidebarEntry() {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('data-dsh-patrol-token-entry', '');
    entry.setAttribute('data-dsh-plugin', 'patrol-token');
    entry.setAttribute('data-dsh-part', 'sidebar-entry');
    entry.setAttribute('aria-label', '令牌');
    entry.setAttribute('title', '令牌');

    const icon = document.createElement('span');
    icon.className = 'dsh-patrol-token-entry-icon';
    icon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v3.75l2.35 1.55"/><path d="M5.4 1.55h5.2"/></svg>';
    const label = document.createElement('span');
    label.className = 'dsh-patrol-token-entry-label';
    label.textContent = '令牌';
    entry.append(icon, label);
    entry.addEventListener('click', () => window.dispatchEvent(new Event(TOTP_OPEN_EVENT)));
    return entry;
  }

  function placeTokenSidebarEntry(root, entry) {
    const button = newSessionButton(root);
    if (!button) return false;
    const logoRow = button.closest('[class*="logoRow"]');
    const base = logoRow instanceof HTMLElement && logoRow.parentElement === root ? logoRow : button;
    const ssh = root.querySelector('[data-dsh-ssh-entry]');
    let anchor;
    if (ssh instanceof HTMLElement && ssh.parentElement === root) {
      anchor = ssh.nextElementSibling;
    } else {
      const family = Array.from(root.children).filter((child) => child instanceof HTMLElement && child.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry]'));
      anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
    }
    if (entry.parentElement !== root || entry.previousElementSibling !== (ssh instanceof HTMLElement && ssh.parentElement === root ? ssh : (anchor ? anchor.previousElementSibling : root.lastElementChild))) {
      root.insertBefore(entry, anchor || null);
    }
    return true;
  }

  function mountTokenSidebarEntry() {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
    if (document.querySelector(TOTP_ENTRY_SELECTOR)) return () => {};

    const entry = createTokenSidebarEntry();
    const styles = installTokenEntryStyles();
    let root;
    let placed = false;
    let resizeObserver;

    const syncRail = () => {
      if (!root || !root.isConnected) return;
      if (root.getBoundingClientRect().width <= 88) entry.setAttribute('data-rail', 'true');
      else entry.removeAttribute('data-rail');
    };

    const observeRootSize = () => {
      resizeObserver?.disconnect?.();
      resizeObserver = undefined;
      if (!root) return;
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(syncRail);
        resizeObserver.observe(root);
      }
      syncRail();
    };

    const tryPlace = () => {
      if (root && !root.isConnected) {
        rootObserver.disconnect();
        resizeObserver?.disconnect?.();
        root = undefined;
        placed = false;
      }
      root ||= sidebarRoot();
      if (!root) return;
      const beforeParent = entry.parentElement;
      placed = placeTokenSidebarEntry(root, entry);
      if (placed) {
        rootObserver.disconnect();
        rootObserver.observe(root, { childList: true, subtree: true });
        if (beforeParent !== root) observeRootSize();
        else syncRail();
      }
    };

    const rootObserver = new MutationObserver(() => {
      if (!root || !root.isConnected) {
        placed = false;
        tryPlace();
        return;
      }
      const ssh = root.querySelector('[data-dsh-ssh-entry]');
      const misplaced = !root.contains(entry) || (ssh instanceof HTMLElement && ssh.parentElement === root && entry.previousElementSibling !== ssh);
      if (misplaced) placeTokenSidebarEntry(root, entry);
      syncRail();
    });
    const bodyObserver = new MutationObserver(() => {
      if (!placed || !document.body.contains(entry)) tryPlace();
      else if (root) {
        const ssh = root.querySelector('[data-dsh-ssh-entry]');
        if (ssh instanceof HTMLElement && ssh.parentElement === root && entry.previousElementSibling !== ssh) placeTokenSidebarEntry(root, entry);
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', syncRail);
    tryPlace();

    return () => {
      bodyObserver.disconnect();
      rootObserver.disconnect();
      resizeObserver?.disconnect?.();
      window.removeEventListener('resize', syncRail);
      entry.remove();
      if (styles.owned) styles.element.remove();
    };
  }

  function registerTokenSurfaces(ctx) {
    let betterSidebar = null;

    ctx.inject(['betterSidebar'], (scope) => {
      const service = scope.get?.('betterSidebar') ?? scope.betterSidebar;
      if (!service || typeof service.registerTab !== 'function') return;
      betterSidebar = service;
      scope.effect(() => service.registerTab({
        id: TOTP_TAB_ID,
        title: () => '令牌',
        icon: (size) => React.createElement(TokenIcon, { size }),
        order: 46,
        single: true,
        component: TokenBetterSidebarTab,
      }), 'dsh-patrol-client-host: Better Sidebar token tab');
      scope.effect(() => () => {
        if (betterSidebar === service) betterSidebar = null;
      }, 'dsh-patrol-client-host: clear Better Sidebar token handle');
    });

    const footerDispose = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'dsh-patrol-token-bridge', order: 1000,
      inject: () => ({
        openTokenTab: () => {
          if (!betterSidebar || typeof betterSidebar.openTab !== 'function') return false;
          try {
            betterSidebar.openTab({ type: TOTP_TAB_ID, title: '令牌' });
            return true;
          } catch (error) {
            console.warn('[dsh-patrol] Better Sidebar token tab open failed; using local dialog fallback:', error);
            return false;
          }
        },
      }),
    }, TokenFooterBridge));
    const entryDispose = mountTokenSidebarEntry();
    return () => {
      entryDispose();
      footerDispose();
      setTokenEntryActive(false);
    };
  }

  function collectPatrol(nodes, runningCalls) {
    const byCallId = new Map();
    const ordered = [];

    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || node.kind !== 'tool-result') continue;
      const head = node.call;
      if (!head || typeof head.name !== 'string' || !PATROL_TOOL.test(head.name)) continue;
      const record = {
        callId: node.callId,
        name: head.name,
        args: parseArguments(head.argsRaw),
        seq: node.seq,
        time: typeof node.callTime === 'number' ? node.callTime : node.time,
        result: contentText(node.content),
        isError: Boolean(node.isError),
        resultSeq: node.seq,
        resultTime: node.time,
      };
      byCallId.set(record.callId, record);
      ordered.push(record);
    }

    for (const running of Array.isArray(runningCalls) ? runningCalls : []) {
      if (!running || typeof running.name !== 'string' || !PATROL_TOOL.test(running.name)) continue;
      if (byCallId.has(running.callId)) continue;
      const record = {
        callId: running.callId,
        name: running.name,
        args: parseArguments(running.argsRaw),
        seq: null,
        time: running.time,
        result: null,
        isError: false,
      };
      byCallId.set(record.callId, record);
      ordered.push(record);
    }

    ordered.sort((left, right) => {
      const leftTime = typeof left.time === 'number' ? left.time : 0;
      const rightTime = typeof right.time === 'number' ? right.time : 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      const leftSeq = typeof left.seq === 'number' ? left.seq : Number.MAX_SAFE_INTEGER;
      const rightSeq = typeof right.seq === 'number' ? right.seq : Number.MAX_SAFE_INTEGER;
      return leftSeq - rightSeq;
    });
    return ordered;
  }

  function inspectionKey(call) {
    const args = call && call.args;
    if (!args || typeof args !== 'object') return '';
    return String(args.inspectionId || args.id || args.inspection || '');
  }

  function flowCards(calls) {
    const byInspection = new Map();
    for (const call of calls) {
      const key = inspectionKey(call);
      if (!key) continue;
      const existing = byInspection.get(key) || { id: key, calls: [], definition: null };
      existing.calls.push(call);
      if (call.name === 'patrol_create_inspection' && call.args && typeof call.args === 'object') existing.definition = call.args;
      if (call.name === 'patrol_show' && call.result) existing.showResult = call.result;
      byInspection.set(key, existing);
    }
    if (byInspection.size > 0) return [...byInspection.values()].reverse();
    const recent = calls.slice(-8).reverse();
    return recent.length === 0 ? [] : [{ id: '当前巡检会话', calls: recent, definition: null }];
  }

  function EmptyState({ children }) {
    return React.createElement('div', { style: { ...CARD_STYLE, ...MUTED_STYLE, padding: '24px' } }, children);
  }

  function LoadOlder({ hasMore, loadOlder }) {
    const [loading, setLoading] = React.useState(false);
    if (!hasMore) return null;
    return React.createElement('button', {
      type: 'button', style: BUTTON_STYLE, disabled: loading,
      onClick: async () => {
        if (loading) return;
        setLoading(true);
        try { await loadOlder(); } finally { setLoading(false); }
      },
    }, loading ? '正在加载…' : '加载更早记录');
  }

  function FlowView({ useSession, loadOlder }) {
    const nodes = useSession((snapshot) => snapshot.nodes);
    const runningCalls = useSession((snapshot) => snapshot.runningCalls);
    const hasMore = useSession((snapshot) => snapshot.hasMore);
    const calls = React.useMemo(() => collectPatrol(nodes, runningCalls), [nodes, runningCalls]);
    const cards = React.useMemo(() => flowCards(calls), [calls]);
    return React.createElement('div', { style: VIEW_STYLE },
      React.createElement('div', { style: HEADER_STYLE },
        React.createElement('div', null,
          React.createElement('h2', { style: TITLE_STYLE }, '流程管理'),
          React.createElement('div', { style: MUTED_STYLE }, '从当前巡检会话实时汇总巡检模板、目标与最近流程动作。'),
        ),
        React.createElement(LoadOlder, { hasMore, loadOlder }),
      ),
      cards.length === 0
        ? React.createElement(EmptyState, null, '当前会话还没有巡检流程。创建或打开巡检后，这里会自动显示。')
        : cards.map((card) => {
          const latest = card.calls[card.calls.length - 1];
          return React.createElement('section', { key: card.id, style: CARD_STYLE },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
              React.createElement('strong', null, card.id),
              latest ? React.createElement('span', { style: BADGE_STYLE }, latest.name) : null,
              latest && latest.time ? React.createElement('span', { style: MUTED_STYLE }, formatTime(latest.time)) : null,
            ),
            card.definition ? React.createElement('div', { style: { marginTop: '10px' } },
              card.definition.name ? React.createElement('div', null, React.createElement('strong', null, '名称：'), String(card.definition.name)) : null,
              card.definition.targetUrl ? React.createElement('div', null, React.createElement('strong', null, '目标：'), String(card.definition.targetUrl)) : null,
              card.definition.expectedResult ? React.createElement('div', null, React.createElement('strong', null, '预期：'), String(card.definition.expectedResult)) : null,
            ) : null,
            card.showResult
              ? React.createElement('pre', { style: MONO_STYLE }, short(card.showResult, 12000))
              : React.createElement('div', { style: { ...MUTED_STYLE, marginTop: '10px' } }, `已记录 ${card.calls.length} 个 Patrol 流程动作。执行 patrol_show 后会在这里展示完整模板。`),
          );
        }),
    );
  }

  function RecordsView({ useSession, loadOlder }) {
    const nodes = useSession((snapshot) => snapshot.nodes);
    const runningCalls = useSession((snapshot) => snapshot.runningCalls);
    const hasMore = useSession((snapshot) => snapshot.hasMore);
    const calls = React.useMemo(() => collectPatrol(nodes, runningCalls), [nodes, runningCalls]);
    const records = calls.slice().reverse();
    return React.createElement('div', { style: VIEW_STYLE },
      React.createElement('div', { style: HEADER_STYLE },
        React.createElement('div', null,
          React.createElement('h2', { style: TITLE_STYLE }, '巡检记录'),
          React.createElement('div', { style: MUTED_STYLE }, `当前已加载 ${records.length} 条 Patrol 工具记录，最新记录在前。`),
        ),
        React.createElement(LoadOlder, { hasMore, loadOlder }),
      ),
      records.length === 0
        ? React.createElement(EmptyState, null, '当前会话还没有 Patrol 巡检记录。开始教学、编辑或运行巡检后会自动出现。')
        : records.map((record, index) => React.createElement('section', { key: `${record.callId || record.seq}-${index}`, style: CARD_STYLE },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
            React.createElement('strong', null, record.name),
            React.createElement('span', { style: BADGE_STYLE }, record.isError ? '失败' : record.result === null ? '执行中 / 未返回' : '完成'),
            record.time ? React.createElement('span', { style: MUTED_STYLE }, formatTime(record.time)) : null,
          ),
          React.createElement('details', { style: { marginTop: '8px' } },
            React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, '参数'),
            React.createElement('pre', { style: MONO_STYLE }, short(record.args, 6000)),
          ),
          record.result !== null ? React.createElement('details', { open: record.isError, style: { marginTop: '8px' } },
            React.createElement('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, '结果'),
            React.createElement('pre', { style: MONO_STYLE }, short(record.result, 10000)),
          ) : null,
        )),
    );
  }

  function registerView(ctx, id, order, label, Component) {
    return ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view', id, order, label,
      inject: (sessionId) => {
        const binding = ctx.sessions.binding(sessionId);
        if (!binding) throw new Error(`dsh-patrol client: session ${sessionId} is unavailable`);
        return {
          loadOlder: async () => {
            const before = binding.session.getSnapshot();
            await binding.session.loadOlder();
            return binding.session.getSnapshot() !== before;
          },
        };
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
        if (!active && disposeViews !== null) {
          disposeViews();
          disposeViews = null;
        }
      };
      sync();
      const stop = ctx.sessions.list.subscribe(sync);
      return () => {
        stop();
        if (disposeViews !== null) disposeViews();
      };
    }, 'dsh-patrol-client-host: patrol conversation views');
  };

  return module.exports; } });
