window.__ModuleLoader__.load({ id: 'dsh-patrol', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react');

  const PATROL_TOOL = /^patrol_/u;
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

  function eventOf(entry) {
    return entry && entry.type === 'event' ? entry.event : null;
  }

  function contentText(message) {
    const content = message && Array.isArray(message.content) ? message.content : [];
    return content.map((block) => block && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n');
  }

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

  function collectPatrol(entries) {
    const calls = new Map();
    const ordered = [];
    for (const entry of entries) {
      const event = eventOf(entry);
      if (!event || event.type !== 'tool/call') continue;
      const data = event.data || {};
      if (typeof data.name !== 'string' || !PATROL_TOOL.test(data.name)) continue;
      const call = {
        callId: data.callId,
        name: data.name,
        args: parseArguments(data.arguments),
        seq: event.seq,
        time: event.time,
        result: null,
        isError: false,
      };
      calls.set(data.callId, call);
      ordered.push(call);
    }
    for (const entry of entries) {
      const event = eventOf(entry);
      if (!event || event.type !== 'tool/result') continue;
      const message = event.data && event.data.message;
      const callId = message && message.callId;
      const call = calls.get(callId);
      if (!call) continue;
      call.result = contentText(message);
      call.isError = Boolean(message.isError);
      call.resultSeq = event.seq;
      call.resultTime = event.time;
    }
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
      if (call.name === 'patrol_create_inspection' && call.args && typeof call.args === 'object') {
        existing.definition = call.args;
      }
      if (call.name === 'patrol_show' && call.result) existing.showResult = call.result;
      byInspection.set(key, existing);
    }
    if (byInspection.size > 0) return [...byInspection.values()].reverse();
    const recent = calls.slice(-8).reverse();
    return recent.length === 0 ? [] : [{ id: '当前巡检会话', calls: recent, definition: null }];
  }

  function useEventWindow(source) {
    const subscribe = React.useCallback((listener) => source.subscribe(listener), [source]);
    const getSnapshot = React.useCallback(() => source.getSnapshot(), [source]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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

  function FlowView({ eventSource, loadOlder }) {
    const windowState = useEventWindow(eventSource);
    const calls = React.useMemo(() => collectPatrol(windowState.entries), [windowState]);
    const cards = React.useMemo(() => flowCards(calls), [calls]);
    return React.createElement('div', { style: VIEW_STYLE },
      React.createElement('div', { style: HEADER_STYLE },
        React.createElement('div', null,
          React.createElement('h2', { style: TITLE_STYLE }, '流程管理'),
          React.createElement('div', { style: MUTED_STYLE }, '从当前巡检会话实时汇总巡检模板、目标与最近流程动作。'),
        ),
        React.createElement(LoadOlder, { hasMore: windowState.hasMore, loadOlder }),
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

  function RecordsView({ eventSource, loadOlder }) {
    const windowState = useEventWindow(eventSource);
    const calls = React.useMemo(() => collectPatrol(windowState.entries), [windowState]);
    const records = calls.slice().reverse();
    return React.createElement('div', { style: VIEW_STYLE },
      React.createElement('div', { style: HEADER_STYLE },
        React.createElement('div', null,
          React.createElement('h2', { style: TITLE_STYLE }, '巡检记录'),
          React.createElement('div', { style: MUTED_STYLE }, `当前已加载 ${records.length} 条 Patrol 工具记录，最新记录在前。`),
        ),
        React.createElement(LoadOlder, { hasMore: windowState.hasMore, loadOlder }),
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
          eventSource: binding.eventSource,
          loadOlder: async () => {
            const before = binding.eventSource.getSnapshot().revision;
            await binding.session.loadOlder();
            return binding.eventSource.getSnapshot().revision !== before;
          },
        };
      },
    }, Component));
  }

  exports.name = 'dsh-patrol-client';
  exports.inject = ['slots', 'sessions'];
  exports.apply = function apply(ctx) {
    registerView(ctx, 'patrol-flow', 30, '流程管理', FlowView);
    registerView(ctx, 'patrol-records', 40, '巡检记录', RecordsView);
  };

  return module.exports; } });
