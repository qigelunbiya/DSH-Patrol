import type { JsonObject, SemanticLocator, StepCondition, TextExpectation } from './types.js'

export interface StepExecutionNoteInput {
  tool: string
  args: JsonObject
  locator?: SemanticLocator
  expectation?: TextExpectation
  when?: StepCondition
  providedNotes?: string | undefined
}

export function stepExecutionNotes(input: StepExecutionNoteInput): string {
  const lines = input.providedNotes?.trim() ? [input.providedNotes.trim()] : []
  const hints = actionHints(input.tool, input.args)
  if (input.locator !== undefined) hints.push(`语义目标：${formatLocator(input.locator)}`)
  if (input.when !== undefined) hints.push(`执行条件：当 ${input.when.sourceStepId} ${input.when.mode} ${JSON.stringify(input.when.value)} 时执行。`)
  if (input.expectation !== undefined) hints.push(`成功判定：结果文本应 ${input.expectation.mode} ${JSON.stringify(input.expectation.value)}。`)
  if (hints.length > 0) lines.push(`执行方法：${hints.join(' ')}`)
  return lines.join('\n')
}

function actionHints(tool: string, args: JsonObject): string[] {
  if (tool === 'browser_navigate') {
    const url = stringArg(args, 'url')
    return [url === undefined ? '打开目标页面。' : `导航到 ${url}。`]
  }
  if (tool === 'browser_click') {
    const selector = stringArg(args, 'selector')
    return [selector === undefined ? '点击当前已解析的可见目标。' : `点击 selector ${selector}。`]
  }
  if (tool === 'browser_type' || tool === 'browser_type_credential' || tool === 'browser_type_transient_ref' || tool === 'browser_type_totp_profile') {
    const selector = stringArg(args, 'selector')
    return [selector === undefined ? '向目标输入框填写值。' : `向 selector ${selector} 填写值。`]
  }
  if (tool === 'browser_count') {
    const selector = stringArg(args, 'selector')
    return [selector === undefined ? '统计当前页面目标元素数量。' : `统计 selector ${selector} 的可见元素数量。`]
  }
  if (tool === 'browser_wait') {
    const selector = stringArg(args, 'selector')
    const timeout = numberArg(args, 'timeoutMs')
    return [selector === undefined ? `等待页面稳定${timeout === undefined ? '' : `，超时 ${timeout}ms`}。` : `等待 selector ${selector} 出现${timeout === undefined ? '' : `，超时 ${timeout}ms`}。`]
  }
  if (tool === 'browser_read_page') return ['读取当前页面可见文本，作为本步骤产物供后续摘要/断言使用。']
  if (tool === 'browser_screenshot') return ['截取当前页面画面，作为本步骤产物供巡检记录查看。']
  if (tool === 'browser_scroll') return ['滚动当前页面到目标内容区域。']
  if (tool === 'browser_press') return ['向当前焦点或目标元素发送按键。']
  return []
}

function formatLocator(locator: SemanticLocator): string {
  return [
    locator.text === undefined ? undefined : `text=${JSON.stringify(locator.text)}`,
    locator.role === undefined ? undefined : `role=${locator.role}`,
    locator.tag === undefined ? undefined : `tag=${locator.tag}`,
  ].filter(Boolean).join(', ')
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' ? value : undefined
}
