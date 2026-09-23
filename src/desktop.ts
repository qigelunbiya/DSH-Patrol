import type { InspectionDefinition, JsonObject } from './types.js'

export const SAFE_DESKTOP_TOOLS = [
  'desktop_status',
  'desktop_list_windows',
  'desktop_launch_app',
  'desktop_open_path',
  'desktop_activate_window',
  'desktop_snapshot',
  'desktop_click_target',
  'desktop_click_ocr_text',
  'desktop_preview_visual_point',
  'desktop_focus_visual_region',
  'desktop_click_visual_point',
  'desktop_click_coordinates',
  'desktop_drag',
  'desktop_type_text',
  'desktop_type_target',
  'desktop_paste_target',
  'desktop_press_target',
  'desktop_hotkey',
  'desktop_press',
  'desktop_wait',
  'desktop_wait_for_target',
  'desktop_screenshot',
  'desktop_ocr',
  'desktop_set_clipboard_text',
  'desktop_set_clipboard_files',
  'desktop_paste',
  'desktop_close_window',
  'desktop_delete_path',
  'desktop_list_app_guides',
  'desktop_read_app_guide',
] as const

export type SafeDesktopTool = typeof SAFE_DESKTOP_TOOLS[number]

export const REPLAYABLE_DESKTOP_TOOLS = [
  'desktop_launch_app',
  'desktop_open_path',
  'desktop_activate_window',
  'desktop_snapshot',
  'desktop_click_target',
  'desktop_click_ocr_text',
  'desktop_click_visual_point',
  'desktop_click_coordinates',
  'desktop_drag',
  'desktop_type_text',
  'desktop_type_target',
  'desktop_paste_target',
  'desktop_press_target',
  'desktop_hotkey',
  'desktop_press',
  'desktop_wait',
  'desktop_wait_for_target',
  'desktop_screenshot',
  'desktop_ocr',
  'desktop_set_clipboard_text',
  'desktop_set_clipboard_files',
  'desktop_paste',
  'desktop_close_window',
  'desktop_delete_path',
] as const

export type ReplayableDesktopTool = typeof REPLAYABLE_DESKTOP_TOOLS[number]

export const DESKTOP_ACTIONS = [
  'launch-app',
  'open-path',
  'activate-window',
  'snapshot',
  'click-target',
  'click-ocr-text',
  'click-visual-point',
  'click-coordinates',
  'drag',
  'type-text',
  'type-target',
  'paste-target',
  'press-target',
  'hotkey',
  'press',
  'wait',
  'wait-for-target',
  'screenshot',
  'ocr',
  'set-clipboard-text',
  'set-clipboard-files',
  'paste',
  'close-window',
  'delete-path',
] as const

export type DesktopAction = typeof DESKTOP_ACTIONS[number]

export const DESKTOP_ACTION_TOOL: Record<DesktopAction, ReplayableDesktopTool> = {
  'launch-app': 'desktop_launch_app',
  'open-path': 'desktop_open_path',
  'activate-window': 'desktop_activate_window',
  snapshot: 'desktop_snapshot',
  'click-target': 'desktop_click_target',
  'click-ocr-text': 'desktop_click_ocr_text',
  'click-visual-point': 'desktop_click_visual_point',
  'click-coordinates': 'desktop_click_coordinates',
  drag: 'desktop_drag',
  'type-text': 'desktop_type_text',
  'type-target': 'desktop_type_target',
  'paste-target': 'desktop_paste_target',
  'press-target': 'desktop_press_target',
  hotkey: 'desktop_hotkey',
  press: 'desktop_press',
  wait: 'desktop_wait',
  'wait-for-target': 'desktop_wait_for_target',
  screenshot: 'desktop_screenshot',
  ocr: 'desktop_ocr',
  'set-clipboard-text': 'desktop_set_clipboard_text',
  'set-clipboard-files': 'desktop_set_clipboard_files',
  paste: 'desktop_paste',
  'close-window': 'desktop_close_window',
  'delete-path': 'desktop_delete_path',
}


const DESKTOP_WINDOW_SCOPED_TOOLS = new Set<string>([
  'desktop_activate_window',
  'desktop_snapshot',
  'desktop_click_target',
  'desktop_click_ocr_text',
  'desktop_preview_visual_point',
  'desktop_focus_visual_region',
  'desktop_click_visual_point',
  'desktop_type_text',
  'desktop_type_target',
  'desktop_paste_target',
  'desktop_press_target',
  'desktop_hotkey',
  'desktop_press',
  'desktop_wait_for_target',
  'desktop_screenshot',
  'desktop_ocr',
  'desktop_paste',
  'desktop_close_window',
])

export function applyDesktopTargetDefaults(
  definition: InspectionDefinition,
  tool: string,
  args: JsonObject,
): JsonObject {
  if (definition.target.type !== 'desktop' || !DESKTOP_WINDOW_SCOPED_TOOLS.has(tool)) return args
  if (args.scope === 'screen') return args
  if (['processName', 'title', 'titleContains'].some(key => typeof args[key] === 'string' && String(args[key]).trim() !== '')) return args
  const defaults: JsonObject = {}
  if (definition.target.processName !== undefined) defaults.processName = definition.target.processName
  if (definition.target.titleContains !== undefined) defaults.titleContains = definition.target.titleContains
  return Object.keys(defaults).length === 0 ? args : { ...args, ...defaults }
}

export const LAST_SCREENSHOT_ARTIFACT = '${artifact:last-screenshot}'

export function isSafeDesktopTool(name: string): name is SafeDesktopTool {
  return (SAFE_DESKTOP_TOOLS as readonly string[]).includes(name)
}

export function isReplayableDesktopTool(name: string): name is ReplayableDesktopTool {
  return (REPLAYABLE_DESKTOP_TOOLS as readonly string[]).includes(name)
}

export function desktopToolForAction(action: DesktopAction): ReplayableDesktopTool {
  return DESKTOP_ACTION_TOOL[action]
}

export function desktopArtifactForTool(tool: string): 'screenshot' | undefined {
  return tool === 'desktop_screenshot' ? 'screenshot' : undefined
}

export function desktopArgumentsContainEphemeralWindowIdentity(args: JsonObject): boolean {
  return 'hwnd' in args || 'processId' in args
}
