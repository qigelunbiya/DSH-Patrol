import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolDesktopRecordTools } from '../src/desktop-record-tools.js'
import { PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT } from '../src/desktop-visual-isolation-prompt.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop visual isolation and retrospective recording', () => {
  it('keeps browser visual mechanisms explicitly out of desktop coordinate grounding', () => {
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('Action Map')
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('candidateId')
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('全部只属于浏览器')
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('desktop_screenshot')
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('xRatio/yRatio')
    expect(PATROL_DESKTOP_VISUAL_ISOLATION_PROMPT).toContain('不做任何改变')
  })

  it('records an already-successful desktop action without changing the 048b execution tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-record-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const now = '2026-09-22T10:00:00.000Z'
    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'desktop-record',
      name: '桌面补录',
      description: 'record completed desktop action',
      status: 'draft',
      target: { type: 'desktop', app: '蓝信', processName: 'LxMainNew' },
      expectedResult: '消息已发送',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [],
      metadata: {
        createdAt: now,
        updatedAt: now,
        taskChecklist: ['打开联系人'],
      },
    }
    await store.create(definition)

    const registered: any[] = []
    const ctx = {
      tools: {
        register(tool: any) {
          registered.push(tool)
          return () => {}
        },
      },
    } as unknown as Context

    registerPatrolDesktopRecordTools(ctx, store, { maxSteps: 20 })
    const tool = registered.find(item => item.name === 'patrol_record_desktop_step')
    if (!tool) throw new Error('patrol_record_desktop_step not registered')

    const result = await tool.execute({
      inspectionId: 'desktop-record',
      stepName: '打开方泽铭会话',
      action: 'click-visual-point',
      storedArguments: {
        processName: 'LxMainNew',
        titleContains: '蓝信',
        xRatio: 0.25,
        yRatio: 0.33,
        frameId: 'ephemeral-frame',
        hwnd: 123,
      },
      executionInstruction: '激活蓝信窗口，在当前搜索结果中点击方泽铭联系人并确认进入对应会话。',
    })

    expect(result).toContain('without re-executing')
    const saved = await store.load('desktop-record')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'desktop_click_visual_point',
      executionPlane: 'desktop',
      executionInstruction: '激活蓝信窗口，在当前搜索结果中点击方泽铭联系人并确认进入对应会话。',
      arguments: {
        processName: 'LxMainNew',
        titleContains: '蓝信',
        xRatio: 0.25,
        yRatio: 0.33,
      },
    })
    if (saved.steps[0]?.kind === 'tool') {
      expect(saved.steps[0].arguments).not.toHaveProperty('frameId')
      expect(saved.steps[0].arguments).not.toHaveProperty('hwnd')
    }
  })
})
