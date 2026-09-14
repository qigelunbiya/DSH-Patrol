import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonObject } from './types.js'
import type { PatrolRunner } from './runner.js'

export interface BrowserTabState {
  ids: Set<number>
  byId: Map<number, { url: string; title: string; active: boolean; windowId?: number }>
}

export async function captureBrowserTabState(
  runner: PatrolRunner,
  exec: ToolRunContext,
): Promise<BrowserTabState | undefined> {
  const result = await runner.dispatch('browser_list_tabs', {}, exec)
  if (!result.ok || result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) return undefined
  const tabs = (result.value as JsonObject).tabs
  if (!Array.isArray(tabs)) return undefined

  const ids = new Set<number>()
  const byId = new Map<number, { url: string; title: string; active: boolean; windowId?: number }>()
  for (const raw of tabs) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const tab = raw as JsonObject
    const id = typeof tab.id === 'number' && Number.isInteger(tab.id) ? tab.id : undefined
    if (id === undefined) continue
    const windowId = typeof tab.windowId === 'number' && Number.isInteger(tab.windowId) ? tab.windowId : undefined
    ids.add(id)
    byId.set(id, {
      url: typeof tab.url === 'string' ? tab.url : '',
      title: typeof tab.title === 'string' ? tab.title : '',
      active: tab.active === true,
      ...(windowId === undefined ? {} : { windowId }),
    })
  }
  return { ids, byId }
}

export function openedTabEvidence(before: BrowserTabState | undefined, after: BrowserTabState | undefined): string | undefined {
  if (before === undefined || after === undefined) return undefined
  for (const id of after.ids) {
    if (before.ids.has(id)) continue
    const tab = after.byId.get(id)
    if (tab === undefined) return `new browser tab ${id} opened`
    const label = tab.title.trim() || safeTabUrl(tab.url) || `tab ${id}`
    return `new browser tab opened: ${label}`
  }
  return undefined
}

function safeTabUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.split(/[?#]/, 1)[0] ?? ''
  }
}
