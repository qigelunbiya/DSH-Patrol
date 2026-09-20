import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolVisualClickTool } from '../src/visual-click-tools.ts'
import { createPatrolClickOutcomeTracker } from '../src/click-retry-state.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(dispatch: (tool: string, args: JsonObject) => Promise<any>, clickOutcomes?: any) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-visual-click-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  await store.create(draftDefinition())

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  registerPatrolVisualClickTool(ctx, store, { dispatch } as any, { maxSteps: 20, clickOutcomes })
  const tool = definitions.find(item => item.name === 'patrol_visual_click_target')
  if (!tool) throw new Error('patrol_visual_click_target not registered')
  const exec = {
    token: Symbol('visual-click-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, tool, exec }
}

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'visual-click',
    name: 'Visual click',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://www.bilibili.com/video/BV-test' },
    expectedResult: 'liked',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now, taskChecklist: ['给视频点赞'] },
  }
}

describe('browser visual fallback click teaching', () => {
  it('records a verified Bilibili-like visual hit as replayable selector-first geometry', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: '视频页面 5743', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', text: '视频页面 5743' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', elements: [] } }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-current',
          xRatio: 0.17,
          yRatio: 0.81,
        })
        return {
          ok: true,
          text: 'visual clicked',
          value: {
            ok: true,
            xRatio: 0.17,
            yRatio: 0.81,
            selectorHint: 'top-frame::.video-like',
            urlIdentity: 'https://www.bilibili.com/video/BV-test',
            viewportWidth: 1280,
            viewportHeight: 720,
            viewportScale: 1,
            captureClientLeft: 12,
            captureClientTop: 24,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'cdp-css-visual-viewport',
            scrollX: 0,
            scrollY: 480,
            targetTag: 'div',
            targetRole: 'button',
            targetText: '5743',
            targetTitle: '点赞',
            targetAriaLabel: '点赞',
            targetId: 'like-button',
            targetClassName: 'video-like active',
            requestedClickX: 205,
            requestedClickY: 583,
            resolvedClickX: 218,
            resolvedClickY: 576,
            visualSnapped: true,
            snapDistance: 14.8,
            targetStateChanged: true,
            stateEvidence: 'clicked visual target DOM state changed',
            transport: 'bound-current-visual-frame',
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '播放器下方左侧的大拇指点赞按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.17,
      yRatio: 0.81,
    }, exec)

    expect(result).toContain('browser_visual_click')
    expect(result).toContain('Coordinate corrected before click')
    const saved = await store.load('visual-click')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_visual_click',
      arguments: {
        xRatio: 0.17,
        yRatio: 0.81,
        selectorHint: 'top-frame::.video-like',
        urlIdentity: 'https://www.bilibili.com/video/BV-test',
        viewportWidth: 1280,
        viewportHeight: 720,
        viewportScale: 1,
        captureClientLeft: 12,
        captureClientTop: 24,
        captureWidth: 1280,
        captureHeight: 720,
        captureMode: 'cdp-css-visual-viewport',
        scrollX: 0,
        scrollY: 480,
        expectedTag: 'div',
        expectedRole: 'button',
        expectedTitle: '点赞',
        expectedAriaLabel: '点赞',
        targetHint: '播放器下方左侧的大拇指点赞按钮',
        targetTextHint: '5743',
        targetIdHint: 'like-button',
        targetClassHint: 'video-like active',
      },
      taskHint: '播放器下方左侧的大拇指点赞按钮',
      teaching: {
        status: 'verified',
        method: 'state-change',
        evidence: 'clicked visual target DOM state changed',
      },
    })
    expect((saved.steps[0] as any).arguments.frameId).toBeUndefined()
    expect((saved.steps[0] as any).arguments.tabId).toBeUndefined()
    expect(calls.map(call => call.tool)).toEqual([
      'browser_read_page',
      'browser_snapshot',
      'browser_visual_click',
    ])
  })

  it('rejects unrelated dynamic-page false positives such as clicking the Bilibili sending bar for a like target', async () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return { ok: true, text: 'video', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', text: 'video' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', elements: [] } }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'clicked sending bar',
        value: {
          ok: true,
          selectorHint: 'top-frame::div.bpx-player-sending-bar',
          targetTag: 'div',
          targetClassName: 'bpx-player-sending-bar',
          targetStateChanged: false,
          urlIdentity: 'https://www.bilibili.com/video/BV-test',
          viewportWidth: 1280,
          viewportHeight: 720,
          scrollX: 0,
          scrollY: 0,
        },
      }
      throw new Error(`unexpected tool ${name}`)
    }, outcomes)

    const args = {
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '大拇指点赞按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.15,
      yRatio: 0.85,
    }
    const result = await tool.execute(args, exec)
    expect(result).toMatch(/NOT recorded/)
    expect(result).toMatch(/点赞\/like/)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
    expect(outcomes.unverifiedPhysicalClicks(args)).toBe(1)
  })

  it('does not consume visual physical-click budget when browser_visual_click fails before clicking', async () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const { tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return { ok: true, text: '首页', value: { ok: true, url: 'https://www.bilibili.com/', text: '首页' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/', elements: [] } }
      if (name === 'browser_visual_click') return { ok: false, error: 'browser visual frame is stale or unavailable', text: '' }
      throw new Error(`unexpected tool ${name}`)
    }, outcomes)

    const args = {
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '大拇指点赞按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.1,
      yRatio: 0.8,
    }
    const result = await tool.execute(args, exec)
    expect(result).toMatch(/does NOT consume/i)
    expect(outcomes.visualPhysicalClicks(args)).toBe(0)
    expect(outcomes.unverifiedPhysicalClicks(args)).toBe(0)
  })

  it('requires a concrete targetHint before dispatching any live visual coordinate', async () => {
    const calls: string[] = []
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击评论输入框',
      targetHint: ' ',
      frameId: 'browser-visual-current',
      xRatio: 0.5,
      yRatio: 0.8,
    }, exec)).rejects.toThrow(/targetHint is required.*validate\/correct/i)
    expect(calls).toEqual([])
  })

  it('rejects a screenshot file name used as frameId before dispatch', async () => {
    const calls: string[] = []
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '大拇指点赞按钮',
      frameId: 'screenshot-2026-09-20T01-40-03.png',
      xRatio: 0.1,
      yRatio: 0.8,
    }, exec)).rejects.toThrow(/visualFrameId.*not the screenshot file/i)
    expect(calls).toEqual([])
  })

  it('refuses CAPTCHA/image-code targets before any browser visual dispatch', async () => {
    const calls: string[] = []
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击验证码',
      targetHint: '四位图片验证码',
      frameId: 'browser-visual-current',
      xRatio: 0.5,
      yRatio: 0.5,
    }, exec)).rejects.toThrow(/forbidden.*CAPTCHA|Windows\/local OCR/i)
    expect(calls).toEqual([])
  })
})
