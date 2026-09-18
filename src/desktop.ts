import type { JsonObject } from './types.js'

export const SAFE_DESKTOP_TOOLS = [
  'desktop_status',
  'desktop_list_windows',
  'desktop_launch_app',
  'desktop_open_path',
  'desktop_activate_window',
  'desktop_snapshot',
  'desktop_click_target',
  'desktop_click_ocr_text',
  'desktop_click_coordinates',
  'desktop_drag',
  'desktop_type_text',
  'desktop_hotkey',
  'desktop_press',
  'desktop_wait',
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
  'desktop_click_coordinates',
  'desktop_drag',
  'desktop_type_text',
  'desktop_hotkey',
  'desktop_press',
  'desktop_wait',
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
  'click-coordinates',
  'drag',
  'type-text',
  'hotkey',
  'press',
  'wait',
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
  'click-coordinates': 'desktop_click_coordinates',
  drag: 'desktop_drag',
  'type-text': 'desktop_type_text',
  hotkey: 'desktop_hotkey',
  press: 'desktop_press',
  wait: 'desktop_wait',
  screenshot: 'desktop_screenshot',
  ocr: 'desktop_ocr',
  'set-clipboard-text': 'desktop_set_clipboard_text',
  'set-clipboard-files': 'desktop_set_clipboard_files',
  paste: 'desktop_paste',
  'close-window': 'desktop_close_window',
  'delete-path': 'desktop_delete_path',
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
