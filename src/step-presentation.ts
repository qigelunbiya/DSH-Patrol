import type { InspectionDefinition, JsonObject, ToolStep } from './types.js'

export type StepExecutionPlane = 'browser' | 'desktop'

export function stepExecutionPlane(step: Pick<ToolStep, 'tool'>): StepExecutionPlane | undefined {
  if (step.tool.startsWith('browser_')) return 'browser'
  if (step.tool.startsWith('desktop_')) return 'desktop'
  return undefined
}

export function enrichStepPresentation(definition: InspectionDefinition): InspectionDefinition {
  for (const step of definition.steps) {
    if (step.kind !== 'tool') continue
    const plane = stepExecutionPlane(step)
    if (plane !== undefined && step.executionPlane === undefined) step.executionPlane = plane
    if (plane === 'desktop' && (!step.executionInstruction || !step.executionInstruction.trim())) {
      step.executionInstruction = describeDesktopExecution(step.tool, step.arguments, step.name)
    }
  }
  return definition
}

export function describeDesktopExecution(tool: string, args: JsonObject, fallbackName = '桌面应用步骤'): string {
  const target = desktopWindowTarget(args)
  const quoted = (value: unknown) => typeof value === 'string' && value.trim() ? `“${value.trim()}”` : ''
  switch (tool) {
    case 'desktop_launch_app':
      return `启动桌面应用${quoted(args.app) || quoted(args.file) || ''}。`
    case 'desktop_activate_window':
      return `激活${target || '目标桌面应用'}窗口，使后续键盘和鼠标动作作用于该应用。`
    case 'desktop_snapshot':
      return `读取${target || '目标桌面应用'}的当前 UI 结构，用于确认当前界面和可操作控件。`
    case 'desktop_screenshot':
      return `截取${target || '目标桌面应用'}当前完整窗口画面，作为后续视觉定位和结果确认依据。`
    case 'desktop_click_target':
      return `在${target || '目标桌面应用'}中定位唯一控件${desktopTargetDescription(args)}并点击。`
    case 'desktop_click_ocr_text':
      return `在${target || '目标桌面应用'}当前画面中找到可见文字${quoted(args.text) || '对应目标'}并点击其文字区域中心。`
    case 'desktop_click_visual_point':
      return `根据${target || '目标桌面应用'}的 CURRENT 窗口截图识别“${fallbackName}”对应控件，在控件内部安全位置执行${args.button === 'right' ? '右键' : '左键'}点击；重放时应先重新截图并按当前界面重新定位，不依赖历史绝对屏幕坐标。`
    case 'desktop_click_coordinates':
      return `在当前桌面按已验证的屏幕坐标执行${args.button === 'right' ? '右键' : '左键'}点击；仅在没有更稳定的 UIA/OCR/视觉目标时使用。`
    case 'desktop_type_text':
      return `在${target || '目标桌面应用'}当前已聚焦的输入控件中输入步骤要求的文本${args.clear === true ? '，输入前清空原内容' : ''}。`
    case 'desktop_type_target':
      return `在${target || '目标桌面应用'}中定位${desktopTargetDescription(args)}，聚焦后输入步骤要求的文本${args.clear === true ? '，输入前清空原内容' : ''}。`
    case 'desktop_hotkey':
      return `激活${target || '目标桌面应用'}后按快捷键 ${String(args.combo || '')}。`
    case 'desktop_press':
      return `激活${target || '目标桌面应用'}后按键 ${String(args.key || '')}。`
    case 'desktop_paste':
      return `激活${target || '目标桌面应用'}，在当前已确认的输入区粘贴剪贴板内容。`
    case 'desktop_paste_target':
      return `在${target || '目标桌面应用'}中定位${desktopTargetDescription(args)}，聚焦后粘贴剪贴板内容。`
    case 'desktop_press_target':
      return `在${target || '目标桌面应用'}中定位${desktopTargetDescription(args)}，聚焦后按键 ${String(args.key || '')}。`
    case 'desktop_set_clipboard_text':
      return '把本步骤需要传递给桌面应用的业务文本写入剪贴板；动态内容应使用本轮前序步骤实际提取的结果，而不是依赖历史固定文本。'
    case 'desktop_set_clipboard_files':
      return '把前序步骤生成或选择的文件放入剪贴板，供后续桌面应用粘贴。'
    case 'desktop_wait_for_target':
      return `等待${target || '目标桌面应用'}出现${desktopTargetDescription(args)}，确认界面已进入下一可操作状态。`
    case 'desktop_wait':
      return `等待约 ${String(args.milliseconds || 0)} ms，让桌面界面完成没有稳定语义信号的短暂过渡。`
    case 'desktop_close_window':
      return `关闭${target || '目标桌面应用'}窗口。`
    default:
      return `在${target || '目标桌面应用'}中执行“${fallbackName}”；按本步骤保存的 desktop 工具参数执行，并以 CURRENT 界面结果确认成功。`
  }
}

function desktopWindowTarget(args: JsonObject): string {
  if (typeof args.title === 'string' && args.title.trim()) return `标题为“${args.title.trim()}”的`
  if (typeof args.titleContains === 'string' && args.titleContains.trim()) return `标题包含“${args.titleContains.trim()}”的`
  if (typeof args.processName === 'string' && args.processName.trim()) return `进程 ${args.processName.trim()} 的`
  return ''
}

function desktopTargetDescription(args: JsonObject): string {
  const parts: string[] = []
  if (typeof args.name === 'string' && args.name.trim()) parts.push(`名称“${args.name.trim()}”`)
  if (typeof args.automationId === 'string' && args.automationId.trim()) parts.push(`automationId=${args.automationId.trim()}`)
  if (typeof args.controlType === 'string' && args.controlType.trim()) parts.push(`controlType=${args.controlType.trim()}`)
  if (typeof args.className === 'string' && args.className.trim()) parts.push(`className=${args.className.trim()}`)
  if (typeof args.text === 'string' && args.text.trim() && parts.length === 0) parts.push(`可见文字“${args.text.trim()}”`)
  return parts.length ? parts.join('、') : '当前截图中与步骤语义一致的目标控件'
}
