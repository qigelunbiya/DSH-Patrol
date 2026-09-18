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

  it('allows stable UIA controlType/className selectors for unnamed interactive controls', () => {
    const base = {
      schemaVersion: '0.2' as const,
      id: 'wechat-edit-target',
      name: '微信输入区',
      description: 'UIA unnamed edit control',
      status: 'draft' as const,
      target: { type: 'desktop' as const, app: '微信' },
      expectedResult: '聚焦输入区',
      artifacts: [],
      auth: { mode: 'none' as const },
      schedule: null,
      metadata: { createdAt: '2026-09-18T01:00:00.000Z', updatedAt: '2026-09-18T01:00:00.000Z' },
    }

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '聚焦唯一输入区',
        tool: 'desktop_click_target',
        arguments: { controlType: 'Edit' },
        recordedAt: '2026-09-18T01:00:00.000Z',
      }],
    })).not.toThrow()

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '缺少定位条件',
        tool: 'desktop_click_target',
        arguments: {},
        recordedAt: '2026-09-18T01:00:00.000Z',
      }],
    })).toThrow(/name, automationId, controlType, or className/i)
  })

  it('validates targeted desktop typing with a stable UIA selector', () => {
    const base = {
      schemaVersion: '0.2' as const,
      id: 'wechat-type-target',
      name: '微信定向输入',
      description: 'targeted desktop typing',
      status: 'draft' as const,
      target: { type: 'desktop' as const, app: '微信', processName: 'WeChat' },
      expectedResult: '消息输入完成',
      artifacts: [],
      auth: { mode: 'none' as const },
      schedule: null,
      metadata: { createdAt: '2026-09-18T02:30:00.000Z', updatedAt: '2026-09-18T02:30:00.000Z' },
    }

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '输入微信消息',
        tool: 'desktop_type_target',
        arguments: {
          processName: 'WeChat',
          controlType: 'Edit',
          className: 'MessageInput',
          text: 'DSH Patrol 测试',
          clear: true,
        },
        recordedAt: '2026-09-18T02:30:00.000Z',
      }],
    })).not.toThrow()

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '缺少输入区 selector',
        tool: 'desktop_type_target',
        arguments: { text: 'DSH Patrol 测试' },
        recordedAt: '2026-09-18T02:30:00.000Z',
      }],
    })).toThrow(/desktop_type_target requires name, automationId, controlType, or className/i)
  })

  it('rejects secret-like text and code-like value selectors in persisted desktop steps', () => {
    const base = {
      schemaVersion: '0.2' as const,
      id: 'desktop-secret-safety',
      name: '桌面敏感数据保护',
      description: 'secret-safe desktop steps',
      status: 'draft' as const,
      target: { type: 'desktop' as const, app: '微信', processName: 'WeChat' },
      expectedResult: '不保存敏感数据',
      artifacts: [],
      auth: { mode: 'none' as const },
      schedule: null,
      metadata: { createdAt: '2026-09-18T03:30:00.000Z', updatedAt: '2026-09-18T03:30:00.000Z' },
    }

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '危险桌面输入',
        tool: 'desktop_type_target',
        arguments: { controlType: 'Edit', text: 'demo@1234' },
        recordedAt: '2026-09-18T03:30:00.000Z',
      }],
    })).toThrow(/secret-like/i)

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '危险 value selector',
        tool: 'desktop_wait_for_target',
        arguments: { source: 'uia', controlType: 'Edit', value: '123456' },
        recordedAt: '2026-09-18T03:30:00.000Z',
      }],
    })).toThrow(/code-like/i)
  })

  it('validates replayable semantic desktop waits without historical coordinates', () => {
    const base = {
      schemaVersion: '0.2' as const,
      id: 'wechat-wait-target',
      name: '等待微信目标',
      description: 'semantic desktop wait',
      status: 'draft' as const,
      target: { type: 'desktop' as const, app: '微信', processName: 'WeChat' },
      expectedResult: '联系人出现',
      artifacts: [],
      auth: { mode: 'none' as const },
      schedule: null,
      metadata: { createdAt: '2026-09-18T03:00:00.000Z', updatedAt: '2026-09-18T03:00:00.000Z' },
    }

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '等待联系人出现',
        tool: 'desktop_wait_for_target',
        arguments: {
          source: 'auto',
          text: '测试联系人',
          match: 'exact',
          requireUnique: true,
          processName: 'WeChat',
          timeoutMs: 10000,
          pollMs: 300,
        },
        recordedAt: '2026-09-18T03:00:00.000Z',
      }],
    })).not.toThrow()

    expect(() => assertInspectionDefinition({
      ...base,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '错误等待',
        tool: 'desktop_wait_for_target',
        arguments: { source: 'ocr', text: '测试联系人', timeoutMs: 50 },
        recordedAt: '2026-09-18T03:00:00.000Z',
      }],
    })).toThrow(/timeoutMs must be between 100 and 120000/i)
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
