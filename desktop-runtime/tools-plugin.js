import { defineTool } from '@deepseek-ai/dsh-tools'
import { WindowsDesktopDriver } from './windows-driver.js'

export const name = 'dsh-patrol-desktop-tools'
export const inject = ['tools']

const str = { type: 'string' }
const reqStr = { type: 'string', required: true }
const int = { type: 'integer' }
const reqInt = { type: 'integer', required: true }
const num = { type: 'number' }
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
      description: 'Report Desktop Automation availability and execute a real lightweight PowerShell backend probe. ok=true means the backend script actually ran, not merely that the plugin is installed.',
      parameters: {},
      output: jsonOutput('Desktop Automation status'),
      execute: async (_args, exec) => await driver.status(exec),
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
      description: 'Launch a Windows application. Provide file for an executable/path, or app for a friendly installed application name. app resolution uses Windows command/App Paths/Start Menu shortcut/Start Apps discovery and is generic across applications.',
      parameters: {
        file: str,
        app: str,
        arguments: { type: 'array', items: { type: 'string' } },
        workingDirectory: str,
      },
      output: jsonOutput('Application launched'),
      execute: async (args, exec) => {
        if (![args.file, args.app].some(value => typeof value === 'string' && value.trim())) {
          throw new Error('desktop_launch_app requires file or app')
        }
        return await driver.run('launch-app', compact(args), exec)
      },
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
      description: 'Read the current Windows UI Automation tree for the active or selected application. Use it as a quick capability probe: when the app exposes only a sparse tree or the target is absent, switch promptly to CURRENT OCR + keyboard instead of repeatedly probing UIA.',
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
      description: 'Click one unique Windows UI Automation element by semantic name/automationId/controlType/className. Use this when CURRENT snapshot proves a stable unique UIA target; visually rendered apps with sparse UIA should prefer desktop_click_ocr_text + keyboard.',
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
      description: 'CURRENT OCR semantic click: capture the current window/screen, find one unique OCR line with whitespace-tolerant text matching, and click its line center. For visually rendered desktop apps with sparse UIA this is a primary targeting path together with keyboard shortcuts, and is preferred over historical coordinates.',
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
        minXRatio: num,
        maxXRatio: num,
        minYRatio: num,
        maxYRatio: num,
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
      description: 'Type text into the focused desktop control using clipboard paste. Optional processName/title/titleContains activates the intended top-level window first; clear=true sends Ctrl+A before paste. Prefer desktop_type_target when the input control itself can be identified.',
      parameters: { text: reqStr, clear: bool, processName: str, title: str, titleContains: str },
      output: jsonOutput('Desktop text typed'),
      execute: async (args, exec) => await driver.run('type-text', compact({ text: args.text, clear: args.clear ?? false, processName: args.processName, title: args.title, titleContains: args.titleContains }), exec),
    }),
    defineTool({
      name: 'desktop_type_target',
      description: 'Focus one unique Windows UI Automation control by name/automationId/controlType/className and type text into it using clipboard paste. Prefer this over a separate click + desktop_type_text when the input control can be identified semantically.',
      parameters: {
        text: reqStr,
        clear: bool,
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
      output: jsonOutput('Desktop target text typed'),
      execute: async (args, exec) => await driver.run('type-target', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_paste_target',
      description: 'Focus one unique Windows UI Automation control and send Ctrl+V atomically. Prefer this for replayable file/image handoff (for example browser screenshot -> WeChat message input) instead of relying on residual focus.',
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
      output: jsonOutput('Desktop target paste sent'),
      execute: async (args, exec) => await driver.run('paste-target', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_press_target',
      description: 'Focus one unique Windows UI Automation control and press one key atomically. Use this when Enter/Tab/Delete must be sent to a specific control rather than merely the active application window.',
      parameters: {
        key: reqStr,
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
      output: jsonOutput('Desktop target key pressed'),
      execute: async (args, exec) => await driver.run('press-target', compact(args), exec),
    }),
    defineTool({
      name: 'desktop_hotkey',
      description: 'Send a desktop keyboard shortcut such as Ctrl+F or Ctrl+S. Optional processName/title/titleContains activates the intended top-level window immediately before the shortcut, which is recommended for replayable Runbooks.',
      parameters: { combo: reqStr, processName: str, title: str, titleContains: str },
      output: jsonOutput('Desktop hotkey sent'),
      execute: async (args, exec) => await driver.run('hotkey', compact({ combo: args.combo, processName: args.processName, title: args.title, titleContains: args.titleContains }), exec),
    }),
    defineTool({
      name: 'desktop_press',
      description: 'Press one desktop key such as Enter, Esc, Tab, Delete, arrows, or F1-F12. Optional processName/title/titleContains activates the intended top-level window immediately before the key press.',
      parameters: { key: reqStr, processName: str, title: str, titleContains: str },
      output: jsonOutput('Desktop key pressed'),
      execute: async (args, exec) => await driver.run('press', compact({ key: args.key, processName: args.processName, title: args.title, titleContains: args.titleContains }), exec),
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
      description: 'Wait for a semantic desktop target instead of sleeping. OCR matching can be constrained to a CURRENT window-relative region with min/max X/Y ratios (0..1), which is useful when the same text appears in both a navigation/search list and the main content/header. By default the filtered target must be unique; set requireUnique=false when presence inside that region is sufficient.',
      parameters: {
        source: { type: 'string', enum: ['auto', 'uia', 'ocr'] },
        name: str,
        automationId: str,
        controlType: str,
        className: str,
        text: str,
        value: str,
        match: { type: 'string', enum: ['exact', 'contains'] },
        caseSensitive: bool,
        requireUnique: bool,
        processName: str,
        title: str,
        titleContains: str,
        scope: { type: 'string', enum: ['active-window', 'screen'] },
        languages: { type: 'array', items: { type: 'string' } },
        minXRatio: num,
        maxXRatio: num,
        minYRatio: num,
        maxYRatio: num,
        maxElements: int,
        timeoutMs: int,
        pollMs: int,
      },
      output: jsonOutput('Desktop target ready'),
      execute: async (args, exec) => await driver.waitForTarget(compact(args), exec),
    }),
    defineTool({
      name: 'desktop_screenshot',
      description: 'Capture one selected/active desktop window or, only when scope=screen is explicitly requested, the whole virtual screen. Window-scoped capture raises the selected process/title window before CopyFromScreen so background apps cannot contaminate the image.',
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
      description: 'Run bundled Windows system OCR on a CURRENT capture. Default scope is active-window; with processName/title/titleContains the backend raises that exact window before capture and returns capture window metadata. Use scope=screen only for an explicitly whole-desktop task.',
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
      description: 'Send Ctrl+V to a desktop application. Optional processName/title/titleContains activates the intended top-level window immediately before paste; use these selectors in replayable cross-application flows.',
      parameters: { processName: str, title: str, titleContains: str },
      output: jsonOutput('Desktop paste sent'),
      execute: async (args, exec) => await driver.run('paste', compact(args), exec),
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
  ctx.logger.info(`[dsh-patrol/desktop] desktop tools registered; platform=${process.platform}; permission-mode=unrestricted; strategy=OCR>keyboard>UIA>coordinates`)
  return () => { for (const dispose of disposers) dispose() }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}
