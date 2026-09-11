// Intent-aware semantic click fallback.
//
// Some splash/SSO pages render a visible brand name next to (or around) a logo,
// while the actual clickable node is an <img>/<svg> whose accessible name is
// empty or only contains a source URL. A model can therefore observe text such
// as "长城网际" and correctly request "点击 Logo", yet an over-specific
// locatorText would reject the real logo before the strong logo intent score is
// considered. For an explicit logo task only, retry a target-not-found result
// once without locatorText. Ambiguity and actionability errors still fail closed.

const semanticIntentPreviousHandleCommand = handleCommand

handleCommand = async function semanticIntentFallbackHandleCommand(cmd, args = {}) {
  if (cmd !== 'semanticClick') return await semanticIntentPreviousHandleCommand(cmd, args)
  try {
    return await semanticIntentPreviousHandleCommand(cmd, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const explicitLogoIntent = /logo|徽标|标志/i.test(String(args?.task || ''))
    const hasTextLocator = typeof args?.locatorText === 'string' && args.locatorText.trim() !== ''
    if (!explicitLogoIntent || !hasTextLocator || !/atomic semantic target not found/i.test(message)) throw error

    return await semanticIntentPreviousHandleCommand(cmd, {
      ...args,
      locatorText: undefined,
    })
  }
}
