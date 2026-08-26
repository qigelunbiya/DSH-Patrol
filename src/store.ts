import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertInspectionDefinition, assertInspectionId } from './validation.ts'
import type { InspectionDefinition, RunReport, SavedRunPaths } from './types.ts'

export class PatrolStore {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.root, 'inspections'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'runs'), { recursive: true, mode: 0o700 })
  }

  inspectionDirectory(id: string): string {
    assertInspectionId(id)
    return join(this.root, 'inspections', id)
  }

  inspectionPath(id: string): string {
    return join(this.inspectionDirectory(id), 'inspection.json')
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
    const file = this.inspectionPath(definition.id)
    await atomicWrite(file, `${JSON.stringify(definition, null, 2)}\n`)
  }

  async load(id: string): Promise<InspectionDefinition> {
    const raw = await readFile(this.inspectionPath(id), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    assertInspectionDefinition(parsed)
    return parsed
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
        // Ignore broken directories in listing; `patrol_show` will surface the precise error.
      }
    }
    return definitions.sort((a, b) => a.id.localeCompare(b.id))
  }

  async saveRun(report: RunReport, markdown: string): Promise<SavedRunPaths> {
    const directory = join(this.root, 'runs', report.inspectionId, report.runId)
    const json = join(directory, 'report.json')
    const markdownPath = join(directory, 'report.md')
    await atomicWrite(json, `${JSON.stringify(report, null, 2)}\n`)
    await atomicWrite(markdownPath, markdown)
    return { directory, json, markdown: markdownPath }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
