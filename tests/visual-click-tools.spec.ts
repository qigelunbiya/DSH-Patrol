import { readFileSync } from 'node:fs'
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
import { createPatrolVisualEvidenceRegistry, type PatrolVisualEvidenceRegistry } from '../src/visual-evidence-registry.ts'

const visualToolSource = readFileSync(join(process.cwd(), 'src', 'visual-click-tools.ts'), 'utf8')
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(
  dispatch: (tool: string, args: JsonObject) => Promise<any>,
  clickOutcomes?: any,
  visualEvidence?: PatrolVisualEvidenceRegistry,
  requirePreview = false,
  testMode = false,
) {
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
  registerPatrolVisualClickTool(ctx, store, { dispatch } as any, { maxSteps: 20, clickOutcomes, visualEvidence, requirePreview, testMode })
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
  it('forwards CURRENT model-raster image pixels without model-side ratio conversion', async () => {
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-pixel', 'visual-click')
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: '任务列表', value: { ok: true, url: 'http://example.test/tasks', title: '任务', text: '任务列表' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'http://example.test/tasks', title: '任务', elements: [] } }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-pixel',
          imageX: 742,
          imageY: 112,
          imageWidth: 1024,
          imageHeight: 576,
          targetHint: '我的任务右侧的×',
          visualAuthority: true,
        })
        expect(args).not.toHaveProperty('xRatio')
        expect(args).not.toHaveProperty('candidateId')
        return {
          ok: true,
          text: 'clicked raw raster pixel',
          value: {
            ok: true,
            xRatio: 742 / 1024,
            yRatio: 112 / 576,
            requestedXRatio: 742 / 1024,
            requestedYRatio: 112 / 576,
            requestedImageX: 742,
            requestedImageY: 112,
            modelRasterWidth: 1024,
            modelRasterHeight: 576,
            coordinateSource: 'model-raster-pixel',
            targetTag: 'span',
            targetText: '×',
            targetStateChanged: true,
            selectorHint: 'top-frame::.filter-chip .remove',
            selectorReplaySafe: true,
            selectorQuality: 'medium',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            urlIdentity: 'http://example.test/tasks',
            viewportWidth: 1280,
            viewportHeight: 720,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'cdp-css-visual-viewport',
            scrollX: 0,
            scrollY: 0,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence)

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '关闭我的任务筛选',
      targetHint: '我的任务右侧的×',
      imageX: 742,
      imageY: 112,
      imageWidth: 1024,
      imageHeight: 576,
    }, exec)

    expect(result).toContain('browser_visual_click')
    expect(calls.some(call => call.tool === 'browser_visual_click' && call.args.imageX === 742)).toBe(true)
    expect((await store.load('visual-click')).steps).toHaveLength(1)
  })

  it('gives only the B# recovery path when a TEST MODE precision target has no coordinate source yet', async () => {
    const calls: string[] = []
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-nosource', 'visual-click')
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击龙之信条2百度百科搜索结果',
      targetHint: '龙之信条 2 - 百度百科 搜索结果链接',
      expectedVisualText: '龙之信条 2 - 百度百科',
    }, exec)).rejects.toThrow(/requires Browser Pixel Grounding.*Do not use xRatio\/yRatio, imageX\/imageY, previewId, or legacy A# candidateId.*pixelActionMap=true.*pixelCandidateId="B#"/i)

    expect(calls).toEqual([])
  })

  it('hard-rejects TEST MODE ratio clicks for precision text/navigation targets before any browser dispatch', async () => {
    const calls: string[] = []
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-precision', 'visual-click')
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击龙之信条2百度百科搜索结果',
      targetHint: '龙之信条 2 - 百度百科 搜索结果链接',
      expectedVisualText: '龙之信条 2 - 百度百科',
      xRatio: 0.25,
      yRatio: 0.15,
    }, exec)).rejects.toThrow(/TEST MODE precision visual click refused before physical input.*requires Browser Pixel Grounding.*pixelCandidateId="B#"/i)

    expect(calls).toEqual([])
  })

  it('hard-rejects TEST MODE image pixels for tiny close targets before physical input', async () => {
    const calls: string[] = []
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-close', 'visual-click')
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '关闭我的任务筛选',
      targetHint: '我的任务右侧的×',
      imageX: 742,
      imageY: 112,
      imageWidth: 1024,
      imageHeight: 576,
    }, exec)).rejects.toThrow(/TEST MODE precision visual click refused before physical input.*focused.*pixelActionMap=true/i)

    expect(calls).toEqual([])
  })

  it('hard-rejects legacy A# for TEST MODE precision chapter targets', async () => {
    const calls: string[] = []
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-chapter', 'visual-click')
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击7.发售版本',
      targetHint: '7.发售版本 章节',
      candidateId: 'A7',
    }, exec)).rejects.toThrow(/Do not use xRatio\/yRatio, imageX\/imageY, previewId, or legacy A# candidateId/i)

    expect(calls).toEqual([])
  })

  it('allows large obvious controls to keep direct image-pixel clicking in TEST MODE', async () => {
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-search', 'visual-click')
    let dispatched = false
    const { tool, exec } = await setup(async (name, args) => {
      if (name === 'browser_read_page') return { ok: true, text: '百度', value: { ok: true, url: 'https://www.baidu.com/', title: '百度一下', text: '百度' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.baidu.com/', title: '百度一下', elements: [] } }
      if (name === 'browser_visual_click') {
        dispatched = true
        expect(args).toMatchObject({
          frameId: 'browser-visual-search',
          imageX: 512,
          imageY: 300,
          targetHint: '百度搜索框',
          visualAuthority: true,
        })
        return {
          ok: true,
          text: 'focused search box',
          value: {
            ok: true,
            xRatio: 0.5, yRatio: 0.5,
            requestedXRatio: 0.5, requestedYRatio: 0.5,
            coordinateSource: 'model-raster-pixel',
            targetFocusedEditable: true,
            targetStateChanged: true,
            targetTag: 'input',
            targetRole: 'textbox',
            targetText: '',
            targetAriaLabel: '搜索',
            selectorHint: '#kw',
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            urlIdentity: 'https://www.baidu.com/',
            viewportWidth: 1024, viewportHeight: 600,
            captureClientLeft: 0, captureClientTop: 0, captureWidth: 1024, captureHeight: 600,
            captureMode: 'cdp-css-visual-viewport',
            scrollX: 0, scrollY: 0,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击百度搜索框',
      targetHint: '百度搜索框',
      imageX: 512,
      imageY: 300,
      imageWidth: 1024,
      imageHeight: 600,
    }, exec)

    expect(dispatched).toBe(true)
    expect(result).toContain('browser_visual_click')
  })

  it('uses a Browser Pixel Action Map B# candidate without model-provided coordinates', async () => {
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-bmap', 'visual-click')
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: '我的任务 开放任务', value: { ok: true, url: 'http://example.test/tasks', title: '任务', text: '我的任务 开放任务' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'http://example.test/tasks', title: '任务', elements: [] } }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-bmap',
          pixelCandidateId: 'B3',
          targetHint: '我的任务右侧的×',
          visualAuthority: true,
          pointerAction: 'left-click',
        })
        expect(args).not.toHaveProperty('imageX')
        expect(args).not.toHaveProperty('candidateId')
        return {
          ok: true,
          text: 'clicked B3',
          value: {
            ok: true,
            pixelCandidateId: 'B3',
            pixelCandidateBBox: '700,70,18,18',
            pixelCandidateCenterX: 709,
            pixelCandidateCenterY: 79,
            xRatio: 0.692,
            yRatio: 0.137,
            requestedXRatio: 0.692,
            requestedYRatio: 0.137,
            coordinateSource: 'pixel-action-map-candidate',
            targetTag: 'span',
            targetText: '×',
            targetStateChanged: true,
            selectorHint: 'top-frame::.filter-chip .remove',
            selectorReplaySafe: true,
            selectorQuality: 'medium',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            urlIdentity: 'http://example.test/tasks',
            viewportWidth: 1280,
            viewportHeight: 720,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'cdp-focused-region',
            scrollX: 0,
            scrollY: 0,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence, false, true)

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '关闭我的任务筛选',
      targetHint: '我的任务右侧的×',
      pixelCandidateId: 'B3',
    }, exec)

    expect(result).toContain('browser_visual_click')
    expect(calls.some(call => call.tool === 'browser_visual_click' && call.args.pixelCandidateId === 'B3')).toBe(true)
    expect((await store.load('visual-click')).steps).toHaveLength(1)
  })

  it('auto-binds candidate clicks to the latest model-visible frame when frameId is omitted', async () => {
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    visualEvidence.mark('browser-visual-latest', 'visual-click')
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: 'video', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', title: 'video', text: 'video' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', title: 'video', elements: [] } }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-latest',
          candidateId: 'A2',
          targetHint: '点赞按钮',
          visualAuthority: true,
        })
        return {
          ok: true,
          text: 'clicked',
          value: {
            ok: true,
            candidateId: 'A2',
            xRatio: 0.2,
            yRatio: 0.8,
            requestedXRatio: 0.2,
            requestedYRatio: 0.8,
            targetTag: 'button',
            targetRole: 'button',
            targetText: '点赞',
            targetStateChanged: true,
            selectorHint: 'top-frame::button.like',
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-action-map-post-click-learning',
            visualAuthority: true,
            urlIdentity: 'https://www.bilibili.com/video/BV-test',
            viewportWidth: 1280,
            viewportHeight: 720,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'capture-visible-tab-layout-viewport',
            scrollX: 0,
            scrollY: 0,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence)

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '点赞按钮',
      candidateId: 'A2',
    }, exec)

    expect(result).toContain('candidate A2')
    expect(calls.some(call => call.tool === 'browser_visual_click' && call.args.frameId === 'browser-visual-latest')).toBe(true)
  })

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
          visualAuthority: true,
        })
        return {
          ok: true,
          text: 'visual clicked',
          value: {
            ok: true,
            xRatio: 0.17,
            yRatio: 0.81,
            requestedXRatio: 0.17,
            requestedYRatio: 0.81,
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
            visualSnapped: false,
            snapDistance: 0,
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
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
      visualAuthority: true,
    }, exec)

    expect(result).toContain('browser_visual_click')
    expect(result).toContain('exact model-selected screenshot point')
    expect(result).toContain('Learned reusable DOM/semantic binding')
    const saved = await store.load('visual-click')
    expect(saved.steps).toHaveLength(1)
    expect(saved.steps[0]).toMatchObject({
      tool: 'browser_visual_click',
      arguments: {
        xRatio: 0.17,
        yRatio: 0.81,
        selectorHint: 'top-frame::.video-like',
        learnedLocatorText: '点赞',
        learnedLocatorRole: 'button',
        learnedLocatorTag: 'div',
        learnedSelectorQuality: 'strong',
        learnedBindingSource: 'visual-hit-test-post-click-learning',
        replayPlan: {
          primary: {
            tool: 'browser_visual_click',
            mode: 'learned-semantic',
            learnedLocatorText: '点赞',
            learnedLocatorRole: 'button',
            learnedLocatorTag: 'div',
          },
          secondary: {
            tool: 'browser_click',
            selector: 'top-frame::.video-like',
          },
          fallback: {
            tool: 'browser_visual_click',
            mode: 'guarded-visual-coordinate',
            xRatio: 0.17,
            yRatio: 0.81,
          },
        },
        teachingControlMode: 'visual-grounding',
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



  it('accepts a vision-selected action-map candidate without model-provided x/y and persists resolved geometry', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: '视频页面', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', text: '视频页面' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', elements: [] } }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-current',
          candidateId: 'A4',
          visualAuthority: true,
          pointerAction: 'left-click',
        })
        expect(args.xRatio).toBeUndefined()
        expect(args.yRatio).toBeUndefined()
        return {
          ok: true,
          text: 'candidate clicked',
          value: {
            ok: true,
            candidateId: 'A4',
            xRatio: 0.1825,
            yRatio: 0.8125,
            requestedXRatio: 0.1825,
            requestedYRatio: 0.8125,
            selectorHint: 'top-frame::.video-like',
            urlIdentity: 'https://www.bilibili.com/video/BV-test',
            viewportWidth: 1280,
            viewportHeight: 720,
            viewportScale: 1,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'cdp-focused-region',
            scrollX: 0,
            scrollY: 480,
            targetTag: 'div',
            targetRole: 'button',
            targetText: '2.1万',
            targetTitle: '点赞',
            targetAriaLabel: '点赞',
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-action-map-post-click-learning',
            visualAuthority: true,
            targetStateChanged: true,
            stateEvidence: 'like activated',
            transport: 'bound-action-map-candidate',
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
      candidateId: 'A4',
    }, exec)

    expect(result).toContain('candidate A4')
    expect(result).toContain('model selected the labeled box')
    const saved = await store.load('visual-click')
    expect(saved.steps).toHaveLength(1)
    expect((saved.steps[0] as any).arguments).toMatchObject({
      xRatio: 0.1825,
      yRatio: 0.8125,
      targetHint: '播放器下方左侧的大拇指点赞按钮',
    })
    expect((saved.steps[0] as any).arguments.candidateId).toBeUndefined()
  })

  it('uses candidate-owned visible text for navigation without forcing the model to retype expectedVisualText', async () => {
    let reads = 0
    const { store, tool, exec } = await setup(async (name, args) => {
      if (name === 'browser_read_page') {
        reads += 1
        const before = reads === 1
        const url = before ? 'https://www.baidu.com/s?wd=dragon' : 'https://baike.baidu.com/item/dragon'
        const title = before ? '百度搜索' : '龙之信条2_百度百科'
        const text = before ? '搜索结果' : '龙之信条2 百度百科'
        return { ok: true, text, value: { ok: true, url, title, text } }
      }
      if (name === 'browser_snapshot') {
        const before = reads <= 1
        return {
          ok: true,
          text: 'snapshot',
          value: {
            ok: true,
            url: before ? 'https://www.baidu.com/s?wd=dragon' : 'https://baike.baidu.com/item/dragon',
            title: before ? '百度搜索' : '龙之信条2_百度百科',
            elements: [],
          },
        }
      }
      if (name === 'browser_visual_click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-current',
          candidateId: 'A2',
          visualAuthority: true,
        })
        expect(args.expectedVisualText).toBeUndefined()
        return {
          ok: true,
          text: 'candidate navigation clicked',
          value: {
            ok: true,
            candidateId: 'A2',
            actionCandidateExpectedText: '龙之信条2 百度百科',
            actionCandidateKind: 'anchor',
            actionCandidateHref: 'https://baike.baidu.com/item/dragon',
            xRatio: 0.31,
            yRatio: 0.77,
            requestedXRatio: 0.31,
            requestedYRatio: 0.77,
            selectorHint: 'top-frame::a.baike-result',
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingActionable: true,
            bindingSource: 'visual-action-map-post-click-learning',
            visualAuthority: true,
            urlIdentity: 'https://www.baidu.com/s?wd=dragon',
            viewportWidth: 1280,
            viewportHeight: 720,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'capture-visible-tab-layout-viewport',
            scrollX: 0,
            scrollY: 0,
            targetTag: 'a',
            targetRole: 'link',
            targetText: '龙之信条2 百度百科',
            targetStateChanged: false,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击龙之信条2百度百科搜索结果',
      targetHint: '龙之信条2 百度百科搜索结果',
      frameId: 'browser-visual-current',
      candidateId: 'A2',
    }, exec)

    expect(result).toContain('candidate A2')
    expect((await store.load('visual-click')).steps).toHaveLength(1)
  })

  it('supports mark/right-click visual calibration without recording a Runbook step', async () => {
    for (const pointerAction of ['mark', 'right-click'] as const) {
      const calls: Array<{ tool: string; args: JsonObject }> = []
      const { store, tool, exec } = await setup(async (name, args) => {
        calls.push({ tool: name, args })
        if (name === 'browser_visual_click') {
          return {
            ok: true,
            text: 'diagnostic',
            value: {
              ok: true,
              xRatio: 0.58,
              yRatio: 0.52,
              requestedXRatio: 0.58,
              requestedYRatio: 0.52,
              pointerAction,
              visualAuthority: true,
              targetTag: 'button',
              targetRole: 'button',
              targetText: '发布',
            },
          }
        }
        throw new Error(`unexpected tool ${name}`)
      })

      const result = await tool.execute({
        inspectionId: 'visual-click',
        stepName: '校准发布按钮',
        targetHint: '蓝色发布按钮',
        frameId: 'browser-visual-current',
        xRatio: 0.58,
        yRatio: 0.52,
        pointerAction,
      }, exec)

      expect(result).toContain('legacy normalized frame coordinate xRatio=0.5800, yRatio=0.5200')
      if (pointerAction === 'mark') {
        expect(result).toMatch(/Visual preview token: browser-preview-/)
        expect(result).toContain('Do not recompute or restate coordinates')
      }
      expect(result).toMatch(/not written to the Runbook|never become replay steps/i)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        tool: 'browser_visual_click',
        args: { pointerAction, xRatio: 0.58, yRatio: 0.52, visualAuthority: true },
      })
      expect((await store.load('visual-click')).steps).toHaveLength(0)
    }
  })

  it('binds the real browser click to the exact point previously verified by mark preview', async () => {
    const calls: Array<{ tool: string; args: JsonObject }> = []
    const { store, tool, exec } = await setup(async (name, args) => {
      calls.push({ tool: name, args })
      if (name === 'browser_read_page') {
        return { ok: true, text: 'before', value: { ok: true, url: 'https://example.com/', text: 'before' } }
      }
      if (name === 'browser_snapshot') {
        return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://example.com/', elements: [] } }
      }
      if (name === 'browser_visual_click' && args.pointerAction === 'mark') {
        return {
          ok: true,
          text: 'marked',
          value: {
            ok: true,
            xRatio: 0.3725,
            yRatio: 0.4415,
            requestedXRatio: 0.37,
            requestedYRatio: 0.44,
            pointerAction: 'mark',
            targetTag: 'button',
            targetRole: 'button',
            targetText: '我的任务 ×',
          },
        }
      }
      if (name === 'browser_visual_click' && args.pointerAction === 'left-click') {
        expect(args).toMatchObject({
          frameId: 'browser-visual-current',
          xRatio: 0.3725,
          yRatio: 0.4415,
          targetHint: '我的任务右侧的 x 关闭按钮',
          visualAuthority: true,
        })
        expect(args).not.toHaveProperty('candidateId')
        return {
          ok: true,
          text: 'clicked exact preview point',
          value: {
            ok: true,
            xRatio: 0.3725,
            yRatio: 0.4415,
            requestedXRatio: 0.3725,
            requestedYRatio: 0.4415,
            selectorHint: 'top-frame::.facet-remove',
            urlIdentity: 'https://example.com/',
            viewportWidth: 1280,
            viewportHeight: 720,
            viewportScale: 1,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'capture-visible-tab-layout-viewport',
            scrollX: 0,
            scrollY: 0,
            targetTag: 'i',
            targetRole: 'button',
            targetText: '×',
            targetTitle: '关闭',
            targetAriaLabel: '关闭我的任务',
            targetClassName: 'o_facet_remove',
            bindingActionable: true,
            selectorReplaySafe: true,
            selectorQuality: 'strong',
            bindingSource: 'visual-hit-test-post-click-learning',
            visualAuthority: true,
            targetStateChanged: true,
            stateEvidence: 'clicked visual target detached/re-rendered',
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const marked = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '预览我的任务关闭按钮',
      targetHint: '我的任务右侧的 x 关闭按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.37,
      yRatio: 0.44,
      pointerAction: 'mark',
    }, exec)
    const previewId = marked.match(/Visual preview token: (browser-preview-[\w-]+)/)?.[1]
    expect(previewId).toBeTruthy()

    const clicked = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '关闭我的任务',
      targetHint: '我的任务右侧的 x 关闭按钮',
      previewId,
    }, exec)

    expect(clicked).toContain('browser_visual_click')
    expect((await store.load('visual-click')).steps).toHaveLength(1)
    const physical = calls.filter(call => call.tool === 'browser_visual_click')
    expect(physical).toHaveLength(2)
    expect(physical[1]?.args).toMatchObject({
      xRatio: 0.3725,
      yRatio: 0.4415,
      pointerAction: 'left-click',
    })
  })

  it('keeps every live patrol visual teaching click coordinate-authoritative even when the flag is omitted', async () => {
    let authority: unknown
    const { tool, exec } = await setup(async (name, args) => {
      if (name === 'browser_read_page') return { ok: true, text: 'before', value: { ok: true, url: 'https://www.bilibili.com/', text: 'before' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/', elements: [] } }
      if (name === 'browser_visual_click') {
        authority = args.visualAuthority
        return {
          ok: true,
          text: 'clicked',
          value: {
            ok: true,
            xRatio: 0.4, yRatio: 0.5,
            urlIdentity: 'https://www.bilibili.com/',
            viewportWidth: 1000, viewportHeight: 800,
            captureClientLeft: 0, captureClientTop: 0, captureWidth: 1000, captureHeight: 800,
            captureMode: 'cdp-css-visual-viewport',
            scrollX: 0, scrollY: 0,
            targetStateChanged: true,
            stateEvidence: 'changed',
            visualAuthority: true,
          },
        }
      }
      throw new Error(`unexpected tool ${name}`)
    })

    await tool.execute({
      inspectionId: 'visual-click',
      stepName: '打开视频',
      targetHint: '目标视频',
      expectedVisualText: '目标视频',
      frameId: 'browser-visual-current',
      xRatio: 0.4,
      yRatio: 0.5,
    }, exec)

    expect(authority).toBe(true)
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
    expect(result).toMatch(/no meaningful CURRENT target\/page\/DOM state change|post-click hit binding/i)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
    expect(outcomes.unverifiedPhysicalClicks(args)).toBe(1)
  })

  it('records a verified visual navigation even when no reusable DOM binding can be learned', async () => {
    let reads = 0
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') {
        reads += 1
        const before = reads === 1
        const url = before ? 'https://www.bilibili.com/' : 'https://www.bilibili.com/video/BV-vision'
        const title = before ? '哔哩哔哩首页' : '我们无法找到外星文明_哔哩哔哩_bilibili'
        const text = before ? '首页视频流' : '我们无法找到外星文明 视频详情'
        return { ok: true, text, value: { ok: true, url, title, text } }
      }
      if (name === 'browser_snapshot') {
        const url = reads <= 1 ? 'https://www.bilibili.com/' : 'https://www.bilibili.com/video/BV-vision'
        return { ok: true, text: 'snapshot', value: { ok: true, url, title: reads <= 1 ? '哔哩哔哩首页' : '我们无法找到外星文明_哔哩哔哩_bilibili', elements: [] } }
      }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'visual clicked',
        value: {
          ok: true,
          xRatio: 0.42, yRatio: 0.55,
          requestedXRatio: 0.42, requestedYRatio: 0.55,
          selectorReplaySafe: false,
          bindingActionable: false,
          bindingSource: 'visual-hit-test-post-click-learning',
          visualAuthority: true,
          urlIdentity: 'https://www.bilibili.com/',
          viewportWidth: 1280, viewportHeight: 720,
          captureClientLeft: 0, captureClientTop: 0, captureWidth: 1280, captureHeight: 720,
          captureMode: 'cdp-css-visual-viewport',
          scrollX: 0, scrollY: 0,
          targetTag: 'div',
          targetText: '',
          targetStateChanged: false,
        },
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '打开截图中选中的视频',
      targetHint: '截图中“我们无法找到外星文明”视频卡片',
      expectedVisualText: '我们无法找到外星文明',
      frameId: 'browser-visual-current',
      xRatio: 0.42,
      yRatio: 0.55,
    }, exec)

    expect(result).toContain('No trustworthy DOM binding was available')
    const saved = await store.load('visual-click')
    expect(saved.steps).toHaveLength(1)
    expect((saved.steps[0] as any).arguments.learnedLocatorText).toBeUndefined()
    expect((saved.steps[0] as any).arguments.selectorHint).toBeUndefined()
    expect((saved.steps[0] as any).arguments.xRatio).toBe(0.42)
  })

  it('refuses navigation/card visual clicks that do not carry exact screenshot text', async () => {
    const calls: string[] = []
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    })

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击视频进入详情页',
      targetHint: '视频卡片区域',
      frameId: 'browser-visual-current',
      xRatio: 0.3,
      yRatio: 0.35,
    }, exec)).rejects.toThrow(/require[s]? expectedVisualText.*CURRENT model-visible screenshot/i)
    expect(calls).toEqual([])
  })

  it('refuses a visual frame that was never attached to the model in the CURRENT turn', async () => {
    const calls: string[] = []
    const visualEvidence = createPatrolVisualEvidenceRegistry()
    const { tool, exec } = await setup(async (name) => {
      calls.push(name)
      throw new Error(`unexpected tool ${name}`)
    }, undefined, visualEvidence)

    await expect(tool.execute({
      inspectionId: 'visual-click',
      stepName: '给视频点赞',
      targetHint: '点赞按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.2,
      yRatio: 0.8,
    }, exec)).rejects.toThrow(/not backed by a model-visible.*CURRENT turn|visualFrameId.*actually attached/i)
    expect(calls).toEqual([])
  })

  it('does not record or auto-retry when a trusted physical click outcome is uncertain', async () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return { ok: true, text: 'video', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', text: 'video' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', elements: [] } }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'trusted click uncertain',
        value: {
          ok: true,
          xRatio: 0.2,
          yRatio: 0.8,
          physicalClickUncertain: true,
          stateEvidence: 'trusted native physical click outcome became uncertain; refusing synthetic duplicate',
        },
      }
      throw new Error(`unexpected tool ${name}`)
    }, outcomes)

    const args = {
      inspectionId: 'visual-click',
      stepName: '点击发布按钮',
      targetHint: '蓝色发布按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.2,
      yRatio: 0.8,
    }
    const result = await tool.execute(args, exec)
    expect(result).toMatch(/did NOT issue a synthetic duplicate/)
    expect(result).toMatch(/Observe the CURRENT page state/)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
    expect(outcomes.visualPhysicalClicks(args)).toBe(1)
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
    }, exec)).rejects.toThrow(/targetHint is required.*business-intent label.*post-click verification/i)
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
    }, exec)).rejects.toThrow(/no CURRENT model-visible browser visual frame.*Do not copy screenshot file names\/paths into frameId/i)
    expect(calls).toEqual([])
  })

  it('does not require the redundant mark-preview round trip before TEST MODE visual clicks', () => {
    expect(visualToolSource).toContain('pointerAction')
    expect(visualToolSource).toContain('Optional diagnostic token returned by pointerAction=mark')
    expect(visualToolSource).not.toContain('preview-bound for accuracy in TEST MODE')
    expect(visualToolSource).not.toContain('A naked visual left-click is never dispatched in TEST MODE')
  })

  it('makes focused Browser Pixel Action Map B# the primary small-target strategy', () => {
    expect(visualToolSource).toContain('Browser Pixel Grounding')
    expect(visualToolSource).toContain('pixelCandidateId=B#')
    expect(visualToolSource).toContain('B# geometry comes only from CURRENT screenshot pixels')
    expect(visualToolSource).toContain('Large obvious controls such as wide search/input boxes and large buttons may still use direct imageX/imageY')
    expect(visualToolSource).toContain('DOM A# candidateId are rejected before physical input')
    expect(visualToolSource).toContain('trusted Chrome debugger mouse input')
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

  it('rejects the whole bili-comments shell when the requested target is the comment input and no editor focus exists', async () => {
    const outcomes = createPatrolClickOutcomeTracker()
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return { ok: true, text: '评论 23', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', text: '评论 23' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-test', elements: [] } }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'clicked comments shell',
        value: {
          ok: true,
          selectorHint: 'top-frame::bili-comments',
          targetTag: 'bili-comments',
          targetText: '评论 23',
          targetFocusedEditable: false,
          targetStateChanged: false,
          urlIdentity: 'https://www.bilibili.com/video/BV-test',
          viewportWidth: 1425, viewportHeight: 709, scrollX: 0, scrollY: 1956,
        },
      }
      throw new Error(`unexpected tool ${name}`)
    }, outcomes)

    const args = {
      inspectionId: 'visual-click',
      stepName: '点击评论输入框',
      targetHint: '评论输入框',
      frameId: 'browser-visual-current',
      xRatio: 0.4,
      yRatio: 0.9,
    }
    const result = await tool.execute(args, exec)
    expect(result).toMatch(/NOT recorded/)
    expect(result).toMatch(/no meaningful CURRENT target\/page\/DOM state change|comment editor/i)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
    expect(outcomes.unverifiedPhysicalClicks(args)).toBe(1)
  })

  it('never accepts navigation to another video as success for a publish-comment visual click', async () => {
    let reads = 0
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') {
        reads += 1
        const url = reads === 1
          ? 'https://www.bilibili.com/video/BV-original'
          : 'https://www.bilibili.com/video/BV-recommended'
        return { ok: true, text: '评论页', value: { ok: true, url, text: '评论页' } }
      }
      if (name === 'browser_snapshot') {
        const url = reads <= 1
          ? 'https://www.bilibili.com/video/BV-original'
          : 'https://www.bilibili.com/video/BV-recommended'
        return { ok: true, text: 'snapshot', value: { ok: true, url, elements: [] } }
      }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'visual clicked publish-like control',
        value: {
          ok: true,
          selectorHint: 'top-frame::button.comment-publish',
          targetTag: 'button',
          targetRole: 'button',
          targetText: '发布',
          targetClassName: 'comment-publish',
          targetFocusedEditable: false,
          targetStateChanged: false,
          urlIdentity: 'https://www.bilibili.com/video/BV-original',
          viewportWidth: 1425, viewportHeight: 709, scrollX: 0, scrollY: 1956,
        },
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '发布大拇指评论',
      targetHint: '蓝色发布按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.75,
      yRatio: 0.62,
    }, exec)

    expect(result).toMatch(/NOT recorded/)
    expect(result).toMatch(/unexpected navigation for in-page control/)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
  })


  it('immediately rejects a publish click when the browser reports unexpected navigation', async () => {
    const { store, tool, exec } = await setup(async (name) => {
      if (name === 'browser_read_page') return { ok: true, text: '评论页', value: { ok: true, url: 'https://www.bilibili.com/video/BV-original', text: '评论页' } }
      if (name === 'browser_snapshot') return { ok: true, text: 'snapshot', value: { ok: true, url: 'https://www.bilibili.com/video/BV-original', elements: [] } }
      if (name === 'browser_visual_click') return {
        ok: true,
        text: 'wrong click',
        value: {
          ok: true,
          selectorHint: 'top-frame::a.recommended-video',
          targetTag: 'a',
          targetRole: 'link',
          targetText: '另一个视频',
          unexpectedNavigation: true,
          targetStateChanged: false,
          urlIdentity: 'https://www.bilibili.com/video/BV-original',
          viewportWidth: 1425, viewportHeight: 709, scrollX: 0, scrollY: 600,
        },
      }
      throw new Error(`unexpected tool ${name}`)
    })

    const result = await tool.execute({
      inspectionId: 'visual-click',
      stepName: '点击发布按钮发送评论',
      targetHint: '蓝色发布按钮',
      frameId: 'browser-visual-current',
      xRatio: 0.58,
      yRatio: 0.65,
    }, exec)
    expect(result).toMatch(/NOT recorded/)
    expect(result).toMatch(/unexpectedly navigated away/)
    expect((await store.load('visual-click')).steps).toHaveLength(0)
  })

})
