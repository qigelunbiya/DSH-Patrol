window.__ModuleLoader__.load({ id: 'dsh-patrol-client-host', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react');

  const PATROL_TOOL = /^patrol_/u;
  const PATROL_PRESET_ID = 'patrol';
  const DASHBOARD_UI = '/patrol-browser-bridge/dashboard/ui';
  const FLOW_CATALOG_API = '/patrol-browser-bridge/dashboard/catalog';
  const BROWSER_VISIBILITY_API = '/patrol-browser-bridge/browser-visibility';
  const FLOW_REFERENCE_SOURCE = 'patrol-flow-reference';
  const FLOW_REFERENCE_SECTION = '巡检流程';
  const HERO_CONTROLS_SELECTOR = '[data-dsh-patrol-hero-controls]';
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

  function sessionSummary(ctx, sessionId) {
    const state = ctx.sessions.list.getSnapshot();
    return state.byId && state.byId[sessionId];
  }

  function workspaceForSession(ctx, sessionId) {
    const summary = sessionSummary(ctx, sessionId);
    return typeof summary?.cwd === 'string' ? summary.cwd : '';
  }

  async function loadPatrolFlows(workspaceRoot, signal) {
    if (!workspaceRoot) return [];
    const params = new URLSearchParams({ workspace: workspaceRoot });
    const response = await fetch(`${FLOW_CATALOG_API}?${params.toString()}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '无法读取巡检流程');
    return (Array.isArray(payload.inspections) ? payload.inspections : [])
      .map(item => item && typeof item === 'object' ? (item.definition || item) : null)
      .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string');
  }

  function flowReplayPrompt(inspectionId, flowName) {
    const id = String(inspectionId || '').trim();
    const name = String(flowName || id).trim();
    const label = name && name !== id ? `（${name}）` : '';
    return `运行巡检流程 ${id}${label}。请直接使用 patrol_run_flow 重放已有流程，不要修改、重教或新增流程步骤。执行过程中用简体中文实时说明关键巡检进展、当前页面状态和最终结果。`;
  }

  async function sendFlowReplay(ctx, sessionId, inspectionId, flowName) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(inspectionId || ''))) throw new Error('巡检流程 ID 无效');
    const scoped = typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined;
    const conversation = scoped?.get?.('conversation') ?? scoped?.conversation;
    if (!conversation || typeof conversation.send !== 'function') throw new Error('当前会话尚未提供对话发送服务');
    await conversation.send(flowReplayPrompt(inspectionId, flowName));
  }

  async function readBrowserVisibility() {
    const response = await fetch(BROWSER_VISIBILITY_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || typeof payload.visible !== 'boolean') throw new Error(payload?.error || '无法读取浏览器显示设置');
    return payload;
  }

  async function writeBrowserVisibility(visible) {
    const response = await fetch(BROWSER_VISIBILITY_API, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ visible: Boolean(visible) }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || typeof payload.visible !== 'boolean') throw new Error(payload?.error || '无法更新浏览器显示设置');
    return payload;
  }

  function flowReferenceValue(flow) {
    return { v: 1, id: flow.id, name: flow.name };
  }

  function parseFlowReferenceValue(raw) {
    if (typeof raw !== 'string') return undefined;
    try {
      const value = JSON.parse(raw);
      if (value?.v !== 1) return undefined;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(value.id || ''))) return undefined;
      return { v: 1, id: String(value.id), name: String(value.name || value.id) };
    } catch { return undefined; }
  }

  function flowMentionToken(value) {
    return `@flow:${value.id}`;
  }

  function registerPatrolFlowReferenceSource(ctx) {
    const source = {
      trigger: '@',
      name: FLOW_REFERENCE_SOURCE,
      order: 20,
      showGroupTitle: true,
      async candidates(session, request) {
        const workspaceRoot = workspaceForSession(ctx, String(session.sessionId));
        if (!workspaceRoot || request.signal.aborted) return [];
        try {
          const flows = await loadPatrolFlows(workspaceRoot, request.signal);
          const query = String(request.query || '').trim().toLocaleLowerCase();
          return flows
            .filter(flow => !query || flow.name.toLocaleLowerCase().includes(query) || flow.id.toLocaleLowerCase().includes(query))
            .slice(0, 50)
            .map(flow => ({
              name: flow.name,
              description: `${flow.id} · ${String(flow.status || 'draft').toUpperCase()} · ${Array.isArray(flow.steps) ? flow.steps.length : 0} 步`,
              section: FLOW_REFERENCE_SECTION,
              value: JSON.stringify(flowReferenceValue(flow)),
            }));
        } catch (error) {
          if (!request.signal.aborted) console.warn('[dsh-patrol] Patrol @ flow search failed:', errorMessage(error));
          return [];
        }
      },
      onPick({ candidate }) {
        const value = parseFlowReferenceValue(candidate?.value);
        if (!value) return undefined;
        return {
          insert: {
            source: FLOW_REFERENCE_SOURCE,
            ref: JSON.stringify(value),
            label: `流程 · ${value.name}`,
            appearance: 'file',
            clipboardText: flowMentionToken(value),
          },
        };
      },
      codec: {
        clipboardText(ref) {
          const value = parseFlowReferenceValue(ref);
          return value ? flowMentionToken(value) : '@flow:';
        },
        async serialize(ref) {
          const value = parseFlowReferenceValue(ref);
          if (!value) throw new Error('invalid Patrol flow reference');
          return flowMentionToken(value);
        },
      },
    };
    const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : ctx.inputTriggers;
    if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') throw new Error('inputTriggers service is unavailable; Patrol @ flow references cannot be registered');
    return inputTriggers.registerSource(source);
  }

  function BrowserVisibilityButton() {
    const [visible, setVisible] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [note, setNote] = React.useState('');
    React.useEffect(() => {
      let cancelled = false;
      readBrowserVisibility().then(value => { if (!cancelled) setVisible(value.visible); }).catch(error => { if (!cancelled) setNote(errorMessage(error)); });
      return () => { cancelled = true; };
    }, []);
    const toggle = async () => {
      if (busy) return;
      setBusy(true); setNote('');
      try {
        const result = await writeBrowserVisibility(visible === false);
        setVisible(result.visible);
        if (result.note) setNote(result.note);
      } catch (error) { setNote(errorMessage(error)); }
      finally { setBusy(false); }
    };
    return React.createElement('span', { style: { position: 'relative', display: 'inline-flex' }, title: note || (visible === false ? '后台巡检：浏览器窗口隐藏' : '可视巡检：显示浏览器窗口') },
      React.createElement('button', { type: 'button', onClick: toggle, disabled: busy, style: { ...BUTTON, height: '28px', padding: '0 9px', whiteSpace: 'nowrap' }, 'data-dsh-patrol-browser-visibility': visible === false ? 'hidden' : 'visible' },
        busy ? '切换中…' : (visible === false ? '浏览器：后台' : '浏览器：显示')),
    );
  }

  function FlowRunButton({ workspaceRoot, runFlow }) {
    const [open, setOpen] = React.useState(false);
    const [flows, setFlows] = React.useState([]);
    const [status, setStatus] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
      if (!open) return undefined;
      const controller = new AbortController();
      setStatus('正在读取流程…');
      loadPatrolFlows(workspaceRoot, controller.signal)
        .then(items => { setFlows(items); setStatus(items.length ? '' : '当前工作区还没有可运行流程。'); })
        .catch(error => { if (!controller.signal.aborted) setStatus(errorMessage(error)); });
      return () => controller.abort();
    }, [open, workspaceRoot]);
    const execute = async flow => {
      setBusy(true); setStatus('');
      try { await runFlow(flow.id, flow.name); setOpen(false); }
      catch (error) { setStatus(errorMessage(error)); }
      finally { setBusy(false); }
    };
    return React.createElement('span', { style: { position: 'relative', display: 'inline-flex' } },
      React.createElement('button', { type: 'button', style: { ...BUTTON, height: '28px', padding: '0 9px' }, onClick: () => setOpen(value => !value) }, '▶ 运行流程'),
      open ? React.createElement('div', { style: { position: 'absolute', zIndex: 10020, top: '34px', right: 0, width: '320px', maxHeight: '360px', overflow: 'auto', ...CARD, boxShadow: '0 16px 48px rgba(0,0,0,.18)' } },
        React.createElement('div', { style: { fontWeight: 700, fontSize: '13px', marginBottom: '8px' } }, '运行已有巡检流程'),
        status ? React.createElement('div', { style: { color: MUTED, fontSize: '12px', padding: '8px 0' } }, status) : null,
        flows.map(flow => React.createElement('button', { key: flow.id, type: 'button', disabled: busy, onClick: () => execute(flow), style: { display: 'block', width: '100%', textAlign: 'left', border: 0, borderTop: `1px solid ${BORDER}`, background: 'transparent', color: TEXT, cursor: 'pointer', padding: '9px 3px' } },
          React.createElement('div', { style: { fontSize: '12px', fontWeight: 650 } }, flow.name),
          React.createElement('div', { style: { fontSize: '10px', color: MUTED, marginTop: '3px' } }, `${flow.id} · ${String(flow.status || 'draft').toUpperCase()} · ${Array.isArray(flow.steps) ? flow.steps.length : 0} 步`),
        )),
      ) : null,
    );
  }

  function PatrolHeaderControls({ workspaceRoot, runFlow }) {
    return React.createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' }, 'data-dsh-patrol-runtime-controls': 'header' },
      React.createElement(FlowRunButton, { workspaceRoot, runFlow }),
      React.createElement(BrowserVisibilityButton),
    );
  }

  function registerPatrolHeaderControls(ctx) {
    return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'dsh-patrol-runtime-controls', order: 15,
      inject: sessionId => ({
        workspaceRoot: workspaceForSession(ctx, sessionId),
        runFlow: (inspectionId, flowName) => sendFlowReplay(ctx, sessionId, inspectionId, flowName),
      }),
    }, PatrolHeaderControls));
  }

  function createHeroFlowChooser(ctx, sessionId, workspaceRoot) {
    const backdrop = document.createElement('div');
    backdrop.setAttribute('data-dsh-patrol-flow-chooser', '');
    Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '10060', display: 'grid', placeItems: 'center', background: 'rgba(15,23,42,.36)', padding: '20px' });
    const panel = document.createElement('div');
    Object.assign(panel.style, { width: 'min(520px, calc(100vw - 40px))', maxHeight: 'min(620px, calc(100vh - 40px))', overflow: 'auto', background: 'var(--dsh-color-bg,#fff)', color: 'var(--dsh-color-text,#172033)', border: '1px solid rgba(127,127,127,.24)', borderRadius: '14px', padding: '16px', boxShadow: '0 24px 80px rgba(0,0,0,.25)' });
    panel.innerHTML = '<div style="font-size:15px;font-weight:700;margin-bottom:4px">运行已有巡检流程</div><div data-status style="font-size:12px;color:#667085;margin-bottom:10px">正在读取流程…</div><div data-list></div>';
    backdrop.appendChild(panel); document.body.appendChild(backdrop);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) backdrop.remove(); });
    const status = panel.querySelector('[data-status]');
    const list = panel.querySelector('[data-list]');
    loadPatrolFlows(workspaceRoot).then(flows => {
      if (!backdrop.isConnected) return;
      status.textContent = flows.length ? '选择一个流程即可直接开始运行，无需先发送消息。' : '当前工作区还没有可运行流程。';
      for (const flow of flows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-top:1px solid rgba(127,127,127,.18);background:transparent;color:inherit;cursor:pointer;padding:10px 3px';
        const title = document.createElement('div'); title.textContent = flow.name; title.style.cssText = 'font-size:13px;font-weight:650';
        const meta = document.createElement('div'); meta.textContent = `${flow.id} · ${String(flow.status || 'draft').toUpperCase()} · ${Array.isArray(flow.steps) ? flow.steps.length : 0} 步`; meta.style.cssText = 'font-size:10px;color:#667085;margin-top:3px';
        button.append(title, meta);
        button.addEventListener('click', async () => {
          button.disabled = true; status.textContent = '正在启动流程…';
          try { await sendFlowReplay(ctx, sessionId, flow.id, flow.name); backdrop.remove(); }
          catch (error) { button.disabled = false; status.textContent = errorMessage(error); }
        });
        list.appendChild(button);
      }
    }).catch(error => { if (backdrop.isConnected) status.textContent = errorMessage(error); });
  }

  function mountPatrolHeroControls(ctx) {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function' || !document.body) return () => {};
    let scheduled = false;
    let visibility = null;
    const syncVisibility = async button => {
      try { const value = await readBrowserVisibility(); visibility = value.visible; if (button.isConnected) button.textContent = visibility ? '浏览器：显示' : '浏览器：后台'; }
      catch { if (button.isConnected) button.textContent = '浏览器设置'; }
    };
    const place = () => {
      scheduled = false;
      const state = ctx.sessions.list.getSnapshot();
      const sessionId = state.current;
      const existing = document.querySelector(HERO_CONTROLS_SELECTOR);
      if (sessionId === undefined || !currentSessionUsesPatrol(ctx, sessionId)) { if (existing instanceof HTMLElement) existing.remove(); return; }
      const seat = document.querySelector('[data-composer-seat]');
      if (!(seat instanceof HTMLElement)) return;
      const modeButton = Array.from(seat.querySelectorAll('button')).find(button => String(button.textContent || '').trim() === '巡检模式');
      if (!(modeButton instanceof HTMLElement) || !(modeButton.parentElement instanceof HTMLElement)) { if (existing instanceof HTMLElement) existing.remove(); return; }
      if (existing instanceof HTMLElement && existing.parentElement === modeButton.parentElement) return;
      if (existing instanceof HTMLElement) existing.remove();
      const wrapper = document.createElement('span');
      wrapper.setAttribute('data-dsh-patrol-hero-controls', '');
      wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:4px';
      const run = document.createElement('button'); run.type = 'button'; run.textContent = '▶ 运行流程'; run.style.cssText = 'height:28px;padding:0 9px;border:1px solid rgba(127,127,127,.24);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px';
      run.addEventListener('click', () => createHeroFlowChooser(ctx, sessionId, workspaceForSession(ctx, sessionId)));
      const browser = document.createElement('button'); browser.type = 'button'; browser.textContent = '浏览器设置'; browser.style.cssText = run.style.cssText;
      browser.addEventListener('click', async () => {
        browser.disabled = true;
        try { const result = await writeBrowserVisibility(visibility === false); visibility = result.visible; browser.textContent = visibility ? '浏览器：显示' : '浏览器：后台'; }
        catch (error) { browser.title = errorMessage(error); }
        finally { browser.disabled = false; }
      });
      wrapper.append(run, browser); modeButton.parentElement.appendChild(wrapper); void syncVisibility(browser);
    };
    const schedule = () => { if (scheduled) return; scheduled = true; queueMicrotask(place); };
    const observer = new MutationObserver(schedule); observer.observe(document.body, { childList: true, subtree: true });
    const stopSessions = ctx.sessions.list.subscribe(schedule); place();
    return () => { observer.disconnect(); stopSessions(); const existing = document.querySelector(HERO_CONTROLS_SELECTOR); if (existing instanceof HTMLElement) existing.remove(); };
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
    const response = await fetch(`${TOTP_API_ROOT}/session`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    });
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

  function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('二维码图片读取失败'));
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('二维码图片读取失败'));
      reader.readAsDataURL(file);
    });
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
    const [liveCodes, setLiveCodes] = React.useState({});
    const [profileId, setProfileId] = React.useState('');
    const [uri, setUri] = React.useState('');
    const [status, setStatus] = React.useState('正在读取本机令牌配置…');
    const [statusError, setStatusError] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const fileRef = React.useRef(null);

    const reload = React.useCallback(async () => {
      try {
        const payload = await loadTotpSession();
        const next = Array.isArray(payload.profiles) ? payload.profiles : [];
        setCsrf(payload.csrf);
        setProfiles(next);
        setStatus(`已加载 ${next.length} 个令牌配置。`);
        setStatusError(false);
      } catch (error) {
        setStatus(errorMessage(error));
        setStatusError(true);
      }
    }, []);

    React.useEffect(() => { reload(); }, [reload]);

    React.useEffect(() => {
      if (!csrf || profiles.length === 0) {
        setLiveCodes({});
        return undefined;
      }
      let cancelled = false;
      const refreshLiveCodes = async () => {
        try {
          const payload = await totpPost('preview', csrf, { profileIds: profiles.map(profile => profile.id) });
          if (cancelled) return;
          const next = {};
          for (const item of Array.isArray(payload.codes) ? payload.codes : []) {
            if (item && typeof item.profileId === 'string' && typeof item.code === 'string') next[item.profileId] = item;
          }
          setLiveCodes(next);
        } catch (error) {
          if (!cancelled) console.warn('[dsh-patrol] TOTP preview refresh failed:', errorMessage(error));
        }
      };
      refreshLiveCodes();
      const timer = window.setInterval(refreshLiveCodes, 1000);
      return () => { cancelled = true; window.clearInterval(timer); };
    }, [csrf, profiles]);

    const importProfile = async () => {
      const id = profileId.trim();
      const value = uri.trim();
      if (id && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) { setStatus('Profile ID 格式不正确。'); setStatusError(true); return; }
      if (!value) { setStatus('请粘贴 TOTP 导入内容。'); setStatusError(true); return; }
      setBusy(true);
      try {
        const payload = await totpPost('import', csrf, { profileId: id, payload: value });
        const imported = Array.isArray(payload.imported) ? payload.imported : [];
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setUri('');
        setStatus(`已安全导入 ${imported.length || 1} 个令牌。`);
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
      if (!csrf) { setStatus('TOTP 管理会话尚未就绪，请先点击刷新。'); setStatusError(true); return; }
      const id = profileId.trim();
      if (id && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) { setStatus('Profile ID 格式不正确。'); setStatusError(true); return; }
      setBusy(true);
      try {
        const image = await readFileDataUrl(file);
        const payload = await totpPost('import-image', csrf, { profileId: id, image });
        const imported = Array.isArray(payload.imported) ? payload.imported : [];
        setProfiles(Array.isArray(payload.profiles) ? payload.profiles : []);
        setUri('');
        setStatus(`二维码识别并导入成功，共 ${imported.length || 1} 个令牌。`);
        setStatusError(false);
      } catch (error) {
        setStatus(errorMessage(error));
        setStatusError(true);
      } finally {
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
      React.createElement('div', { style: { ...CARD, color: MUTED, fontSize: '12px', lineHeight: 1.65, marginBottom: '10px' } }, '支持标准 otpauth、Authing 导出二维码和 Google Authenticator 迁移二维码。二维码只在本机解码，TOTP seed 使用 Patrol vault 加密保存；本机令牌页可查看当前动态码，Patrol 自动巡检工具与 Runbook 不会回显或保存这些动态数字。'),
      React.createElement('div', { role: statusError ? 'alert' : 'status', style: { minHeight: '20px', color: statusError ? '#dc2626' : MUTED, fontSize: '12px', marginBottom: '10px' } }, status),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, margin: '10px 0 8px' } }, '已配置令牌'),
      profiles.length === 0
        ? React.createElement('div', { style: { ...CARD, color: MUTED, fontSize: '12px', marginBottom: '14px' } }, '还没有配置 TOTP 令牌。')
        : React.createElement('div', { style: { display: 'grid', gap: '8px', marginBottom: '16px' } }, profiles.map(profile => {
          const live = liveCodes[profile.id];
          return React.createElement('div', { key: profile.id, style: { ...CARD, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' } },
            React.createElement('div', { style: { minWidth: 0, flex: '1 1 160px' } },
              React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' } }, profile.issuer || profile.label || profile.id),
              React.createElement('div', { style: { color: MUTED, fontSize: '11px', marginTop: '3px' } }, `${profile.account || ''} · ${profile.id} · ${profile.digits || 6}位/${profile.period || 30}s`),
            ),
            React.createElement('div', { 'data-dsh-patrol-totp-preview': profile.id, style: { minWidth: '118px', textAlign: 'center' } },
              React.createElement('div', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '24px', fontWeight: 760, letterSpacing: '3px', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' } }, live?.code || '------'),
              React.createElement('div', { style: { color: MUTED, fontSize: '10px', marginTop: '4px' } }, live ? `${live.validForSeconds}s 后刷新` : '正在生成当前码…'),
            ),
            React.createElement('button', { type: 'button', style: BUTTON, disabled: busy, onClick: () => removeProfile(profile.id) }, '删除'),
          );
        })),
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 650, margin: '10px 0 8px' } }, '导入令牌'),
      React.createElement('input', { value: profileId, onChange: event => setProfileId(event.target.value), disabled: busy, placeholder: 'Profile ID（可选；批量导入时作为前缀）', autoComplete: 'off', style: INPUT }),
      React.createElement('input', { value: uri, onChange: event => setUri(event.target.value), disabled: busy, placeholder: '粘贴 otpauth://、otpauth-migration:// 或 Authing 导出 JSON', type: 'password', autoComplete: 'off', spellCheck: false, style: { ...INPUT, marginTop: '8px' }, 'data-dsh-patrol-totp-uri': 'true' }),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } },
        React.createElement('button', { type: 'button', style: BUTTON, disabled: busy || !csrf, onClick: importProfile }, busy ? '处理中…' : '导入'),
        React.createElement('button', { type: 'button', style: BUTTON, disabled: busy, onClick: () => fileRef.current?.click() }, '导入二维码图片'),
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
    const existing = document.querySelector('style[data-dsh-patrol-token-entry-style]');
    if (existing instanceof HTMLStyleElement) return () => {};
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

  function mountTokenSidebarEntry(openTokenSurface) {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function' || !document.body) return () => {};
    const existing = document.querySelector(TOTP_ENTRY_SELECTOR);
    if (existing instanceof HTMLElement) return () => {};
    const disposeStyle = installTokenEntryStyles();
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.setAttribute('data-dsh-patrol-token-entry', '');
    entry.setAttribute('data-dsh-plugin', 'patrol-token');
    entry.setAttribute('data-dsh-part', 'sidebar-entry');
    entry.title = '令牌';
    entry.innerHTML = '<span style="display:inline-flex;width:22px;justify-content:center"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5v3.75l2.35 1.55"/></svg></span><span class="dsh-patrol-token-label">令牌</span>';
    entry.addEventListener('click', () => {
      if (typeof openTokenSurface === 'function' && openTokenSurface()) return;
      window.dispatchEvent(new Event(TOTP_OPEN_EVENT));
    });

    let root;
    let scheduled = false;
    const place = () => {
      scheduled = false;
      root = sidebarRoot();
      if (!root) return;
      const ssh = root.querySelector('[data-dsh-ssh-entry]');
      if (ssh instanceof HTMLElement && ssh.parentElement === root) {
        if (entry.parentElement !== root || entry.previousElementSibling !== ssh) root.insertBefore(entry, ssh.nextElementSibling);
      } else {
        const button = root.querySelector('button[class*="newSession"]') || Array.from(root.children).find(child => child instanceof HTMLButtonElement);
        if (button instanceof HTMLElement && (entry.parentElement !== root || entry.previousElementSibling !== button)) root.insertBefore(entry, button.nextElementSibling);
      }
      const rail = root.getBoundingClientRect().width <= 88;
      if (rail && !entry.hasAttribute('data-rail')) entry.setAttribute('data-rail', 'true');
      else if (!rail && entry.hasAttribute('data-rail')) entry.removeAttribute('data-rail');
    };
    const schedulePlace = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(place);
    };
    const observer = new MutationObserver(schedulePlace);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedulePlace);
    place();
    return () => { observer.disconnect(); window.removeEventListener('resize', schedulePlace); entry.remove(); disposeStyle(); };
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

    const openTokenTab = () => {
      if (!betterSidebar || typeof betterSidebar.openTab !== 'function') return false;
      try {
        betterSidebar.openTab({ type: TOTP_TAB_ID, title: '令牌', path: 'dsh-patrol://totp' });
        return true;
      } catch (error) {
        console.warn('[dsh-patrol] Better Sidebar token tab open failed; using dialog fallback:', error);
        return false;
      }
    };

    const footerDispose = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action', id: 'dsh-patrol-token-bridge', order: 1000,
      inject: () => ({ openTokenTab }),
    }, TokenDialogBridge));
    const entryDispose = mountTokenSidebarEntry(openTokenTab);
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
    const latest = candidates[candidates.length - 1];
    return latest ? latest.id : '';
  }

  function canSubmitDraft(inputActions) {
    return inputActions
      && typeof inputActions.setDraft === 'function'
      && typeof inputActions.submit === 'function';
  }

  function DashboardFrame({ useSession, workspaceRoot, mode, inputActions }) {
    const iframeRef = React.useRef(null);
    const nodes = useSession(snapshot => snapshot.nodes);
    const runningCalls = useSession(snapshot => snapshot.runningCalls);
    const current = React.useMemo(() => currentInspectionId(nodes, runningCalls), [nodes, runningCalls]);
    const src = React.useMemo(() => {
      const params = new URLSearchParams({ mode, workspace: workspaceRoot || '' });
      if (mode === 'flows' && current) params.set('current', current);
      return `${DASHBOARD_UI}?${params.toString()}`;
    }, [mode, workspaceRoot, current]);

    React.useEffect(() => {
      const onMessage = event => {
        if (event.origin !== window.location.origin) return;
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data;
        if (!data || data.type !== 'dsh-patrol:run-flow') return;
        const inspectionId = String(data.inspectionId || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(inspectionId)) return;
        if (!canSubmitDraft(inputActions)) {
          console.warn('[dsh-patrol] conversation input actions are unavailable; cannot submit Patrol flow replay');
          return;
        }
        inputActions.setDraft(flowReplayPrompt(inspectionId, String(data.flowName || inspectionId).trim()));
        setTimeout(() => inputActions.submit(), 0);
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [inputActions]);

    return React.createElement('iframe', {
      ref: iframeRef,
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
        return { workspaceRoot: workspaceForSession(ctx, sessionId) };
      },
    }, Component));
  }

  function currentSessionUsesPatrol(ctx, requestedSessionId) {
    const state = ctx.sessions.list.getSnapshot();
    const sessionId = requestedSessionId === undefined ? state.current : requestedSessionId;
    if (sessionId === undefined) return false;
    const summary = state.byId && state.byId[sessionId];
    if (!summary) return false;
    if (summary.agentPreset === PATROL_PRESET_ID) return true;
    return summary.projectionValues && summary.projectionValues.agentPreset === PATROL_PRESET_ID;
  }

  exports.name = 'dsh-patrol-client-host';
  exports.inject = ['slots', 'sessions', 'inputTriggers'];
  exports.apply = function apply(ctx) {
    ctx.effect(() => registerTokenSurfaces(ctx), 'dsh-patrol-client-host: token management surfaces');
    ctx.effect(() => registerPatrolFlowReferenceSource(ctx), 'dsh-patrol-client-host: Patrol flow @ references');
    ctx.effect(() => registerPatrolHeaderControls(ctx), 'dsh-patrol-client-host: Patrol runtime header controls');
    ctx.effect(() => mountPatrolHeroControls(ctx), 'dsh-patrol-client-host: blank-conversation Patrol controls');
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
