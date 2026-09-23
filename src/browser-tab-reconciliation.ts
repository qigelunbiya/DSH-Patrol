import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PatrolRunner } from './runner.js'

export interface PatrolBrowserTab {
  id: number
  title?: string
  url?: string
  active?: boolean
}

export interface BrowserTabBaseline {
  ids: Set<number>
}

export interface BrowserTabReconciliation {
  selected?: PatrolBrowserTab
  freshTabs: PatrolBrowserTab[]
  closedTabIds: number[]
  ambiguous: boolean
}

export async function captureBrowserTabBaseline(
  runner: PatrolRunner,
  exec: ToolRunContext,
): Promise<BrowserTabBaseline | undefined> {
  const listed = await runner.dispatch('browser_list_tabs', {}, exec)
  if (!listed.ok) return undefined
  const tabs = browserTabs(listed.value)
  return { ids: new Set(tabs.map(tab => tab.id)) }
}

export async function reconcileFreshBrowserTabs(
  runner: PatrolRunner,
  exec: ToolRunContext,
  baseline: BrowserTabBaseline | undefined,
  targetText: string | undefined,
): Promise<BrowserTabReconciliation | undefined> {
  if (!baseline) return undefined

  let freshTabs: PatrolBrowserTab[] = []
  for (const delayMs of [0, 120, 320, 700]) {
    if (delayMs > 0) await sleep(delayMs)
    const listed = await runner.dispatch('browser_list_tabs', {}, exec)
    if (!listed.ok) return undefined
    freshTabs = browserTabs(listed.value).filter(tab => !baseline.ids.has(tab.id))
    if (freshTabs.length > 0 && freshTabs.every(tab => Boolean(tab.title || tab.url))) break
  }

  if (freshTabs.length === 0) {
    return { freshTabs: [], closedTabIds: [], ambiguous: false }
  }

  if (freshTabs.length === 1) {
    const selected = freshTabs[0]!
    await runner.dispatch('browser_activate_tab', { tabId: selected.id }, exec)
    return { selected, freshTabs, closedTabIds: [], ambiguous: false }
  }

  const ranked = freshTabs
    .map(tab => ({ tab, score: tabTargetScore(tab, targetText) }))
    .sort((left, right) => right.score - left.score)
  const best = ranked[0]
  const second = ranked[1]

  if (!best || best.score < 500 || (second && best.score - second.score < 120)) {
    return { freshTabs, closedTabIds: [], ambiguous: true }
  }

  await runner.dispatch('browser_activate_tab', { tabId: best.tab.id }, exec)

  const closedTabIds: number[] = []
  for (const sibling of freshTabs) {
    if (sibling.id === best.tab.id) continue
    const closed = await runner.dispatch('browser_close_tab', { tabId: sibling.id }, exec)
    if (closed.ok) closedTabIds.push(sibling.id)
  }

  return {
    selected: best.tab,
    freshTabs,
    closedTabIds,
    ambiguous: false,
  }
}

export function formatFreshBrowserTabs(tabs: readonly PatrolBrowserTab[]): string {
  return tabs
    .map(tab => `[${tab.id}] ${tab.title || '(untitled)'} - ${tab.url || ''}`)
    .join('; ')
}

function browserTabs(value: unknown): PatrolBrowserTab[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const raw = (value as Record<string, unknown>).tabs
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (!Number.isInteger(row.id)) return []
    return [{
      id: row.id as number,
      ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof row.url === 'string' ? { url: row.url } : {}),
      ...(typeof row.active === 'boolean' ? { active: row.active } : {}),
    }]
  })
}

function tabTargetScore(tab: PatrolBrowserTab, targetText: string | undefined): number {
  const target = normalizeTarget(targetText)
  if (!target) return 0

  const title = normalizeTarget(tab.title)
  const url = normalizeTarget(decodeSafe(tab.url))
  const core = stripGenericSuffix(target)

  let score = 0
  if (title === target) score = Math.max(score, 1200)
  if (title && title.includes(target)) score = Math.max(score, 1000)
  if (target.includes(title) && title.length >= 6) score = Math.max(score, 820)
  if (core && title && title.includes(core)) score = Math.max(score, 760)
  if (url && url.includes(target)) score = Math.max(score, 900)
  if (core && url && url.includes(core)) score = Math.max(score, 640)

  // Prefer a title that preserves distinguishing digits/suffixes from the user's
  // exact click target. This separates e.g. “龙之信条2” from “龙之信条”.
  const targetDigits: string[] = target.match(/\d+/g) ?? []
  const titleDigits: string[] = title.match(/\d+/g) ?? []
  if (targetDigits.length > 0) {
    score += targetDigits.every(digit => titleDigits.includes(digit)) ? 180 : -420
  }

  return score
}

function stripGenericSuffix(value: string): string {
  return value
    .replace(/(?:百度百科|百科|详情页|页面|官网|官方网站|搜索结果|链接)+$/g, '')
    .trim()
}

function normalizeTarget(value: string | undefined): string {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/[\s\-_—–·•|｜:：,，。.!！?？()（）\[\]【】《》<>]+/g, '')
}

function decodeSafe(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
