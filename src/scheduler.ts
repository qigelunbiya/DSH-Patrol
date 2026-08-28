import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const SCHEDULER_POLL_MS = 15_000
const SCHEDULE_LOCK_RETENTION_MINUTES = 2 * 24 * 60
const RUN_LOCK_STALE_MS = 2 * 60 * 60_000
const RUN_LOCK_WAIT_MS = 2 * 60 * 60_000

export function registerPatrolScheduleTools(ctx: Context, store: PatrolStore): () => void {
  const schedule = defineTool({
    name: 'patrol_schedule',
    description: 'Enable, update, or disable a READY Patrol runbook schedule. Uses standard 5-field cron in the Harness host local timezone.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      cron: { type: 'string', description: '5-field cron, e.g. "0 9 * * 1-5". Required when enabling unless an existing cron is already stored.' },
      enabled: { type: 'boolean', description: 'Defaults to true. Set false to disable without deleting the stored cron.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const definition = await store.load(args.inspectionId)
      const enabled = args.enabled ?? true
      const existingCron = definition.schedule?.cron
      if (!enabled) {
        definition.schedule = { enabled: false, ...(existingCron === undefined ? {} : { cron: existingCron }) }
        await store.save(definition)
        return `Disabled schedule for ${definition.id}.\nRunbook: ${store.inspectionPath(definition.id)}\nStorage root: ${store.root}`
      }
      if (definition.status !== 'ready') throw new Error(`inspection ${definition.id} is ${definition.status}; confirm it before scheduling`)
      const cron = normalizeCron(args.cron ?? existingCron ?? '')
      assertValidCron(cron)
      definition.schedule = { enabled: true, cron }
      await store.save(definition)
      return `Scheduled ${definition.id} with cron ${cron} (Harness host local time).\nRunbook: ${store.inspectionPath(definition.id)}\nStorage root: ${store.root}`
    },
  })

  const dispose = ctx.tools.register(schedule)
  return () => dispose()
}

export class PatrolScheduler {
  private timer: NodeJS.Timeout | undefined
  private queue: Promise<void> = Promise.resolve()
  private lastScannedMinute = -1

  constructor(private readonly ctx: Context, private readonly store: PatrolStore) {}

  start(): () => void {
    void this.scan(new Date())
    this.timer = setInterval(() => { void this.scan(new Date()) }, SCHEDULER_POLL_MS)
    this.timer.unref?.()
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async scan(now: Date): Promise<void> {
    const minuteKey = Math.floor(now.getTime() / 60_000)
    if (minuteKey === this.lastScannedMinute) return
    this.lastScannedMinute = minuteKey
    if (minuteKey % 60 === 0) {
      void cleanupOldDueLocks(this.store.root, minuteKey)
        .catch(error => this.ctx.logger.warn?.(`[dsh-patrol/scheduler] lock cleanup failed: ${message(error)}`))
    }

    let definitions: Awaited<ReturnType<PatrolStore['list']>>
    try {
      definitions = await this.store.list()
    } catch (error) {
      this.ctx.logger.warn?.(`[dsh-patrol/scheduler] cannot list inspections: ${message(error)}`)
      return
    }

    for (const definition of definitions) {
      const cron = definition.schedule?.enabled === true ? definition.schedule.cron : undefined
      if (definition.status !== 'ready' || cron === undefined) continue
      try {
        if (!cronMatches(cron, now)) continue
      } catch (error) {
        this.ctx.logger.warn?.(`[dsh-patrol/scheduler] invalid cron for ${definition.id}: ${message(error)}`)
        continue
      }
      if (!(await acquireDueLock(this.store.root, definition.id, minuteKey))) continue
      this.queue = this.queue
        .then(async () => { await this.runInspection(definition.id) })
        .catch(error => this.ctx.logger.warn?.(`[dsh-patrol/scheduler] scheduled run ${definition.id} failed: ${message(error)}`))
    }
  }

  private async runInspection(inspectionId: string): Promise<void> {
    const pending = await this.store.loadResume(inspectionId)
    if (pending !== undefined) {
      this.ctx.logger.warn?.(`[dsh-patrol/scheduler] skipped ${inspectionId}; pending checkpoint run ${pending.runId} must be resumed or aborted first`)
      return
    }

    await withWorkspaceRunLock(this.store.root, async () => {
      const controller = new AbortController()
      const result = await this.ctx.tools.execute({
        callId: CallId(`patrol-schedule-${randomUUID()}`),
        name: 'patrol_run',
        arguments: { inspectionId },
        signal: controller.signal,
      })
      const text = result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
      if (result.isError) {
        this.ctx.logger.warn?.(`[dsh-patrol/scheduler] ${inspectionId} failed: ${result.error.message}${text ? `\n${text}` : ''}`)
      } else {
        this.ctx.logger.info(`[dsh-patrol/scheduler] ${inspectionId} completed\n${text}`)
      }
    })
  }
}

export function normalizeCron(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function assertValidCron(expression: string): void {
  const fields = normalizeCron(expression).split(' ')
  if (fields.length !== 5) throw new Error('cron must contain exactly 5 fields: minute hour day-of-month month day-of-week')
  parseField(fields[0] ?? '', 0, 59, false)
  parseField(fields[1] ?? '', 0, 23, false)
  parseField(fields[2] ?? '', 1, 31, false)
  parseField(fields[3] ?? '', 1, 12, false)
  parseField(fields[4] ?? '', 0, 7, true)
}

export function cronMatches(expression: string, date: Date): boolean {
  const fields = normalizeCron(expression).split(' ')
  if (fields.length !== 5) throw new Error('cron must contain exactly 5 fields')
  const minutes = parseField(fields[0] ?? '', 0, 59, false)
  const hours = parseField(fields[1] ?? '', 0, 23, false)
  const days = parseField(fields[2] ?? '', 1, 31, false)
  const months = parseField(fields[3] ?? '', 1, 12, false)
  const weekdays = parseField(fields[4] ?? '', 0, 7, true)
  if (!minutes.values.has(date.getMinutes()) || !hours.values.has(date.getHours()) || !months.values.has(date.getMonth() + 1)) return false

  const dayMatch = days.values.has(date.getDate())
  const weekdayMatch = weekdays.values.has(date.getDay())
  if (days.wildcard && weekdays.wildcard) return true
  if (days.wildcard) return weekdayMatch
  if (weekdays.wildcard) return dayMatch
  return dayMatch || weekdayMatch
}

interface ParsedField {
  values: Set<number>
  wildcard: boolean
}

function parseField(source: string, min: number, max: number, sundayAlias: boolean): ParsedField {
  if (source.length === 0) throw new Error('cron field must not be empty')
  const values = new Set<number>()
  const wildcard = source === '*' || source.startsWith('*/')
  for (const item of source.split(',')) {
    if (item.length === 0) throw new Error(`invalid cron field ${JSON.stringify(source)}`)
    const [baseRaw, stepRaw, extra] = item.split('/')
    if (extra !== undefined) throw new Error(`invalid cron step ${JSON.stringify(item)}`)
    const step = stepRaw === undefined ? 1 : parseInteger(stepRaw, 1, max - min + 1, 'cron step')
    const base = baseRaw ?? ''
    let start: number
    let end: number
    if (base === '*') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const parts = base.split('-')
      if (parts.length !== 2) throw new Error(`invalid cron range ${JSON.stringify(base)}`)
      start = parseInteger(parts[0] ?? '', min, max, 'cron range start')
      end = parseInteger(parts[1] ?? '', min, max, 'cron range end')
      if (start > end) throw new Error(`cron range start must be <= end: ${base}`)
    } else {
      start = parseInteger(base, min, max, 'cron value')
      end = stepRaw === undefined ? start : max
    }
    for (let value = start; value <= end; value += step) {
      values.add(sundayAlias && value === 7 ? 0 : value)
    }
  }
  if (values.size === 0) throw new Error(`cron field ${JSON.stringify(source)} matches no values`)
  return { values, wildcard }
}

function parseInteger(value: string, min: number, max: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`)
  const parsed = Number.parseInt(value, 10)
  if (parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return parsed
}

async function acquireDueLock(root: string, inspectionId: string, minuteKey: number): Promise<boolean> {
  const parent = join(root, 'scheduler-locks')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  try {
    await mkdir(join(parent, `${inspectionId}-${minuteKey}.lock`), { mode: 0o700 })
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false
    throw error
  }
}

async function cleanupOldDueLocks(root: string, minuteKey: number): Promise<void> {
  const parent = join(root, 'scheduler-locks')
  let entries: Dirent[]
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  const threshold = minuteKey - SCHEDULE_LOCK_RETENTION_MINUTES
  await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const match = /-(\d+)\.lock$/.exec(entry.name)
    if (match === null || Number.parseInt(match[1] ?? '0', 10) >= threshold) return
    await rm(join(parent, entry.name), { recursive: true, force: true })
  }))
}

async function withWorkspaceRunLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = join(root, 'scheduler-run.lock')
  const deadline = Date.now() + RUN_LOCK_WAIT_MS
  while (true) {
    try {
      await mkdir(lock, { recursive: false, mode: 0o700 })
      break
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > RUN_LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if (!isNodeError(statError) || statError.code !== 'ENOENT') throw statError
        continue
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for another scheduled Patrol run to finish')
      await sleep(750)
    }
  }
  try {
    return await action()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
