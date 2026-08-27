import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export const name = 'dsh-patrol-preset-installer'
export const inject: string[] = []

const PRESET_ID = 'patrol'
const MANAGED_MARKER = '.managed-by-dsh-patrol'

export async function apply(ctx: Context): Promise<void> {
  const source = fileURLToPath(new URL('../presets/patrol/', import.meta.url))
  const target = dshHomePath('.agent-presets', PRESET_ID)
  const marker = join(target, MANAGED_MARKER)
  const exists = await pathExists(target)
  const managed = await pathExists(marker)

  if (exists && !managed) {
    ctx.logger.warn(`dsh-patrol: preset ${target} already exists and is not managed by DSH Patrol; leaving it untouched`)
    return
  }

  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    const content = await readFile(join(source, file), 'utf8')
    await writeFile(join(target, file), content, { encoding: 'utf8', mode: 0o600 })
  }
  await writeFile(marker, 'managed by dsh-patrol; edit the package preset source or remove this marker to take ownership\n', { encoding: 'utf8', mode: 0o600 })
  ctx.logger.info(`dsh-patrol: installed/updated Agent Preset "${PRESET_ID}" at ${target}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
