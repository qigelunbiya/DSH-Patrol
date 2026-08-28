import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { assertInspectionDefinition, assertInspectionId } from './validation.js'
import type { InspectionDefinition, ResumeState, RunReport, SavedRunPaths } from './types.js'

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

  workspaceRunPaths(inspectionId: string, runId: string, workspaceRoot: string): SavedRunPaths {
    assertInspectionId(inspectionId)
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('invalid runId')
    const stem = `patrol-${inspectionId}-${runId}`
    return {
      directory: workspaceRoot,
      json: join(workspaceRoot, `${stem}-report.json`),
      markdown: join(workspaceRoot, `${stem}-report.md`),
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

    if (workspaceRoot === undefined || workspaceRoot.trim() === '') return internal
    const visible = this.workspaceRunPaths(report.inspectionId, report.runId, workspaceRoot)
    await atomicWrite(visible.json, `${JSON.stringify(report, null, 2)}\n`)
    await atomicWrite(visible.markdown, markdown)
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

    await mkdir(workspaceRoot, { recursive: true })
    const visible = join(workspaceRoot, visibleArtifactName(inspectionId, runId, safeName))
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

    await mkdir(workspaceRoot, { recursive: true })
    const visible = join(workspaceRoot, visibleArtifactName(inspectionId, runId, safeName))
    await copyFile(sourcePath, visible)
    await chmod(visible, 0o600)
    return visible
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

function visibleArtifactName(inspectionId: string, runId: string, safeName: string): string {
  return sanitizeArtifactName(`patrol-${inspectionId}-${runId}-${safeName}`, extname(safeName) || '.bin')
}

function sanitizeArtifactName(name: string, fallbackExt: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || `artifact${fallbackExt}`
  return extname(base).length === 0 ? `${base}${fallbackExt}` : base
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
