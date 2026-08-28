import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerPatrolWorkspaceTools(ctx: Context, store: PatrolStore): () => void {
  const paths = defineTool({
    name: 'patrol_paths',
    description: 'Show the current Harness workspace, user-visible Patrol outputs, complete reusable Runbook files, and separate internal Patrol state paths. Call this before the final reply and whenever a patrol pauses for human verification.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      runId: { type: 'string', description: 'Optional exact run id. Omit to inspect the latest saved run.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definition = await store.load(args.inspectionId)
      const currentWorkspace = exec.agent?.session.header.cwd
      const browserTemp = join(store.root, 'browser-tmp')
      const lines = [
        `Current session workspace: ${currentWorkspace ?? '(not available in this execution)'}`,
        `Patrol internal state root: ${store.root}`,
        `Runbook (internal state): ${store.inspectionPath(definition.id)}`,
        `Runbook status: ${definition.status}`,
        `Credential helper (internal state): ${join(store.root, 'set-patrol-credential.ps1')}`,
        `Browser fallback temporary artifacts: ${browserTemp}`,
      ]

      const workspaceForRecent = currentWorkspace ?? definition.metadata.workspaceRoot
      if (workspaceForRecent !== undefined) {
        // patrol_paths is also the migration point for inspections created before
        // workspace-visible Runbook mirrors existed. Merely asking for paths now
        // guarantees the complete reusable files are present.
        await store.saveWorkspaceRunbook(definition, workspaceForRecent)
        const runbook = store.workspaceRunbookPaths(definition.id, workspaceForRecent)
        lines.push(
          `Reusable Runbook JSON: ${runbook.json}`,
          `Reusable Runbook Markdown: ${runbook.markdown}`,
        )
        const recentWorkspaceScreenshots = await latestWorkspaceScreenshots(workspaceForRecent)
        if (recentWorkspaceScreenshots.length > 0) {
          lines.push('Recent screenshots in user workspace:')
          for (const path of recentWorkspaceScreenshots) lines.push(`- ${path}`)
        }
      }

      if (definition.schedule === null) lines.push('Schedule: none')
      else lines.push(`Schedule: ${definition.schedule.enabled ? 'enabled' : 'disabled'}${definition.schedule.cron ? ` (${definition.schedule.cron}, Harness host local time)` : ''}`)

      const runId = args.runId ?? await latestRunId(store, definition.id)
      if (runId === undefined) {
        lines.push('Runs: none yet')
      } else {
        const report = await store.loadRun(definition.id, runId)
        const outputWorkspace = report.outputWorkspace ?? currentWorkspace ?? definition.metadata.workspaceRoot
        lines.push(`Run id: ${runId}`, `Run status: ${report.status}`)
        if (outputWorkspace !== undefined) {
          const visible = store.workspaceRunPaths(definition.id, runId, outputWorkspace)
          lines.push(
            `User-visible output workspace: ${outputWorkspace}`,
            `Markdown report: ${visible.markdown}`,
            `JSON report: ${visible.json}`,
            `Runbook snapshot JSON: ${join(visible.directory, 'runbook', 'inspection.json')}`,
            `Runbook snapshot Markdown: ${join(visible.directory, 'runbook', 'runbook.md')}`,
          )
        } else {
          lines.push(
            'User-visible output workspace: unavailable; this run used the internal fallback',
            `Markdown report: ${store.runMarkdownPath(definition.id, runId)}`,
            `JSON report: ${store.runJsonPath(definition.id, runId)}`,
          )
        }
        lines.push(`Run archive directory (internal state): ${store.runDirectory(definition.id, runId)}`)
        const artifacts = report.results.flatMap(result => result.artifacts ?? [])
        if (artifacts.length === 0) lines.push('Artifacts: none')
        else {
          lines.push('Artifacts:')
          for (const artifact of artifacts) lines.push(`- ${artifact.kind}: ${artifact.path}`)
        }
        if (report.summary !== undefined) lines.push('Page summary: saved in both report files')
      }

      const pending = await store.loadResume(definition.id)
      if (pending !== undefined) lines.push(`Pending resume state (internal): ${store.resumePath(definition.id)} (run ${pending.runId})`)
      return lines.join('\n')
    },
  })

  const dispose = ctx.tools.register(paths)
  return () => dispose()
}

async function latestRunId(store: PatrolStore, inspectionId: string): Promise<string | undefined> {
  const parent = join(store.root, 'runs', inspectionId)
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort().at(-1)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function latestWorkspaceScreenshots(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && /^(?:screenshot-|patrol-.*-screenshot).*\.(?:png|jpe?g)$/i.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .slice(-5)
      .reverse()
      .map(name => join(directory, name))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
