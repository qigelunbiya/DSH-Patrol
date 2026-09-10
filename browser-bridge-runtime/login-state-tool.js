import { defineTool } from '@deepseek-ai/dsh-tools'

const reqBool = { type: 'boolean', required: true }
const reqStr = { type: 'string', required: true }
const optInt = { type: 'integer' }

const LOGIN_HINT = /(login|log[-_ ]?in|sign[-_ ]?in|signin|password|passwd|pwd|username|user[-_ ]?name|登录|登陆|用户名|密码)/i
const AUTHENTICATED_HINT = /(logout|log[-_ ]?out|sign[-_ ]?out|signout|dashboard|workbench|control\s*panel|退出|注销|个人信息|修改密码|我的工作台|主机运维|控制板)/i

export function classifyLoginState(snapshot) {
  const url = typeof snapshot?.url === 'string' ? snapshot.url : ''
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  const visiblePassword = elements.find(element => String(element?.type ?? '').toLowerCase() === 'password')
  const loginHint = elements.find(element => LOGIN_HINT.test([
    element?.selector,
    element?.name,
    element?.text,
    element?.type,
  ].filter(Boolean).join(' ')))
  const authenticatedHint = elements.find(element => AUTHENTICATED_HINT.test([
    element?.selector,
    element?.name,
    element?.text,
    element?.title,
    element?.ariaLabel,
  ].filter(Boolean).join(' ')))
  const loginUrl = /(?:^|[\/#?&])(login|signin|sign-in)(?:[\/#?&=]|$)/i.test(url)

  if (visiblePassword !== undefined) {
    return { state: 'login-required', reason: 'visible-password-field', url }
  }
  if (loginUrl && loginHint !== undefined) {
    return { state: 'login-required', reason: 'login-page-controls', url }
  }
  if (authenticatedHint !== undefined) {
    return { state: 'authenticated', reason: 'positive-authenticated-control', url }
  }
  return {
    state: 'unknown',
    reason: loginUrl ? 'login-url-without-visible-form' : 'no-positive-authenticated-evidence',
    url,
  }
}

export function registerLoginStateTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_login_state',
    description: 'Detect whether the current page requires login or already has an authenticated application session. Authentication is reported only when positive application evidence is visible; absence of a login form alone is never treated as authenticated. This never reads or returns cookie values.',
    parameters: { tabId: optInt },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          state: { type: 'string', required: true, enum: ['authenticated', 'login-required', 'unknown'] },
          reason: reqStr,
          url: reqStr,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `login-state=${value.state}; reason=${value.reason}; url=${value.url}` }],
    },
    presentCall: args => ({ card: 'generic', title: 'Check Patrol login state', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      const snapshot = await bridge.request('snapshot', {
        tabId: args.tabId,
        maxElements: 300,
        includeHidden: false,
      }, { timeoutMs, signal: exec?.signal })
      if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) {
        throw new Error(String(snapshot?.error || 'login-state snapshot failed'))
      }
      return { ok: true, ...classifyLoginState(snapshot) }
    },
  })
  return ctx.tools.register(definition)
}
