import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolCreationTools } from '../src/creation-tools.js'
import { PatrolStore } from '../src/store.js'
import { assertInspectionDefinition } from '../src/validation.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native desktop inspection targets', () => {
  it('accepts desktop targets without a URL and rejects ephemeral desktop identity', () => {
    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2',
      id: 'wechat-desktop',
      name: '微信桌面巡检',
      description: '桌面应用巡检',
      status: 'draft',
      target: { type: 'desktop', app: '微信', processName: 'WeChat', titleContains: '微信' },
      expectedResult: '完成桌面操作',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '激活微信',
        tool: 'desktop_activate_window',
        arguments: { processName: 'WeChat', titleContains: '微信' },
        recordedAt: '2026-09-18T01:00:00.000Z',
      }],
      metadata: { createdAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-18T01:00:00.000Z' },
    })).not.toThrow()

    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2',
      id: 'wechat-desktop',
      name: '微信桌面巡检',
      description: '桌面应用巡检',
      status: 'draft',
      target: { type: 'desktop', app: '微信' },
      expectedResult: '完成桌面操作',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '激活微信',
        tool: 'desktop_activate_window',
        arguments: { processId: 1234 },
        recordedAt: '2026-09-18T01:00:00.000Z',
      }],
      metadata: { createdAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-18T01:00:00.000Z' },
    })).toThrow(/ephemeral desktop hwnd\/processId/i)
  })

  it('creates a desktop-only draft without inventing targetUrl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-target-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
      },
    } as unknown as Context

    registerPatrolCreationTools(ctx, store)
    const create = definitions.find(item => item.name === 'patrol_create_inspection')
    expect(create).toBeDefined()

    const result = await create.execute({
      inspectionId: 'wechat-contact-test',
      name: '微信联系人测试',
      description: '搜索指定联系人并发送测试消息',
      targetType: 'desktop',
      desktopApp: '微信',
      desktopProcessName: 'WeChat',
      desktopTitleContains: '微信',
      expectedResult: '联系人收到测试消息',
      authMode: 'none',
      artifacts: ['markdown-report'],
    })

    expect(result).toContain('desktop target')
    const definition = await store.load('wechat-contact-test')
    expect(definition.target).toEqual({
      type: 'desktop',
      app: '微信',
      processName: 'WeChat',
      titleContains: '微信',
    })
    expect('url' in definition.target).toBe(false)
  })

  it('keeps browser creation backward compatible when targetType is omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-browser-target-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
      },
    } as unknown as Context

    registerPatrolCreationTools(ctx, store)
    const create = definitions.find(item => item.name === 'patrol_create_inspection')
    await create.execute({
      inspectionId: 'browser-backcompat',
      name: '网页巡检',
      description: '保持原有网页创建协议',
      targetUrl: 'https://example.com',
      expectedResult: '页面可访问',
      authMode: 'none',
      artifacts: ['markdown-report'],
    })

    expect((await store.load('browser-backcompat')).target).toEqual({
      type: 'browser',
      url: 'https://example.com',
    })
  })
})
