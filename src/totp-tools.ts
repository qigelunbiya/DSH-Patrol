import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { listTotpProfiles } from '../browser-bridge-runtime/totp-store.js'
import { assertSafePersistentText } from './security.js'
import type { PatrolRunner } from './runner.js'
import type { PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, StepCondition, ToolStep } from './types.js'

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_TOTP_PROMPT = `Patrol 已配置 TOTP/动态口令使用规则：
- 当页面出现“动态口令”“APP 口令”“TOTP”“Authenticator”“双因子认证”等输入框，并且用户要求“使用现有令牌 / 基于现在的令牌 / 自动填写令牌”时，先调用 patrol_list_totp_profiles 查询本机已经配置的非敏感 profile 元数据。不要先把动态口令留空提交，也不要先要求用户去手机查看 6 位码。
- 如果只有一个已配置 profile，且页面/账号信息没有明确冲突，优先使用这个 profile。如果有多个 profile，按 issuer、account、当前站点和登录账号选择最匹配的一个；无法可靠匹配时再向用户询问要用哪个 profileId，而不是询问当前 6 位动态码。
- 选定 profile 后，直接调用 patrol_type_totp_profile，把 CURRENT 动态口令输入框 selector 与 profileId 交给专用工具。专用工具会在本机解密 seed、生成当前时间片 TOTP 并直接输入浏览器；模型不需要也不应该知道当前动态码数字。
- patrol_type_totp_profile 成功后再点击“确定/验证/继续”等提交按钮，并观察登录结果。不要把 TOTP 当成普通 patrol_type_transient 文本，也不要把某次动态码写入 Runbook、notes、报告或回复。
- 只有当没有任何可用 profile、profile 明确不匹配、或 patrol_type_totp_profile 实际执行失败时，才退回人工 OTP/checkpoint 流程。`

export function registerPatrolTotpTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: { maxSteps: number },
): () => void {
  const listProfiles = defineTool({
    name: 'patrol_list_totp_profiles',
    description: 'List configured Patrol TOTP profiles using non-sensitive metadata only. Call this when a login page asks for an APP/dynamic/TOTP code and the user wants Patrol to use an already configured token. This never returns a seed or current dynamic code.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const profiles = listTotpProfiles()
      if (profiles.length === 0) {
        return 'No configured Patrol TOTP profiles were found. Do not ask for a profile id that does not exist; use the human OTP/checkpoint path unless the user configures a token first.'
      }
      return [
        `Configured Patrol TOTP profiles (${profiles.length}; non-sensitive metadata only):`,
        ...profiles.map(profile => [
          `- profileId=${profile.id}`,
          `issuer=${profile.issuer || '(none)'}`,
          `account=${profile.account || '(none)'}`,
          `${profile.digits || 6} digits/${profile.period || 30}s`,
        ].join(' | ')),
        'If the current login asks for an APP/dynamic/TOTP code, choose the matching profile and call patrol_type_totp_profile. Do not ask the user to read the current 6-digit code when a matching configured profile exists.',
      ].join('\n')
    },
  })

  const typeTotp = defineTool({
    name: 'patrol_type_totp_profile',
    description: 'Generate and type a fresh TOTP from an already configured encrypted Patrol token profile, then record only the profile id and selector as a replayable Runbook step. The seed and dynamic digits are never model-visible or persisted in the inspection. If the profile id is unknown, call patrol_list_totp_profiles first.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      profileId: { type: 'string', required: true, description: 'Configured Patrol TOTP profile id. Never pass an otpauth URI, seed, or current code here. Use patrol_list_totp_profiles when unknown.' },
      clear: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      assertTotpProfileId(args.profileId)

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const runtimeArgs: JsonObject = {
        selector: args.selector,
        profileId: args.profileId,
        clear: args.clear ?? true,
      }
      const dispatched = await runner.dispatch('browser_type_totp_profile', runtimeArgs, exec)
      if (!dispatched.ok) {
        return `TOTP typing failed and was NOT recorded. ${dispatched.error ?? dispatched.text}`
      }

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_type_totp_profile',
        arguments: runtimeArgs,
        sensitive: true,
        ...optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      await appendStep(store, definition, step)
      return `Executed and recorded ${step.id} using encrypted TOTP profile ${args.profileId}; neither the seed nor the generated dynamic code was exposed or persisted.`
    },
  })

  const definitions: ToolDefinition[] = [listProfiles, typeTotp]
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function assertTotpProfileId(value: string): void {
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new Error('TOTP profile id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen')
  }
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') {
    throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; edit operations return it to draft before re-validation`)
  }
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

async function appendStep(store: PatrolStore, definition: InspectionDefinition, step: InspectionStep): Promise<void> {
  definition.steps.push(step)
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  await store.save(definition)
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function optionalCondition(
  sourceStepId: string | undefined,
  expectedText: string | undefined,
  mode: 'contains' | 'not-contains' | undefined,
): { when?: StepCondition } {
  if (sourceStepId === undefined && expectedText === undefined) return {}
  if (!sourceStepId || expectedText === undefined) {
    throw new Error('conditionSourceStepId and conditionExpectedText must be provided together')
  }
  return {
    when: {
      sourceStepId,
      value: expectedText,
      mode: mode ?? 'contains',
      caseSensitive: false,
    },
  }
}
