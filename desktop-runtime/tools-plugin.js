import { defineTool } from '@deepseek-ai/dsh-tools'
import { WindowsDesktopDriver } from './windows-driver.js'

export const name = 'dsh-patrol-desktop-tools'
export const inject = ['tools']

const str = { type: 'string' }
const reqStr = { type: 'string', required: true }
const int = { type: 'integer' }
const reqInt = { type: 'integer', required: true }
const bool = { type: 'boolean' }
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}
const jsonOutput = label => ({
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: `${label}\n${JSON.stringify(value, null, 2)}` }],
})

export function apply(ctx, config = {}) {
  const driver = new WindowsDesktopDriver({
    logger: ctx.logger,
    commandTimeoutMs: config.commandTimeoutMs ?? 30000,
    powerShell: config.powerShell,
  })

  const definitions = [
    defineTool({
      name: 'desktop_status',
      description: 'Report Desktop Automation availability. Windows uses UI Automation first, then keyboard, OCR, and coordinate fallbacks. Current Patrol desktop permission mode is unrestricted in both TEST and NORMAL modes.',
      parameters: {},
      output: jsonOutput('Desktop Automation status'),
      execute: async () => driver.status(),
    }),
    defineTool({
      name: 'desktop_list_windows',
      description: 'List visible top-level Windows desktop applications/windows. Use this before activating an unfamiliar application.',
      parameters: {},
      output: jsonOutput('Visible desktop windows'),
      execute: async (_args, exec) => await driver.run('list-windows', {}, exec),
    }),
    defineTool({
      name: 'desktop_launch_app',
      description: 'Launch a Windows application by executable path/name. This is a direct desktop action; no permission tier is currently applied.',
      parameters: {
        file: reqStr,
        arguments: { type: 'array', items: { type: 'string' } },
        workingDirectory: str,
      },
      output: jsonOutput('Application launched'),
      execute: async (args, exec) => await driver.run('launch-app', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_open_path',
      description: 'Open a file/folder/URI through the Windows shell/default associated application.',
      parameters: { path: reqStr },
      output: jsonOutput('Path opened'),
      execute: async (args, exec) => await driver.run('open-path', { path: args.path }, exec),
    }),
    defineTool({
      name: 'desktop_activate_window',
      description: 'Bring one desktop application window to the foreground. Prefer stable processName/titleContains selectors; processId/hwnd are allowed for live debugging but should not be persisted in Runbooks.',
      parameters: {
        processName: str,
        title: str,
        titleContains: str,
        processId: int,
        hwnd: { type: 'integer' },
      },
      output: jsonOutput('Window activated'),
      execute: async (args, exec) => await driver.run('activate-window', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_snapshot',
      description: 'Read the current Windows UI Automation tree for the active or selected application. This is the desktop equivalent of a browser DOM snapshot and should be preferred before OCR/coordinate guessing.',
      parameters: {
        processName: str,
        title: str,
        titleContains: str,
        processId: int,
        hwnd: { type: 'integer' },
        maxElements: int,
        includeOffscreen: bool,
      },
      output: jsonOutput('Desktop UI Automation snapshot'),
      execute: async (args, exec) => await driver.run('snapshot', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_click_target',
      description: 'Click one unique Windows UI Automation element by semantic name/automationId/controlType/className. Unnamed interactive controls such as Edit are included in snapshots, so controlType/className-only targeting is allowed when unique. Prefer this over OCR/coordinate clicking.',
      parameters: {
        name: str,
        automationId: str,
        controlType: str,
        className: str,
        match: { type: 'string', enum: ['exact', 'contains'] },
        index: int,
        processName: str,
        title: str,
        titleContains: str,
      },
      output: jsonOutput('Desktop target clicked'),
      execute: async (args, exec) => await driver.run('click-target', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_click_ocr_text',
      description: 'OCR semantic fallback: capture the CURRENT window/screen, find one unique OCR line by text, and click that line center. This stores semantic text rather than historical absolute coordinates and is preferred over desktop_click_coordinates when UI Automation cannot expose the target.',
      parameters: {
        text: reqStr,
        match: { type: 'string', enum: ['exact', 'contains'] },
        caseSensitive: bool,
        index: int,
        button: { type: 'string', enum: ['left', 'right'] },
        scope: { type: 'string', enum: ['active-window', 'screen'] },
        processName: str,
        title: str,
        titleContains: str,
        languages: { type: 'array', items: { type: 'string' } },
        fileName: str,
      },
      output: jsonOutput('Desktop OCR text clicked'),
      execute: async (args, exec) => await driver.clickOcrText(compact(args), exec),
    }),
    defineTool({
      name: 'desktop_click_coordinates',
      description: 'Coordinate-click fallback for desktop UI when UI Automation cannot expose the target. Use only after screenshot/OCR/current evidence provides the coordinates.',
      parameters: {
        x: reqInt,
        y: reqInt,
        button: { type: 'string', enum: ['left', 'right'] },
      },
      output: jsonOutput('Desktop coordinates clicked'),
      execute: async (args, exec) => await driver.run('click-coordinates', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_drag',
      description: 'Drag the mouse between two known screen coordinates. Intended as a last-resort visual fallback.',
      parameters: {
        fromX: reqInt,
        fromY: reqInt,
        toX: reqInt,
        toY: reqInt,
        durationMs: int,
      },
      output: jsonOutput('Desktop drag completed'),
      execute: async (args, exec) => await driver.run('drag', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_type_text',
      description: 'Type text into the focused desktop control using clipboard paste. Optional clear=true sends Ctrl+A first.',
      parameters: { text: reqStr, clear: bool },
      output: jsonOutput('Desktop text typed'),
      execute: async (args, exec) => await driver.run('type-text', { text: args.text, clear: args.clear ?? false }, exec),
    }),
    defineTool({
      name: 'desktop_hotkey',
      description: 'Send a desktop keyboard shortcut such as Ctrl+F, Ctrl+S, Ctrl+Shift+S, Alt+F4. Supports Ctrl/Alt/Shift modifiers.',
      parameters: { combo: reqStr },
      output: jsonOutput('Desktop hotkey sent'),
      execute: async (args, exec) => await driver.run('hotkey', { combo: args.combo }, exec),
    }),
    defineTool({
      name: 'desktop_press',
      description: 'Press one desktop key such as Enter, Esc, Tab, Delete, arrows, or F1-F12.',
      parameters: { key: reqStr },
      output: jsonOutput('Desktop key pressed'),
      execute: async (args, exec) => await driver.run('press', { key: args.key }, exec),
    }),
    defineTool({
      name: 'desktop_wait',
      description: 'Wait a bounded amount of time for a desktop application to finish rendering.',
      parameters: { milliseconds: { type: 'integer', required: true } },
      output: jsonOutput('Desktop wait completed'),
      execute: async (args, exec) => await driver.run('wait', { milliseconds: args.milliseconds }, exec),
    }),
    defineTool({
      name: 'desktop_wait_for_target',
      description: 'Wait for a semantic desktop target to become available instead of sleeping a fixed duration. source=auto checks UI Automation first and then OCR text when text is available. By default the target must be unique; set requireUnique=false only when mere presence is enough.',
      parameters: {
        source: { type: 'string', enum: ['auto', 'uia', 'ocr'] },
        name: str,
        automationId: str,
        controlType: str,
        className: str,
        text: str,
        match: { type: 'string', enum: ['exact', 'contains'] },
        caseSensitive: bool,
        requireUnique: bool,
        processName: str,
        title: str,
        titleContains: str,
        scope: { type: 'string', enum: ['active-window', 'screen'] },
        languages: { type: 'array', items: { type: 'string' } },
        maxElements: int,
        timeoutMs: int,
        pollMs: int,
      },
      output: jsonOutput('Desktop target ready'),
      execute: async (args, exec) => await driver.waitForTarget(compact(args), exec),
    }),
    defineTool({
      name: 'desktop_screenshot',
      description: 'Capture the active desktop window or the whole virtual screen as a PNG under the current Harness workspace patrol-results/desktop-captures.',
      parameters: {
        scope: { type: 'string', enum: ['active-window', 'screen'] },
        processName: str,
        title: str,
        titleContains: str,
        fileName: str,
      },
      output: jsonOutput('Desktop screenshot captured'),
      execute: async (args, exec) => await driver.screenshot(compact(args), exec),
    }),
    defineTool({
      name: 'desktop_ocr',
      description: 'Capture the active desktop window/screen and run bundled Windows system OCR. Returns recognized line text plus absolute screen rect/center coordinates so coordinate fallback can use CURRENT OCR evidence when UI Automation is unavailable.',
      parameters: {
        scope: { type: 'string', enum: ['active-window', 'screen'] },
        processName: str,
        title: str,
        titleContains: str,
        fileName: str,
        languages: { type: 'array', items: { type: 'string' }, description: 'Optional preferred OCR languages. Patrol also tries the current locale, zh-CN and en-US in a bounded set of passes.' },
      },
      output: jsonOutput('Desktop OCR result'),
      execute: async (args, exec) => await driver.ocr(compact(args), exec),
    }),
    defineTool({
      name: 'desktop_set_clipboard_text',
      description: 'Set Windows clipboard text. Useful before paste-based desktop workflows.',
      parameters: { text: reqStr },
      output: jsonOutput('Desktop clipboard text set'),
      execute: async (args, exec) => await driver.run('set-clipboard-text', { text: args.text }, exec),
    }),
    defineTool({
      name: 'desktop_set_clipboard_files',
      description: 'Put one or more existing files on the Windows clipboard as a FileDropList so applications such as WeChat can receive them via paste. Replay supports the special path ${artifact:last-screenshot}.',
      parameters: { paths: { type: 'array', required: true, items: { type: 'string' } } },
      output: jsonOutput('Desktop clipboard files set'),
      execute: async (args, exec) => await driver.run('set-clipboard-files', { paths: args.paths }, exec),
    }),
    defineTool({
      name: 'desktop_paste',
      description: 'Send Ctrl+V to the active desktop application.',
      parameters: {},
      output: jsonOutput('Desktop paste sent'),
      execute: async (_args, exec) => await driver.run('paste', {}, exec),
    }),
    defineTool({
      name: 'desktop_close_window',
      description: 'Close a selected top-level desktop window via WM_CLOSE. No permission tier is currently applied.',
      parameters: { processName: str, title: str, titleContains: str, processId: int, hwnd: { type: 'integer' } },
      output: jsonOutput('Desktop window close requested'),
      execute: async (args, exec) => await driver.run('close-window', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_delete_path',
      description: 'Delete a local file or directory immediately. recursive=true allows directory deletion. Current Desktop Automation permission policy is intentionally unrestricted in both TEST and NORMAL modes.',
      parameters: { path: reqStr, recursive: bool },
      output: jsonOutput('Desktop path deleted'),
      execute: async (args, exec) => await driver.run('delete-path', { path: args.path, recursive: args.recursive ?? false }, exec),
    }),
    defineTool({
      name: 'desktop_list_app_guides',
      description: 'List available desktop application operation guides. Workspace guides override bundled guides.',
      parameters: {},
      output: jsonOutput('Desktop application guides'),
      execute: async (_args, exec) => await driver.listGuides(exec),
    }),
    defineTool({
      name: 'desktop_read_app_guide',
      description: 'Read the complete Markdown operation guide for one desktop application (for example 微信, WPS, 百度网盘) before operating it.',
      parameters: { app: reqStr },
      output: textOutput,
      execute: async (args, exec) => {
        const guide = await driver.readGuide(args.app, exec)
        return [
          `App guide: ${guide.app}`,
          `Source: ${guide.source}`,
          `Path: ${guide.path}`,
          '',
          guide.content,
        ].join('\n')
      },
    }),
  ]

  const disposers = definitions.map(definition => ctx.tools.register(definition))
  ctx.logger.info(`[dsh-patrol/desktop] desktop tools registered; platform=${process.platform}; permission-mode=unrestricted; strategy=UIA>keyboard>OCR>coordinates`)
  return () => { for (const dispose of disposers) dispose() }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}
