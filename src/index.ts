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
import { registerPatrolEditTools } from './edit-tools.js'
import { PATROL_EXCEL_PROMPT } from './excel-tools.js'
import { PATROL_EXCEL_V5_PROMPT, registerPatrolExcelToolsV5 } from './excel-tools-v5.js'
import { registerPatrolFlowTools } from './flow-tools.js'
import { registerPatrolHandoffTools } from './handoff-tools.js'
import { PATROL_FLOW_REFERENCE_PROMPT, registerPatrolFlowReferenceTools } from './flow-reference-tools.js'
import { PatrolLifecycleStore } from './lifecycle-store.js'
import { createManualVerificationGuard, PATROL_MANUAL_VERIFICATION_PROMPT } from './manual-verification-guard.js'
import { registerPatrolModelRouteRecovery } from './model-route-recovery.js'
import { createPatrolObservationGate, PATROL_OBSERVATION_PROMPT } from './observation-guard.js'
import { registerPatrolObservationTools } from './observation-tools.js'
import { PATROL_SYSTEM_PROMPT } from './prompt.js'
import { createPatrolRecoveryGuard, PATROL_RECOVERY_PROMPT } from './recovery-guard.js'
import { registerPatrolRecoveryResumeTool } from './recovery-resume-tool.js'
import { PATROL_TARGETED_RECOVERY_PROMPT, registerPatrolRecoveryTools } from './recovery-tools.js'
import { PatrolRunner } from './runner.js'
import { PatrolScheduler, registerPatrolScheduleTools } from './scheduler.js'
import { PATROL_SESSION_PROMPT } from './session-prompt.js'
import { registerPatrolShellTools } from './shell-tools.js'
import { PATROL_TEST_MODE_OVERRIDE_PROMPT, resolvePatrolRuntimePolicy } from './test-mode.js'
import { registerPatrolTools } from './tools.js'
import { PATROL_TOTP_PROMPT, registerPatrolTotpTools } from './totp-tools.js'
import { PATROL_TRANSIENT_INPUT_PROMPT, registerPatrolTransientInputTools } from './transient-input-tools.js'
import { registerPatrolWorkspaceTools } from './workspace-tools.js'

export * from './types.js'
export * from './browser.js'
export * from './security.js'
export * from './scheduler.js'
export * from './edit-tools.js'
export * from './action-tools.js'
export * from './click-target-tools.js'
export * from './behavior-prompt.js'
export * from './creation-tools.js'
export * from './credential-tools.js'
export * from './excel-tools.js'
export * from './excel-tools-v2.js'
export * from './excel-tools-v3.js'
export * from './excel-tools-v4.js'
export * from './excel-tools-v5.js'
export * from './flow-optimizer.js'
export * from './flow-tools.js'
export * from './lifecycle-store.js'
export * from './recovery-guard.js'
export * from './recovery-resume-tool.js'
export * from './recovery-tools.js'
export * from './shell-tools.js'
export * from './totp-tools.js'
export * from './transient-input-tools.js'
export * from './manual-verification-guard.js'
export * from './model-route-recovery.js'
export * from './observation-guard.js'
export * from './observation-tools.js'
export * from './handoff-tools.js'
export * from './flow-reference-tools.js'
export * from './test-mode.js'
export { PatrolStore } from './store.js'
export { PatrolRunner, conditionMatches, evaluateExpectation } from './runner.js'

export const name = 'dsh-patrol'
export const inject = ['tools']

const DEFAULT_STORAGE_PATH = resolve(process.cwd(), '.dsh-patrol')
const DEFAULT_MAX_STEPS = 200
const DEFAULT_REPORT_MAX_CHARS = 30_000
const TEST_MODE_BUILD_MARKER = 'test-bypass-v4-recorded-patrol'
const TEST_MODE_DIRECT_BROWSER_READ_ONLY = new Set([
  'browser_status',
  'browser_list_tabs',
  'browser_activate_tab',
  'browser_snapshot',
  'browser_read_page',
  'browser_count',
  'browser_login_state',
  'browser_wait',
  'browser_screenshot',
  'browser_capture_image_code_visual',
])

export type PatrolProfile = 'full' | 'shell' | 'teaching' | 'replay' | 'recovery'

export interface Config {
  storagePath?: string
  maxSteps?: number
  reportMaxChars?: number
  /** Capability profile. `full` preserves the legacy all-in-one composition for compatibility. */
  profile?: PatrolProfile
  /** Deprecated v0.1 compatibility; Patrol v0.2 uses an exact safe-browser allowlist. */
  allowedToolPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  storagePath: z.string().default(DEFAULT_STORAGE_PATH),
  maxSteps: z.number().step(1).min(1).default(DEFAULT_MAX_STEPS),
  reportMaxChars: z.number().step(1).min(1000).default(DEFAULT_REPORT_MAX_CHARS),
  profile: z.union(['full', 'shell', 'teaching', 'replay', 'recovery'] as const).default('full'),
  allowedToolPrefixes: z.array(z.string()).default(['browser_']),
})

interface ResolvedConfig {
  storagePath: string
  maxSteps: number
  reportMaxChars: number
  profile: PatrolProfile
}

export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    storagePath: resolve(config.storagePath ?? DEFAULT_STORAGE_PATH),
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
    profile: config.profile ?? 'full',
  }
  if (!Number.isInteger(resolved.maxSteps) || resolved.maxSteps < 1) throw new Error('dsh-patrol: maxSteps must be a positive integer')
  if (!Number.isInteger(resolved.reportMaxChars) || resolved.reportMaxChars < 1000) throw new Error('dsh-patrol: reportMaxChars must be an integer >= 1000')
  if (!['full', 'shell', 'teaching', 'replay', 'recovery'].includes(resolved.profile)) throw new Error(`dsh-patrol: unknown profile ${resolved.profile}`)
  if (config.allowedToolPrefixes !== undefined
    && (config.allowedToolPrefixes.length !== 1 || config.allowedToolPrefixes[0] !== 'browser_')) {
    throw new Error('dsh-patrol: allowedToolPrefixes is deprecated and may only remain ["browser_"]; v0.2 uses an exact internal allowlist')
  }
  return resolved
}

const PATROL_SHELL_PROMPT = `DSH Patrol lightweight shell rules:
- 普通问候、解释和流程查看保持轻量，不要加载浏览器/文件/SSH/Excel 能力。
- 用户要运行已有流程：先解析名称（必要时 patrol_resolve_flow），然后调用 patrol_run_flow。正常重放由 deterministic runner 完成，不需要教学模型参与。
- 用户明确要创建、重教、修改或修复 Runbook：调用 patrol_start_teaching，把任务交给独立 Teaching Worker；Shell 自己不做浏览器教学。
- 页面异常只由 deterministic runner 失败后按需启动的 Recovery Worker 处理。不要在 Shell 里手工恢复浏览器。`

const PATROL_RECOVERY_WORKER_PROMPT = `DSH Patrol Recovery Worker rules:
- 你只处理 deterministic runner 当前暂停的一个异常，不从头执行流程，不创建、不重教、不修改 Runbook。
- 只使用当前 Recovery preset 暴露的精简 browser_* 能力观察并解除瞬时阻塞。
- 阻塞解除后调用一次 patrol_resume_after_recovery；如果仍失败，直接报告，不无限重试。
- 不输入或持久化明文密码、OTP、验证码答案；秘密输入仍由 Runner 的已有安全步骤负责。`

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const store = new PatrolLifecycleStore(resolved.storagePath)
  await store.init()
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: resolved.reportMaxChars })

  if (resolved.profile === 'shell') {
    ctx.effect(() => registerPatrolShellTools(ctx, store), 'dsh-patrol/shell: four orchestration tools')
    const scheduler = new PatrolScheduler(ctx, store)
    ctx.effect(() => scheduler.start(), 'dsh-patrol/shell: scheduled deterministic replay')
    installPrompt(ctx, 'agent:dsh-patrol-shell', 130, PATROL_SHELL_PROMPT, 'dsh-patrol/shell: compact orchestration prompt')
    ctx.logger.info(`dsh-patrol ready; profile=shell; internal state=${resolved.storagePath}; model-visible Patrol surface=4 orchestration tools; scheduler=enabled`)
    return
  }

  if (resolved.profile === 'replay') {
    ctx.effect(() => registerPatrolFlowReferenceTools(ctx, store, runner), 'dsh-patrol/replay: deterministic replay tools')
    ctx.effect(
      () => ctx.tools.guard(execution => runner.browserGuard(execution.name, execution.parent)),
      'dsh-patrol/replay: browser calls only through deterministic runner',
    )
    ctx.logger.info(`dsh-patrol ready; profile=replay; internal state=${resolved.storagePath}; conversation model=unused; scheduler=disabled`)
    return
  }

  if (resolved.profile === 'recovery') {
    ctx.effect(() => registerPatrolRecoveryResumeTool(ctx, store, runner), 'dsh-patrol/recovery: deterministic hand-back tool')
    installPrompt(ctx, 'agent:dsh-patrol-recovery-worker', 130, PATROL_RECOVERY_WORKER_PROMPT, 'dsh-patrol/recovery: compact exception-only prompt')
    ctx.logger.info(`dsh-patrol ready; profile=recovery; internal state=${resolved.storagePath}; runbook editing=disabled; scheduler=disabled`)
    return
  }

  // `teaching` is the heavy interactive authoring worker. `full` preserves the
  // legacy all-in-one profile for custom presets and test fixtures that do not
  // opt into the lazy architecture yet.
  const runtimePolicy = resolvePatrolRuntimePolicy()
  const observationGate = createPatrolObservationGate()
  const recoveryGuard = createPatrolRecoveryGuard()
  const verificationGuard = createManualVerificationGuard()

  ctx.effect(
    () => registerPatrolTools(ctx, store, runner, {
      maxSteps: resolved.maxSteps,
      reportMaxChars: resolved.reportMaxChars,
    }),
    'dsh-patrol: patrol tools',
  )
  ctx.effect(() => registerPatrolCreationTools(ctx, store), 'dsh-patrol: secret-safe inspection creation')
  ctx.effect(() => registerPatrolFlowReferenceTools(ctx, store, runner), 'dsh-patrol: deterministic flow resolution and non-mutating replay')
  ctx.effect(() => registerPatrolFlowTools(ctx, store), 'dsh-patrol: current-flow selection and successful-path finalization')
  ctx.effect(() => registerPatrolCredentialTools(ctx, store), 'dsh-patrol: credential setup guidance')
  ctx.effect(
    () => registerPatrolActionTools(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: flat browser action tools',
  )
  ctx.effect(
    () => registerPatrolClickTargetTool(ctx, store, runner, { maxSteps: resolved.maxSteps }),
    'dsh-patrol: semantic current-page click target resolver',
  )
  ctx.effect(
    () => registerPatrolObservationTools(ctx, runner, observationGate),
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

  if (resolved.profile === 'full') {
    const scheduler = new PatrolScheduler(ctx, store)
    ctx.effect(() => scheduler.start(), 'dsh-patrol: scheduled patrol runner')
  }

  const runtimeModeTool = defineTool({
    name: 'patrol_runtime_mode',
    description: 'Report the actually loaded DSH Patrol runtime mode and debug restrictions. Use this instead of guessing from environment variables.',
    parameters: {},
    output: {
      schema: { type: 'string' as const },
      render: (_args, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async () => [
      `profile=${resolved.profile}`,
      `mode=${runtimePolicy.testMode ? 'test' : 'normal'}`,
      `guards=${runtimePolicy.installGuards ? 'enabled' : 'diagnostic-only-direct-browser'}`,
      `strictPrompts=${runtimePolicy.injectStrictWorkflowPrompt ? 'enabled' : 'disabled'}`,
      `visualCaptchaFallback=${runtimePolicy.testMode ? 'enabled' : 'disabled'}`,
      `build=${TEST_MODE_BUILD_MARKER}`,
    ].join('; '),
  })
  ctx.effect(() => ctx.tools.register(runtimeModeTool), 'dsh-patrol: runtime mode diagnostic')

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
    // Test mode still permits direct read-only provider diagnostics, but direct
    // page mutations would bypass PatrolLifecycleStore and therefore disappear
    // from both the selected flow's recent patrols and the global record list.
    ctx.effect(
      () => ctx.tools.guard(execution => {
        if (!execution.name.startsWith('browser_')) return undefined
        if (TEST_MODE_DIRECT_BROWSER_READ_ONLY.has(execution.name)) return undefined
        return runner.browserGuard(execution.name, execution.parent)
      }),
      'dsh-patrol: test-mode browser mutations must be recordable patrol actions',
    )
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'agent:dsh-patrol-flow-reference-replay',
      order: 1000,
      text: PATROL_FLOW_REFERENCE_PROMPT,
    }), 'dsh-patrol: deterministic flow reference and existing-flow replay prompt')

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
      }), 'dsh-patrol: test-mode debugging override with recordable patrol mutations')
    }
  }

  const guardMode = runtimePolicy.testMode ? 'test-diagnostics-recorded-mutations' : 'normal-strict'
  ctx.logger.info(`dsh-patrol ready; profile=${resolved.profile}; internal state=${resolved.storagePath}; user outputs=session workspace; guard-mode=${guardMode}; build=${TEST_MODE_BUILD_MARKER}; scheduler=${resolved.profile === 'full' ? 'enabled' : 'delegated-to-shell'}; credential helper=optional; transient sensitive replay=enabled; encrypted TOTP profile replay=enabled; semantic click resolver=enabled; secret-safe creation=enabled; flat action tools=enabled; OpenXML Excel v5 tools=enabled; targeted failure recovery=enabled; editable runbooks=enabled; persistent-session reuse=enabled; exact browser allowlist enabled`)
}

function installPrompt(ctx: Context, name: string, order: number, text: string, effectName: string): void {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return
  ctx.effect(() => systemPrompt.section({ name, order, text }), effectName)
}