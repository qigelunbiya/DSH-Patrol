import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerPatrolActionTools } from './action-tools.js'
import { PATROL_BEHAVIOR_PROMPT } from './behavior-prompt.js'
import { registerPatrolClickTargetTool } from './click-target-tools.js'
import { registerPatrolCreationTools } from './creation-tools.js'
import { registerPatrolCredentialTools } from './credential-tools.js'
import { registerPatrolContextPressureGuard } from './context-pressure-hardening.js'
import { registerPatrolDesktopActionTools } from './desktop-action-tools.js'
import { PATROL_DESKTOP_PROMPT } from './desktop-prompt.js'
import { registerPatrolEditTools } from './edit-tools.js'
import { PATROL_EXCEL_PROMPT } from './excel-tools.js'
import { PATROL_EXCEL_V5_PROMPT, registerPatrolExcelToolsV5 } from './excel-tools-v5.js'
import { registerPatrolFlowTools } from './flow-tools.js'
import { registerPatrolHandoffTools } from './handoff-tools.js'
import { PATROL_FLOW_REFERENCE_PROMPT, registerPatrolFlowReferenceTools } from './flow-reference-tools.js'
import { PatrolLifecycleStore } from './lifecycle-store.js'
import { PATROL_LANGUAGE_PROMPT } from './language-prompt.js'
import { createManualVerificationGuard, PATROL_MANUAL_VERIFICATION_PROMPT } from './manual-verification-guard.js'
import { registerPatrolModelRouteRecovery } from './model-route-recovery.js'
import { createPatrolObservationGate, PATROL_OBSERVATION_PROMPT } from './observation-guard.js'
import { registerPatrolObservationTools } from './observation-tools.js'
import { createPatrolPlanningGuard, createPatrolTestModePlanningGuard, PATROL_PAGE_UNDERSTANDING_PROMPT, registerPatrolPageUnderstandingTools } from './page-understanding-tools.js'
import { createPatrolClickOutcomeTracker } from './click-retry-state.js'
import { registerPatrolIntegrity } from './patrol-integrity.js'
import { PATROL_SYSTEM_PROMPT } from './prompt.js'
import { createPatrolRecoveryGuard, PATROL_RECOVERY_PROMPT } from './recovery-guard.js'
import { PATROL_TARGETED_RECOVERY_PROMPT, registerPatrolRecoveryTools } from './recovery-tools.js'
import { PatrolRunner } from './runner.js'
import { PatrolScheduler, registerPatrolScheduleTools } from './scheduler.js'
import { PATROL_SESSION_PROMPT } from './session-prompt.js'
import { registerPatrolSelectTools } from './select-tools.js'
import { registerPatrolTaskChecklistTools } from './task-checklist-tools.js'
import { PATROL_TEST_MODE_OVERRIDE_PROMPT, resolvePatrolRuntimePolicy } from './test-mode.js'
import { registerPatrolTools } from './tools.js'
import { PATROL_TOTP_PROMPT, registerPatrolTotpTools } from './totp-tools.js'
import { PATROL_TRANSIENT_INPUT_PROMPT, registerPatrolTransientInputTools } from './transient-input-tools.js'
import { registerPatrolVisualClickTool } from './visual-click-tools.js'
import { createPatrolVisualEvidenceRegistry } from './visual-evidence-registry.js'
import { registerPatrolWorkspaceTools } from './workspace-tools.js'

export * from './types.js'
export * from './browser.js'
export * from './security.js'
export * from './scheduler.js'
export * from './edit-tools.js'
export * from './action-tools.js'
export * from './click-target-tools.js'
export * from './select-tools.js'
export * from './behavior-prompt.js'
export * from './patrol-integrity.js'
export * from './flow-mutation-consent.js'
export * from './task-checklist-tools.js'
export * from './creation-tools.js'
export * from './credential-tools.js'
export * from './desktop.js'
export * from './desktop-action-tools.js'
export * from './desktop-prompt.js'
export * from './excel-tools.js'
export * from './excel-tools-v2.js'
export * from './excel-tools-v3.js'
export * from './excel-tools-v4.js'
export * from './excel-tools-v5.js'
export * from './flow-optimizer.js'
export * from './flow-tools.js'
export * from './lifecycle-store.js'
export * from './language-prompt.js'
export * from './recovery-guard.js'
export * from './recovery-tools.js'
export * from './totp-tools.js'
export * from './transient-input-tools.js'
export * from './visual-click-tools.js'
export * from './manual-verification-guard.js'
export * from './model-route-recovery.js'
export * from './observation-guard.js'
export * from './observation-tools.js'
export * from './page-understanding-tools.js'
export * from './handoff-tools.js'
export * from './flow-reference-tools.js'
export * from './test-mode.js'
export { PatrolStore } from './store.js'
export { PatrolRunner, conditionMatches, evaluateExpectation } from './runner.js'

export const name = 'dsh-patrol'
export const inject = ['tools', 'userQuestions']

const DEFAULT_STORAGE_PATH = resolve(process.cwd(), '.dsh-patrol')
const DEFAULT_MAX_STEPS = 200
const DEFAULT_REPORT_MAX_CHARS = 30_000
const TEST_MODE_BUILD_MARKER = 'test-real-visual-grounding-v13'
const TEST_MODE_DIRECT_BROWSER_ALLOWED = new Set([
  'browser_status',
  'browser_list_tabs',
  'browser_activate_tab',
  'browser_snapshot',
  'browser_read_page',
  'browser_count',
  'browser_login_state',
  'browser_navigate',
  'browser_wait',
  'browser_screenshot',
  'browser_capture_image_code_visual',
  // TEST MODE operational escape hatches. These are deliberately limited to
  // non-secret interaction primitives so a complex enterprise UI can still be
  // operated when a Patrol composite cannot express the final click. Direct
  // calls are live-only; patrol_* remains preferred for record/replay.
  'browser_semantic_click',
  'browser_click',
  'browser_press',
  'browser_scroll',
  'browser_select',
])

export interface Config {
  storagePath?: string
  maxSteps?: number
  reportMaxChars?: number
  /** Deprecated v0.1 compatibility; Patrol v0.2 uses an exact safe-browser allowlist. */
  allowedToolPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  storagePath: z.string().default(DEFAULT_STORAGE_PATH),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  reportMaxChars: z.number().step(1).min(1000).default(DEFAULT_REPORT_MAX_CHARS),
  allowedToolPrefixes: z.array(z.string()).default(['browser_']),
})

interface ResolvedConfig {
  storagePath: string
  maxSteps: number
  reportMaxChars: number
}

export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    storagePath: resolve(config.storagePath ?? DEFAULT_STORAGE_PATH),
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
  }
  if (!Number.isInteger(resolved.maxSteps) || resolved.maxSteps < 1) throw new Error('dsh-patrol: maxSteps must be a positive integer')
  if (!Number.isInteger(resolved.reportMaxChars) || resolved.reportMaxChars < 1000) throw new Error('dsh-patrol: reportMaxChars must be an integer >= 1000')
  if (config.allowedToolPrefixes !== undefined
    && (config.allowedToolPrefixes.length !== 1 || config.allowedToolPrefixes[0] !== 'browser_')) {
    throw new Error('dsh-patrol: allowedToolPrefixes is deprecated and may only remain ["browser_"]; v0.2 uses an exact internal allowlist')
  }
  return resolved
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const runtimePolicy = resolvePatrolRuntimePolicy()
  const store = new PatrolLifecycleStore(resolved.storagePath)
  await store.init()
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: resolved.reportMaxChars })
  const observationGate = createPatrolObservationGate()
  const recoveryGuard = createPatrolRecoveryGuard()
  const verificationGuard = createManualVerificationGuard()
  const clickOutcomes = createPatrolClickOutcomeTracker()
  const visualEvidence = createPatrolVisualEvidenceRegistry()
  const planningGuard = runtimePolicy.testMode
    ? createPatrolTestModePlanningGuard(clickOutcomes)
    : createPatrolPlanningGuard(clickOutcomes)

  ctx.effect(
    () => registerPatrolContextPressureGuard(ctx),
    'dsh-patrol: hardened local-Qwen context pressure protection',
  )

  // This is intentionally independent of NORMAL/TEST mode. It prevents URL
  // bypasses and injects the business-flow contract, but it no longer blocks a
  // legitimate click merely because the post-click text is not known yet.
  ctx.effect(() => registerPatrolIntegrity(ctx), 'dsh-patrol: always-on reusable-flow integrity')

  ctx.effect(
    () => registerPatrolTools(ctx, store, runner, {
      maxSteps: resolved.maxSteps,
      reportMaxChars: resolved.reportMaxChars,
    }),
    'dsh-patrol: patrol tools',
  )
  ctx.effect(() => registerPatrolTaskChecklistTools(ctx, store), 'dsh-patrol: persisted ordered business task checklist')
  ctx.effect(() => registerPatrolCreationTools(ctx, store), 'dsh-patrol: secret-safe inspection creation')
  ctx.effect(() => registerPatrolFlowReferenceTools(ctx, store, runner), 'dsh-patrol: deterministic flow resolution and non-mutating replay')
  ctx.effect(() => registerPatrolFlowTools(ctx, store), 'dsh-patrol: current-flow selection and successful-path finalization')
  ctx.effect(() => registerPatrolCredentialTools(ctx, store), 'dsh-patrol: credential setup guidance')
  ctx.effect(
    () => registerPatrolDesktopActionTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: recordable Windows desktop automation actions',
  )
  ctx.effect(
    () => registerPatrolActionTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: flat browser action tools',
  )
  ctx.effect(
    () => registerPatrolClickTargetTool(ctx, store, runner, { maxSteps: resolved.maxSteps, clickOutcomes }),
    'dsh-patrol: semantic current-page click target resolver',
  )
  ctx.effect(
    () => registerPatrolVisualClickTool(ctx, store, runner, {
      maxSteps: resolved.maxSteps,
      clickOutcomes,
      visualEvidence,
      requirePreview: false,
    }),
    'dsh-patrol: recordable screenshot-bound browser visual grounding',
  )
  ctx.effect(
    () => registerPatrolPageUnderstandingTools(ctx, store, runner, clickOutcomes),
    'dsh-patrol: current-page business-step understanding and planning',
  )
  ctx.effect(
    () => registerPatrolSelectTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: deterministic native select recording',
  )
  ctx.effect(
    () => registerPatrolObservationTools(ctx, store, runner, observationGate, visualEvidence),
    'dsh-patrol: current-state visual observation',
  )
  ctx.effect(
    () => registerPatrolTransientInputTools(ctx, store, runner),
    'dsh-patrol: transient sensitive browser input',
  )
  ctx.effect(
    () => registerPatrolTotpTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: encrypted TOTP profile runbook input',
  )
  ctx.effect(
    () => registerPatrolHandoffTools(ctx, store, runner, {
      maxSteps: resolved.maxSteps,
      allowImageCodeHandoff: runtimePolicy.testMode,
    }),
    'dsh-patrol: human verification handoff tools',
  )
  ctx.effect(() => registerPatrolEditTools(ctx, store, runner), 'dsh-patrol: runbook edit and validation tools')
  ctx.effect(() => registerPatrolRecoveryTools(ctx, store), 'dsh-patrol: targeted failed-step recovery tools')
  ctx.effect(() => registerPatrolWorkspaceTools(ctx, store), 'dsh-patrol: workspace path tools')
  ctx.effect(() => registerPatrolExcelToolsV5(ctx), 'dsh-patrol: OpenXML workspace Excel v5 tools')
  ctx.effect(() => registerPatrolScheduleTools(ctx, store), 'dsh-patrol: schedule tools')
  ctx.effect(() => registerPatrolModelRouteRecovery(ctx), 'dsh-patrol: legacy model route recovery')

  const scheduler = new PatrolScheduler(ctx, store)
  ctx.effect(() => scheduler.start(), 'dsh-patrol: scheduled patrol runner')

  const runtimeModeTool = defineTool({
    name: 'patrol_runtime_mode',
    description: 'Report the actually loaded DSH Patrol runtime mode and debug restrictions. Use this instead of guessing from environment variables.',
    parameters: {},
    output: {
      schema: { type: 'string' as const },
      render: (_args, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async () => [
      `mode=${runtimePolicy.testMode ? 'test' : 'normal'}`,
      `guards=${runtimePolicy.installGuards ? 'enabled' : 'operational-click-fallbacks'}`,
      `strictPrompts=${runtimePolicy.injectStrictWorkflowPrompt ? 'enabled' : 'disabled'}`,
      `visualCaptchaFallback=${runtimePolicy.testMode ? 'enabled' : 'disabled'}`,
      'browserStrategy=user-directed(default=hybrid)',
      'desktopAutomation=windows-uia+keyboard+ocr+coordinates',
      'desktopPermissions=unrestricted',
      `build=${TEST_MODE_BUILD_MARKER}`,
    ].join('; '),
  })
  ctx.effect(() => ctx.tools.register(runtimeModeTool), 'dsh-patrol: runtime mode diagnostic')

  // NORMAL MODE keeps the bounded selector/click strategy breaker. TEST MODE
  // deliberately mounts only selector-syntax/URL sanity checks so live debugging
  // cannot be deadlocked by strategy counters after fresh CURRENT evidence appears.
  ctx.effect(
    () => ctx.tools.guard(execution => planningGuard(execution)),
    'dsh-patrol: bounded page-understanding click strategy breaker',
  )

  if (runtimePolicy.installGuards) {
    ctx.effect(
      () => ctx.tools.guard(execution => observationGate.guard(execution)),
      'dsh-patrol: observe-before-mutate browser state gate',
    )
    ctx.effect(
      () => ctx.tools.guard(execution => recoveryGuard(execution)),
      'dsh-patrol: recovery loop circuit breaker',
    )
    ctx.effect(
      () => ctx.tools.guard(execution => verificationGuard(execution)),
      'dsh-patrol: automation-first human verification guard',
    )

    ctx.effect(
      () => ctx.tools.guard(execution => runner.browserGuard(execution.name, execution.parent)),
      'dsh-patrol: deny direct model browser calls',
    )
  } else {
    // TEST MODE must remain operational on difficult enterprise pages. Keep
    // secret-bearing and lifecycle-sensitive mutations behind patrol_*, but do
    // not turn a click/press/scroll/select fallback into an Error card that
    // prevents the patrol from making progress.
    ctx.effect(
      () => ctx.tools.guard(execution => {
        if (!execution.name.startsWith('browser_')) return undefined
        if (TEST_MODE_DIRECT_BROWSER_ALLOWED.has(execution.name)) return undefined
        return runner.browserGuard(execution.name, execution.parent)
      }),
      'dsh-patrol: test-mode operational browser fallbacks with secret mutations protected',
    )
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    // Locale is a user-facing contract, not a strict-workflow policy. TEST MODE
    // relaxes orchestration but must retain the same Chinese/other-language
    // behavior as NORMAL MODE.
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-language',
      order: 90,
      text: PATROL_LANGUAGE_PROMPT,
    }), 'dsh-patrol: always-on user language contract')

    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-flow-reference-replay',
      order: 1000,
      text: PATROL_FLOW_REFERENCE_PROMPT,
    }), 'dsh-patrol: deterministic flow reference and existing-flow replay prompt')

    // The page-understanding contract includes the selector-loop budget and
    // anti-repetition rules. It applies in TEST MODE too; TEST still keeps its
    // direct low-level browser fallbacks, but it must not spin on selector prose.
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-page-understanding',
      order: 1120,
      text: PATROL_PAGE_UNDERSTANDING_PROMPT,
    }), 'dsh-patrol: current-page understanding and bounded plan execution prompt')

    if (runtimePolicy.injectStrictWorkflowPrompt) {
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol',
        order: 130,
        text: PATROL_SYSTEM_PROMPT,
      }), 'dsh-patrol: agent workflow prompt')
    }

    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-excel',
      order: 131,
      text: PATROL_EXCEL_PROMPT,
    }), 'dsh-patrol: adaptive Excel workflow prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-excel-v5',
      order: 132,
      text: PATROL_EXCEL_V5_PROMPT,
    }), 'dsh-patrol: OpenXML Excel v5 bridge prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-session',
      order: 133,
      text: PATROL_SESSION_PROMPT,
    }), 'dsh-patrol: authenticated-session reuse prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-transient-input',
      order: 134,
      text: PATROL_TRANSIENT_INPUT_PROMPT,
    }), 'dsh-patrol: transient sensitive-input workflow prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-totp',
      order: 134.5,
      text: PATROL_TOTP_PROMPT,
    }), 'dsh-patrol: configured TOTP profile workflow prompt')
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-desktop',
      order: 134.7,
      text: PATROL_DESKTOP_PROMPT,
    }), 'dsh-patrol: Windows desktop automation prompt')

    if (runtimePolicy.injectStrictRecoveryPrompt) {
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol-recovery',
        order: 135,
        text: PATROL_RECOVERY_PROMPT,
      }), 'dsh-patrol: bounded recovery prompt')
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol-targeted-recovery',
        order: 136,
        text: PATROL_TARGETED_RECOVERY_PROMPT,
      }), 'dsh-patrol: targeted failed-step recovery prompt')
    }

    if (runtimePolicy.injectStrictVerificationPrompt) {
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol-verification',
        order: 137,
        text: PATROL_MANUAL_VERIFICATION_PROMPT,
      }), 'dsh-patrol: automation-first verification prompt')
    }

    if (runtimePolicy.injectStrictWorkflowPrompt) {
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol-current-behavior',
        order: 138,
        text: runtimePolicy.injectObservationPrompt
          ? `${PATROL_BEHAVIOR_PROMPT}\n\n${PATROL_OBSERVATION_PROMPT}`
          : PATROL_BEHAVIOR_PROMPT,
      }), 'dsh-patrol: current behavior, visual state gate, and Simplified Chinese prompt')
    }

    if (runtimePolicy.testMode) {
      ctx.effect(() => systemPrompt.section({
        name: 'agent:dsh-patrol-test-mode-override',
        order: 999,
        text: PATROL_TEST_MODE_OVERRIDE_PROMPT,
      }), 'dsh-patrol: test-mode debugging override with operational click fallbacks')
    }
  }

  const guardMode = runtimePolicy.testMode ? 'test-operational-click-fallbacks' : 'normal-strict'
  const plannerMode = runtimePolicy.testMode ? 'advisory' : 'strict'
  ctx.logger.info(`dsh-patrol ready; internal state=${resolved.storagePath}; user outputs=session workspace; guard-mode=${guardMode}; build=${TEST_MODE_BUILD_MARKER}; scheduler=enabled; credential helper=optional; transient sensitive replay=enabled; encrypted TOTP profile replay=enabled; semantic click resolver=enabled; browser visual grounding=enabled; page-understanding-planner=${plannerMode}; native select=enabled; task-checklist=required; secret-safe creation=enabled; flat action tools=enabled; OpenXML Excel v5 tools=enabled; targeted failure recovery=enabled; editable runbooks=enabled; persistent-session reuse=enabled; exact browser allowlist enabled; desktop automation=enabled; desktop permissions=unrestricted`)
}
