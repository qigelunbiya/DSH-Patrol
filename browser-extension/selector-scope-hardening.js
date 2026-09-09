// Unqualified selectors are treated as top-document selectors first.
//
// New snapshots already emit top-frame:: / frame-url(...):: prefixes. This
// compatibility layer protects copied legacy selectors and model-authored raw
// CSS from becoming ambiguous merely because the same DOM shape exists in an
// iframe. If no visible top-document match exists, the previous all-frame route
// remains available for old iframe flows.

const selectorScopePreviousSendDomCommand = sendDomCommand
const SELECTOR_SCOPE_COMMANDS = new Set(['count', 'click', 'type'])

sendDomCommand = async function selectorScopeHardenedSendDomCommand(cmd, args = {}) {
  if (!SELECTOR_SCOPE_COMMANDS.has(cmd)) return await selectorScopePreviousSendDomCommand(cmd, args)
  const raw = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (!raw || raw.startsWith('top-frame::') || raw.startsWith('frame-url(')) {
    return await selectorScopePreviousSendDomCommand(cmd, args)
  }

  const topArgs = { ...args, selector: `top-frame::${raw}` }
  try {
    const top = await selectorScopePreviousSendDomCommand(cmd, topArgs)
    if (cmd !== 'count') return top
    const count = Number.isInteger(top?.count) ? top.count : 0
    if (count > 0) return { ...top, selector: raw, scope: 'top-document-preferred' }
  } catch (error) {
    if (!selectorScopeCanFallback(error)) throw error
  }

  return await selectorScopePreviousSendDomCommand(cmd, args)
}

function selectorScopeCanFallback(error) {
  const message = safeError(error).toLowerCase()
  return message.includes('element not found')
    || message.includes('not found or not visible')
    || message.includes('no eligible document frame')
    || message.includes('found no observable interactive elements')
}
