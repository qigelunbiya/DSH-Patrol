import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rememberChallengeObservationFromText } from './challenge-memory.js'
import { assertInspectionDefinition, assertInspectionId } from './validation.js'
import type { InspectionDefinition, ResumeState, RunReport, SavedRunPaths } from './types.js'

const WORKSPACE_OUTPUT_ROOT = 'patrol-results'

export class PatrolStore {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.root, 'inspections'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'runs'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'resumes'), { recursive: true, mode: 0o700 })
  }

  inspectionDirectory(id: string): string {
    assertInspectionId(id)
    return join(this.root, 'inspections', id)
  }

  inspectionPath(id: string): string {
    return join(this.inspectionDirectory(id), 'inspection.json')
  }

  workspaceInspectionDirectory(id: string, workspaceRoot: string): string {
    assertInspectionId(id)
    return join(workspaceRoot, WORKSPACE_OUTPUT_ROOT, id)
  }

  workspaceRunbookPaths(id: string, workspaceRoot: string): { directory: string; json: string; markdown: string } {
    const directory = join(this.workspaceInspectionDirectory(id, workspaceRoot), 'runbook')
    return {
      directory,
      json: join(directory, 'inspection.json'),
      markdown: join(directory, 'runbook.md'),
    }
  }

  runDirectory(inspectionId: string, runId: string): string {
    assertInspectionId(inspectionId)
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('invalid runId')
    return join(this.root, 'runs', inspectionId, runId)
  }

  runJsonPath(inspectionId: string, runId: string): string {
    return join(this.runDirectory(inspectionId, runId), 'report.json')
  }

  runMarkdownPath(inspectionId: string, runId: string): string {
    return join(this.runDirectory(inspectionId, runId), 'report.md')
  }

  workspaceRunDirectory(inspectionId: string, runId: string, workspaceRoot: string): string {
    assertInspectionId(inspectionId)
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('invalid runId')
    return join(workspaceRoot, WORKSPACE_OUTPUT_ROOT, inspectionId, runId)
  }

  workspaceRunPaths(inspectionId: string, runId: string, workspaceRoot: string): SavedRunPaths {
    const directory = this.workspaceRunDirectory(inspectionId, runId, workspaceRoot)
    const reports = join(directory, 'reports')
    return {
      directory,
      json: join(reports, 'report.json'),
      markdown: join(reports, 'report.md'),
    }
  }

  resumePath(inspectionId: string): string {
    assertInspectionId(inspectionId)
    return join(this.root, 'resumes', `${inspectionId}.json`)
  }

  async exists(id: string): Promise<boolean> {
    try {
      await readFile(this.inspectionPath(id), 'utf8')
      return true
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return false
      throw error
    }
  }

  async create(definition: InspectionDefinition): Promise<void> {
    if (await this.exists(definition.id)) throw new Error(`inspection ${definition.id} already exists`)
    await this.save(definition)
  }

  async save(definition: InspectionDefinition): Promise<void> {
    assertInspectionDefinition(definition)
    await atomicWrite(this.inspectionPath(definition.id), `${JSON.stringify(definition, null, 2)}\n`)
    const workspaceRoot = definition.metadata.workspaceRoot
    if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
      await this.saveWorkspaceRunbook(definition, workspaceRoot)
    }
  }

  async saveWorkspaceRunbook(definition: InspectionDefinition, workspaceRoot: string): Promise<{ json: string; markdown: string }> {
    assertInspectionDefinition(definition)
    const paths = this.workspaceRunbookPaths(definition.id, workspaceRoot)
    await atomicWrite(paths.json, `${JSON.stringify(definition, null, 2)}\n`)
    await atomicWrite(paths.markdown, renderRunbookMarkdown(definition))
    return { json: paths.json, markdown: paths.markdown }
  }

  async load(id: string): Promise<InspectionDefinition> {
    const raw = await readFile(this.inspectionPath(id), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    assertInspectionDefinition(parsed)
    return parsed
  }

  async remove(id: string): Promise<void> {
    assertInspectionId(id)
    await rm(this.inspectionDirectory(id), { recursive: true, force: true })
    await rm(this.resumePath(id), { force: true })
  }

  async list(): Promise<InspectionDefinition[]> {
    await this.init()
    const entries = await readdir(join(this.root, 'inspections'), { withFileTypes: true })
    const definitions: InspectionDefinition[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        definitions.push(await this.load(entry.name))
      } catch {
        // Broken definitions remain addressable through patrol_show for diagnosis.
      }
    }
    return definitions.sort((a, b) => a.id.localeCompare(b.id))
  }

  async saveRun(report: RunReport, markdown: string, workspaceRoot?: string): Promise<SavedRunPaths> {
    const internal: SavedRunPaths = {
      directory: this.runDirectory(report.inspectionId, report.runId),
      json: this.runJsonPath(report.inspectionId, report.runId),
      markdown: this.runMarkdownPath(report.inspectionId, report.runId),
    }
    await atomicWrite(internal.json, `${JSON.stringify(report, null, 2)}\n`)
    await atomicWrite(internal.markdown, markdown)

    // A real Patrol run always has a persisted inspection definition. Some
    // lower-level runner tests deliberately execute an ephemeral definition
    // without storing it first, so challenge-memory enrichment must remain
    // optional and must never make report persistence depend on inspection.json.
    let definition: InspectionDefinition | undefined
    if (await this.exists(report.inspectionId)) {
      definition = await this.load(report.inspectionId)
      let learnedChallenge = false
      for (const result of report.results) {
        if (result.tool !== 'browser_detect_auth_challenge' || result.status !== 'passed') continue
        learnedChallenge = rememberChallengeObservationFromText(definition, result.output, result.finishedAt) || learnedChallenge
      }
      if (learnedChallenge) await this.save(definition)
    }

    if (workspaceRoot === undefined || workspaceRoot.trim() === '') return internal
    const visible = this.workspaceRunPaths(report.inspectionId, report.runId, workspaceRoot)
    await atomicWrite(visible.json, `${JSON.stringify(report, null, 2)}\n`)
    await atomicWrite(visible.markdown, markdown)

    // Runbook mirrors require an authoritative persisted definition. If a
    // low-level test supplied only an ephemeral definition, keep the reports
    // usable and simply omit mirrors; normal Patrol runs always take this path.
    if (definition !== undefined) {
      await this.saveWorkspaceRunbook(definition, workspaceRoot)
      const runbookSnapshot = join(visible.directory, 'runbook')
      await atomicWrite(join(runbookSnapshot, 'inspection.json'), `${JSON.stringify(definition, null, 2)}\n`)
      await atomicWrite(join(runbookSnapshot, 'runbook.md'), renderRunbookMarkdown(definition))
    }
    return visible
  }

  async loadRun(inspectionId: string, runId: string): Promise<RunReport> {
    const raw = await readFile(this.runJsonPath(inspectionId, runId), 'utf8')
    const parsed = JSON.parse(raw) as RunReport
    if (parsed.schemaVersion !== '0.2' || parsed.inspectionId !== inspectionId || parsed.runId !== runId) {
      throw new Error('stored run report is invalid')
    }
    return parsed
  }

  async saveResume(state: ResumeState): Promise<void> {
    await atomicWrite(this.resumePath(state.inspectionId), `${JSON.stringify(state, null, 2)}\n`)
  }

  async loadResume(inspectionId: string): Promise<ResumeState | undefined> {
    try {
      const raw = await readFile(this.resumePath(inspectionId), 'utf8')
      const parsed = JSON.parse(raw) as ResumeState
      if (parsed.schemaVersion !== '0.2'
        || parsed.inspectionId !== inspectionId
        || typeof parsed.runId !== 'string'
        || typeof parsed.startedAt !== 'string'
        || typeof parsed.definitionUpdatedAt !== 'string'
        || !Number.isInteger(parsed.nextStepIndex)
        || parsed.nextStepIndex < 0
        || !Array.isArray(parsed.results)) {
        throw new Error('resume state is invalid')
      }
      return parsed
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async clearResume(inspectionId: string): Promise<void> {
    await rm(this.resumePath(inspectionId), { force: true })
  }

  async saveTextArtifact(
    inspectionId: string,
    runId: string,
    suggestedName: string,
    content: string,
    workspaceRoot?: string,
  ): Promise<string> {
    const directory = join(this.runDirectory(inspectionId, runId), 'artifacts')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const safeName = sanitizeArtifactName(suggestedName, '.txt')
    const internal = join(directory, safeName)
    await writeFile(internal, content, { encoding: 'utf8', mode: 0o600 })
    if (workspaceRoot === undefined || workspaceRoot.trim() === '') return internal

    const visibleDirectory = join(this.workspaceRunDirectory(inspectionId, runId, workspaceRoot), 'page-text')
    await mkdir(visibleDirectory, { recursive: true })
    const visible = join(visibleDirectory, safeName)
    await writeFile(visible, content, { encoding: 'utf8', mode: 0o600 })
    return visible
  }

  async copyArtifact(
    inspectionId: string,
    runId: string,
    sourcePath: string,
    suggestedName: string,
    workspaceRoot?: string,
  ): Promise<string> {
    const directory = join(this.runDirectory(inspectionId, runId), 'artifacts')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const sourceExt = extname(sourcePath)
    const fallbackExt = sourceExt.length > 0 ? sourceExt : '.bin'
    const safeName = sanitizeArtifactName(suggestedName, fallbackExt)
    const internal = join(directory, safeName)
    await copyFile(sourcePath, internal)
    await chmod(internal, 0o600)
    if (workspaceRoot === undefined || workspaceRoot.trim() === '') return internal

    const category = imageArtifactExtension(extname(safeName)) ? 'screenshots' : 'artifacts'
    const visibleDirectory = join(this.workspaceRunDirectory(inspectionId, runId, workspaceRoot), category)
    await mkdir(visibleDirectory, { recursive: true })
    const visible = join(visibleDirectory, safeName)
    await copyFile(sourcePath, visible)
    await chmod(visible, 0o600)
    await cleanupLooseWorkspaceSource(sourcePath, workspaceRoot, visible)
    return visible
  }

  async organizeTeachingScreenshot(inspectionId: string, sourcePath: string, workspaceRoot: string): Promise<string> {
    assertInspectionId(inspectionId)
    const sourceExt = extname(sourcePath)
    const fallbackExt = sourceExt.length > 0 ? sourceExt : '.png'
    const safeName = sanitizeArtifactName(basename(sourcePath), fallbackExt)
    const directory = join(workspaceRoot, WORKSPACE_OUTPUT_ROOT, inspectionId, 'teaching', 'screenshots')
    await mkdir(directory, { recursive: true })
    const visible = join(directory, safeName)
    if (resolve(sourcePath) !== resolve(visible)) {
      await copyFile(sourcePath, visible)
      await chmod(visible, 0o600)
      await cleanupLooseWorkspaceSource(sourcePath, workspaceRoot, visible)
    }
    return visible
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

function renderRunbookMarkdown(definition: InspectionDefinition): string {
  const lines = [
    `# ${definition.name}`,
    '',
    `- Inspection ID: \`${definition.id}\``,
    `- Status: \`${definition.status}\``,
    `- Target: ${definition.target.url}`,
    `- Expected result: ${definition.expectedResult}`,
    `- Auth mode: \`${definition.auth.mode}\``,
    `- Updated: ${definition.metadata.updatedAt}`,
    '',
  ]

  const challengeProfiles = definition.auth.challengeProfiles ?? []
  if (challengeProfiles.length > 0) {
    lines.push('## Learned verification profiles', '')
    for (const profile of challengeProfiles) {
      lines.push(
        `- \`${profile.kind}/${profile.subtype}\` → \`${profile.strategy}\`; observed ${profile.occurrences} time(s); auto-completed ${profile.autoCompletedOccurrences} time(s); last seen ${profile.lastObservedAt}`,
      )
    }
    lines.push('', 'These entries are non-secret hints learned from prior runs. The current page is still classified once when verification is reached; no captcha answer, OTP, cookie, or raw challenge image is stored.', '')
  }

  lines.push('## Reusable steps', '')
  if (definition.steps.length === 0) lines.push('(no steps recorded)')
  for (const step of definition.steps) {
    lines.push(`### ${step.id} — ${step.name}`, '')
    if (step.kind === 'checkpoint') {
      lines.push(`- Kind: checkpoint`, `- Reason: ${step.reason}`, `- Prompt: ${step.prompt}`)
    } else {
      lines.push(`- Kind: tool`, `- Tool: \`${step.tool}\``, `- Arguments: \`${JSON.stringify(step.arguments)}\``)
      if (step.expectation !== undefined) lines.push(`- Expectation: ${step.expectation.mode} ${JSON.stringify(step.expectation.value)}`)
      if (step.locator !== undefined) lines.push(`- Semantic locator: \`${JSON.stringify(step.locator)}\``)
      if (step.artifact !== undefined) lines.push(`- Artifact: \`${step.artifact}\``)
    }
    if (step.when !== undefined) lines.push(`- Condition: ${step.when.sourceStepId} ${step.when.mode} ${JSON.stringify(step.when.value)}`)
    if (step.notes !== undefined) lines.push(`- Notes: ${step.notes}`)
    lines.push('')
  }
  lines.push('---', '', 'This is the complete reusable Patrol Runbook mirror. Credential steps contain references only; raw passwords, cookies, OTPs, captcha answers, and other session secrets are intentionally not written here.', '')
  return lines.join('\n')
}

function sanitizeArtifactName(name: string, fallbackExt: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || `artifact${fallbackExt}`
  return extname(base).length === 0 ? `${base}${fallbackExt}` : base
}

function imageArtifactExtension(extension: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(extension.toLowerCase())
}

async function cleanupLooseWorkspaceSource(sourcePath: string, workspaceRoot: string, destinationPath: string): Promise<void> {
  const root = resolve(workspaceRoot)
  const source = resolve(sourcePath)
  if (source === resolve(destinationPath)) return
  const rel = relative(root, source)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
  await rm(source, { force: true })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
