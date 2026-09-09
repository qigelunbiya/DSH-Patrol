import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

export interface FlowCompactionResult {
  removedSteps: number
  originalSteps: number
  finalSteps: number
}

export interface FlowSelectionResult extends FlowCompactionResult {
  autoKeptDependencies: number
}

/**
 * Select the semantically successful route from a full conversational teaching
 * trace. Only verified semantic clicks are eligible. A click verified by an
 * automatic CURRENT-state change is as valid as one with an explicit expected
 * text; the teaching-only evidence is stripped from the reusable Runbook.
 */
export function selectSuccessfulTeachingPath(
  definition: InspectionDefinition,
  successfulStepIds: readonly string[],
): FlowSelectionResult {
  const original = definition.steps.slice()
  if (original.length === 0) throw new Error('cannot finalize an empty teaching trace')

  const byId = new Map(original.map(step => [step.id, step] as const))
  const keep = new Set<string>()
  for (const id of successfulStepIds) {
    if (typeof id !== 'string' || !byId.has(id)) throw new Error(`successful path references unknown step ${String(id)}`)
    keep.add(id)
  }
  if (keep.size === 0) throw new Error('successful path must keep at least one step')

  const requestedCount = keep.size
  for (const id of keep) {
    const step = byId.get(id)
    if (step?.kind !== 'tool' || step.tool !== 'browser_click') continue
    if (step.teaching?.status === 'unverified') {
      throw new Error(`successful path step ${id} (${step.name}) is explicitly unverified and cannot enter a reusable flow`)
    }
    if (step.locator?.text !== undefined && step.expectation === undefined && step.teaching?.status !== 'verified') {
      throw new Error(`successful path step ${id} (${step.name}) has no post-click verification evidence; reteach that semantic click and verify the CURRENT state before finalizing`)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const step of original) {
      if (!keep.has(step.id) || step.when === undefined || keep.has(step.when.sourceStepId)) continue
      if (!byId.has(step.when.sourceStepId)) throw new Error(`step ${step.id} depends on missing source ${step.when.sourceStepId}`)
      keep.add(step.when.sourceStepId)
      changed = true
    }
  }

  if (definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary')) {
    const index = findLastToolIndex(original, 'browser_read_page')
    if (index >= 0) keep.add(original[index]!.id)
  }
  if (definition.artifacts.includes('screenshot')) {
    const index = findLastToolIndex(original, 'browser_screenshot')
    if (index >= 0) keep.add(original[index]!.id)
  }

  const selected = original.filter(step => keep.has(step.id))
  assertCausalBusinessPath(selected)
  rewriteSteps(definition, selected, true)
  const compacted = compactTeachingFlow(definition)
  definition.metadata.flowHealth = {
    complete: true,
    warnings: [],
    checkedAt: new Date().toISOString(),
  }
  return {
    originalSteps: original.length,
    finalSteps: compacted.finalSteps,
    removedSteps: original.length - compacted.finalSteps,
    autoKeptDependencies: Math.max(0, compacted.finalSteps - requestedCount),
  }
}

/**
 * Deterministic fallback cleanup used by the dashboard and legacy teaching
 * flows. Cleanup is deliberately not a declaration of success: it removes
 * diagnostics/unverified actions, then records structural health warnings when
 * the surviving trace cannot plausibly advance after input.
 */
export function compactTeachingFlow(definition: InspectionDefinition): FlowCompactionResult {
  const original = definition.steps.slice()
  const referenced = new Set<string>()
  for (const step of original) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const lastPageRead = findLastToolIndex(original, 'browser_read_page')
  const lastScreenshot = findLastToolIndex(original, 'browser_screenshot')
  const needsPageOutput = definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary')
  const needsScreenshot = definition.artifacts.includes('screenshot')
  const resetFloor = findSafeResetFloor(original, referenced)

  const kept = original.filter((step, index) => shouldKeepStep(
    original,
    step,
    index,
    referenced,
    lastPageRead,
    lastScreenshot,
    needsPageOutput,
    needsScreenshot,
    resetFloor,
  ))

  rewriteSteps(definition, kept, false)
  updateStructuralFlowHealth(definition)
  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
  }
}

function shouldKeepStep(
  all: readonly InspectionStep[],
  step: InspectionStep,
  index: number,
  referenced: ReadonlySet<string>,
  lastPageRead: number,
  lastScreenshot: number,
  needsPageOutput: boolean,
  needsScreenshot: boolean,
  resetFloor: number,
): boolean {
  if (index < resetFloor) return false
  if (step.kind === 'checkpoint') return true
  if (step.teaching?.status === 'unverified') return false
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true

  if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') {
    return stepHasMeaningfulNotes(step)
  }

  if (step.tool === 'browser_read_page') {
    if (stepHasMeaningfulNotes(step)) return true
    return needsPageOutput && index === lastPageRead
  }

  if (step.tool === 'browser_screenshot') {
    if (stepHasMeaningfulNotes(step)) return true
    return needsScreenshot && index === lastScreenshot
  }

  if (step.tool === 'browser_wait' && hasLaterUnassertedWaitBeforeBoundary(all, index)) return false
  if (isTypingTool(step.tool) && isSupersededTypingStep(all, index, step)) return false
  if (isDuplicateRetryStep(all, index, step)) return false

  return true
}

function assertCausalBusinessPath(steps: readonly InspectionStep[]): void {
  const lastInput = findLastMatchingIndex(steps, step => step.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput < 0) return
  const advancesAfterInput = steps.slice(lastInput + 1).some(step =>
    step.kind === 'tool' && ['browser_click', 'browser_press', 'browser_select', 'browser_navigate'].includes(step.tool),
  )
  if (!advancesAfterInput) {
    throw new Error('successful path is incomplete: recorded input is not followed by any verified action that advances/submits the business flow')
  }
}

function updateStructuralFlowHealth(definition: InspectionDefinition): void {
  const warnings: string[] = []
  const steps = definition.steps
  const lastInput = findLastMatchingIndex(steps, step => step.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput >= 0) {
    const advancesAfterInput = steps.slice(lastInput + 1).some(step =>
      step.kind === 'tool' && ['browser_click', 'browser_press', 'browser_select', 'browser_navigate'].includes(step.tool),
    )
    if (!advancesAfterInput) {
      warnings.push('输入步骤之后没有任何已记录的提交/点击/选择/导航动作；该流程很可能缺少登录提交或后续业务点击。')
    }
  }
  const unverifiedClicks = steps.filter(step => step.kind === 'tool' && step.tool === 'browser_click' && step.teaching?.status === 'unverified')
  if (unverifiedClicks.length > 0) warnings.push(`仍有 ${unverifiedClicks.length} 个未验证点击，不可视为可复用成功路径。`)
  definition.metadata.flowHealth = {
    complete: warnings.length === 0,
    warnings,
    checkedAt: new Date().toISOString(),
  }
}

function hasLaterUnassertedWaitBeforeBoundary(all: readonly InspectionStep[], index: number): boolean {
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (isInteractionBoundary(next)) return false
    if (next.kind === 'tool' && next.tool === 'browser_wait' && !referencedOrAssertive(next)) return true
  }
  return false
}

function isDuplicateRetryStep(all: readonly InspectionStep[], index: number, step: ToolStep): boolean {
  if (!['browser_click', 'browser_press', 'browser_wait'].includes(step.tool)) return false
  if (referencedOrAssertive(step)) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (next.kind === 'checkpoint' || next.tool === 'browser_navigate' || isTypingTool(next.tool) || next.tool === 'browser_detect_auth_challenge') {
      return false
    }
    if (next.kind !== 'tool' || next.tool !== step.tool || referencedOrAssertive(next)) continue
    if (step.name === next.name && JSON.stringify(step.arguments) === JSON.stringify(next.arguments)) return true
  }
  return false
}

function referencedOrAssertive(step: InspectionStep): boolean {
  return step.kind === 'tool' && (step.when !== undefined || step.expectation !== undefined || step.artifact !== undefined)
}

function findSafeResetFloor(
  steps: readonly InspectionStep[],
  referenced: ReadonlySet<string>,
): number {
  const navigations: Array<{ index: number; key: string }> = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const key = typeof step.arguments.url === 'string' ? navigationIdentity(step.arguments.url) : ''
    if (key) navigations.push({ index, key })
  }
  if (navigations.length < 2) return 0

  for (let cursor = navigations.length - 1; cursor > 0; cursor -= 1) {
    const previous = navigations[cursor - 1]!
    const current = navigations[cursor]!
    if (previous.key !== current.key) continue
    const abandoned = steps.slice(previous.index + 1, current.index)
    const hasStrongSemanticStep = abandoned.some(step =>
      step.kind === 'checkpoint'
      || referenced.has(step.id)
      || (step.kind === 'tool' && (step.expectation !== undefined || step.teaching?.status === 'verified')),
    )
    if (!hasStrongSemanticStep) return current.index
  }
  return 0
}

function navigationIdentity(value: string): string {
  try {
    const url = new URL(value)
    if (url.pathname.startsWith('/com-sso/')) url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return normalizeUrl(value)
  }
}

function isSupersededTypingStep(all: readonly InspectionStep[], index: number, step: ToolStep): boolean {
  const selector = typeof step.arguments.selector === 'string' ? step.arguments.selector : ''
  if (!selector) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (isInteractionBoundary(next)) return false
    if (next.kind !== 'tool' || !isTypingTool(next.tool)) continue
    if (next.arguments.selector === selector) return true
  }
  return false
}

function isInteractionBoundary(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_navigate'
    || step.tool === 'browser_detect_auth_challenge'
}

function isTypingTool(tool: string): boolean {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
}

function rewriteSteps(definition: InspectionDefinition, kept: readonly InspectionStep[], stripTeaching: boolean): void {
  const idMap = new Map<string, string>()
  kept.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))

  definition.steps = kept.map((step, index) => {
    const nextId = `step-${String(index + 1).padStart(3, '0')}`
    const when = step.when === undefined
      ? undefined
      : {
          ...step.when,
          sourceStepId: idMap.get(step.when.sourceStepId) ?? step.when.sourceStepId,
        }
    if (step.kind === 'checkpoint') {
      return {
        ...step,
        id: nextId,
        ...(when === undefined ? {} : { when }),
      }
    }
    const { teaching: _teaching, ...toolStep } = step
    return {
      ...toolStep,
      ...(stripTeaching ? {} : step.teaching === undefined ? {} : { teaching: step.teaching }),
      id: nextId,
      ...(when === undefined ? {} : { when }),
    }
  })
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    const normalized = url.toString()
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

function stepHasMeaningfulNotes(step: ToolStep): boolean {
  if (typeof step.notes !== 'string' || !step.notes.trim()) return false
  return step.notes
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => !/^(执行方法|execution method)[:：]/i.test(line))
}

function findLastToolIndex(steps: readonly InspectionStep[], tool: string): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step?.kind === 'tool' && step.tool === tool) return index
  }
  return -1
}

function findLastMatchingIndex(steps: readonly InspectionStep[], predicate: (step: InspectionStep) => boolean): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) if (predicate(steps[index]!)) return index
  return -1
}
