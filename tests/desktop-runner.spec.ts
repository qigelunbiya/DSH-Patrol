import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop Runbook replay', () => {
  it('replays desktop steps and resolves the latest browser screenshot artifact into a desktop clipboard handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-runner-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const providerShot = join(root, 'provider.png')
    await writeFile(providerShot, 'fake png')

    const calls: Array<{ name: string; arguments: any }> = []
    const ctx = {
      tools: {
        execute: async (input: { name: string; arguments: any }) => {
          calls.push({ name: input.name, arguments: input.arguments })
          if (input.name === 'browser_screenshot') {
            return {
              isError: false,
              value: { ok: true, path: providerShot },
              content: [{ type: 'text', text: 'browser screenshot captured' }],
            }
          }
          if (input.name === 'desktop_set_clipboard_files') {
            return {
              isError: false,
              value: { ok: true, paths: input.arguments.paths },
              content: [{ type: 'text', text: 'desktop clipboard files set' }],
            }
          }
          if (input.name === 'desktop_paste') {
            return {
              isError: false,
              value: { ok: true },
              content: [{ type: 'text', text: 'desktop paste sent' }],
            }
          }
          throw new Error(`unexpected tool ${input.name}`)
        },
      },
    } as unknown as Context

    const store = new PatrolStore(join(root, 'store'))
    await store.init()
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'browser-to-wechat',
      name: '浏览器截图转桌面',
      description: '浏览器截图后交给桌面应用',
      status: 'ready',
      target: { type: 'browser', url: 'https://example.com' },
      expectedResult: '桌面应用收到浏览器截图',
      artifacts: ['screenshot'],
      auth: { mode: 'none' },
      schedule: null,
      steps: [
        {
          id: 'step-001',
          kind: 'tool',
          name: '网页截图',
          tool: 'browser_screenshot',
          arguments: {},
          artifact: 'screenshot',
          recordedAt: '2026-09-18T00:00:00.000Z',
        },
        {
          id: 'step-002',
          kind: 'tool',
          name: '把截图放入桌面剪贴板',
          tool: 'desktop_set_clipboard_files',
          arguments: { paths: ['${artifact:last-screenshot}'] },
          recordedAt: '2026-09-18T00:00:01.000Z',
        },
        {
          id: 'step-003',
          kind: 'tool',
          name: '粘贴截图',
          tool: 'desktop_paste',
          arguments: {},
          recordedAt: '2026-09-18T00:00:02.000Z',
        },
      ],
      metadata: {
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:02.000Z',
        validatedAt: '2026-09-18T00:00:03.000Z',
        workspaceRoot: workspace,
        taskChecklist: ['网页截图', '把截图放入桌面剪贴板', '粘贴截图'],
      },
    }
    await store.save(definition)

    const exec = {
      token: Symbol('desktop-runner-parent'),
      rootCallId: 'root',
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: workspace } } },
    } as unknown as ToolRunContext

    const { report } = await runner.run(definition, exec)

    expect(report.status).toBe('passed')
    expect(report.results.map(item => [item.stepId, item.status])).toEqual([
      ['step-001', 'passed'],
      ['step-002', 'passed'],
      ['step-003', 'passed'],
    ])
    expect(calls.map(item => item.name)).toEqual([
      'browser_screenshot',
      'desktop_set_clipboard_files',
      'desktop_paste',
    ])
    const clipboardPath = calls[1]?.arguments?.paths?.[0]
    expect(typeof clipboardPath).toBe('string')
    expect(clipboardPath).not.toBe('${artifact:last-screenshot}')
    expect(clipboardPath).toContain('patrol-results')
  })

  it('runs a native desktop-only inspection without requiring any browser target or browser dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-only-'))
    roots.push(root)
    const calls: Array<{ name: string; arguments: any }> = []
    const ctx = {
      tools: {
        execute: async (input: { name: string; arguments: any }) => {
          calls.push({ name: input.name, arguments: input.arguments })
          return {
            isError: false,
            value: { ok: true },
            content: [{ type: 'text', text: `${input.name} ok` }],
          }
        },
      },
    } as unknown as Context
    const store = new PatrolStore(join(root, 'store'))
    await store.init()
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'wechat-only',
      name: '微信桌面巡检',
      description: '只操作微信，不使用浏览器',
      status: 'ready',
      target: { type: 'desktop', app: '微信', processName: 'WeChat', titleContains: '微信' },
      expectedResult: '打开微信并进入指定聊天',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [
        {
          id: 'step-001',
          kind: 'tool',
          name: '激活微信',
          tool: 'desktop_activate_window',
          arguments: { processName: 'WeChat', titleContains: '微信' },
          recordedAt: '2026-09-18T01:00:00.000Z',
        },
        {
          id: 'step-002',
          kind: 'tool',
          name: '打开搜索',
          tool: 'desktop_hotkey',
          arguments: { combo: 'Ctrl+F' },
          recordedAt: '2026-09-18T01:00:01.000Z',
        },
        {
          id: 'step-003',
          kind: 'tool',
          name: '输入联系人',
          tool: 'desktop_type_text',
          arguments: { text: '测试联系人', clear: true },
          recordedAt: '2026-09-18T01:00:02.000Z',
        },
      ],
      metadata: {
        createdAt: '2026-09-18T01:00:00.000Z',
        updatedAt: '2026-09-18T01:00:02.000Z',
        validatedAt: '2026-09-18T01:00:03.000Z',
        taskChecklist: ['激活微信', '打开搜索', '输入联系人'],
      },
    }

    const exec = {
      token: Symbol('desktop-only-parent'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const { report } = await runner.run(definition, exec)

    expect(report.status).toBe('passed')
    expect(calls.map(item => item.name)).toEqual([
      'desktop_activate_window',
      'desktop_hotkey',
      'desktop_type_text',
    ])
    expect(calls.some(item => item.name.startsWith('browser_'))).toBe(false)
  })

  it('fails before dispatch when a desktop artifact placeholder has no prior screenshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-desktop-placeholder-'))
    roots.push(root)
    const calls: string[] = []
    const ctx = {
      tools: {
        execute: async (input: { name: string }) => {
          calls.push(input.name)
          return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] }
        },
      },
    } as unknown as Context
    const store = new PatrolStore(join(root, 'store'))
    await store.init()
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'missing-artifact',
      name: '缺少截图',
      description: '测试缺少截图引用',
      status: 'ready',
      target: { type: 'browser', url: 'https://example.com' },
      expectedResult: '失败',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '引用截图',
        tool: 'desktop_set_clipboard_files',
        arguments: { paths: ['${artifact:last-screenshot}'] },
        recordedAt: '2026-09-18T00:00:00.000Z',
      }],
      metadata: {
        createdAt: '2026-09-18T00:00:00.000Z',
        updatedAt: '2026-09-18T00:00:00.000Z',
        validatedAt: '2026-09-18T00:00:00.000Z',
        taskChecklist: ['引用截图'],
      },
    }

    const exec = {
      token: Symbol('desktop-placeholder-parent'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext
    const { report } = await runner.run(definition, exec)

    expect(report.status).toBe('failed')
    expect(report.results[0]?.error).toMatch(/no prior screenshot artifact/i)
    expect(calls).toEqual([])
  })
})
