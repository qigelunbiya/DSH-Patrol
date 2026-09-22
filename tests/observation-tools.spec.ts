import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  classifyBootstrapObservation,
  isBootstrapUnobservableUrl,
  registerPatrolObservationTools,
  snapshotContainsCaptchaInput,
  summarizeSnapshotEvidence,
} from '../src/observation-tools.js'
import type { PatrolObservationGate } from '../src/observation-guard.js'
import type { PatrolRunner } from '../src/runner.js'
import type { PatrolStore } from '../src/store.js'

describe('bootstrap current-page observation', () => {
  it('recognizes an initial active tab whose URL is unavailable', () => {
    expect(classifyBootstrapObservation({
      tabs: [{ id: 7, active: true, title: '', url: '' }],
    })).toEqual({ kind: 'unobservable-tab' })
  })

  it('recognizes Chromium new-tab pages but not real application pages', () => {
    expect(isBootstrapUnobservableUrl('chrome://newtab/')).toBe(true)
    expect(isBootstrapUnobservableUrl('about:blank')).toBe(true)
    expect(isBootstrapUnobservableUrl('https://10.192.1.125/login')).toBe(false)
  })

  it('uses the requested tab instead of a different active page', () => {
    expect(classifyBootstrapObservation({
      tabs: [
        { id: 1, active: true, title: 'Real page', url: 'https://example.com' },
        { id: 2, active: false, title: '', url: '' },
      ],
    }, 2)).toEqual({ kind: 'unobservable-tab' })
  })

  it('marks an empty browser as a no-tab bootstrap state', () => {
    expect(classifyBootstrapObservation({ tabs: [] })).toEqual({ kind: 'no-tab' })
  })
})

describe('current-page observation evidence fallback', () => {
  it('uses compact OCR/DOM evidence by default and does not attach an image', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false })
    const value = await harness.tool.execute({ inspectionId: 'demo' }, harness.exec)

    expect(value.observationKind).toBe('visual')
    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('not-requested')
    expect(value.image).toBeUndefined()
    expect(harness.readImageCalls).toBe(0)
    expect(harness.screenshotArgs[0]).toMatchObject({ format: 'png' })
    expect(harness.screenshotArgs[0]?.maxWidth).toBeUndefined()
    expect(value.ocrText).toContain('LOGIN')
    expect(value.path).toBe('C:\\workspace\\patrol-results\\demo\\teaching\\screenshots\\current.png')
    expect(harness.organized).toEqual([{
      inspectionId: 'demo',
      sourcePath: 'C:\\workspace\\current.png',
      workspaceRoot: 'C:\\workspace',
    }])
    expect(harness.observed).toHaveLength(1)
  })

  it('withholds whole-page OCR when the compact CURRENT DOM contains a CAPTCHA input', async () => {
    const harness = setupObservationHarness({ readImage: 'missing', captcha: true })
    const value = await harness.tool.execute({ inspectionId: 'demo' }, harness.exec)

    expect(value.observationKind).toBe('visual')
    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('not-requested')
    expect(value.ocrTextWithheld).toBe(true)
    expect(value.ocrText).toBeUndefined()
    expect(value.snapshotText).toContain('#captcha')
    expect(value.snapshotText).not.toContain('GLTK')
    expect(harness.observed).toEqual([{ inspectionId: 'demo', rootCallId: 'observe-call' }])
  })

  it('attaches the screenshot only when includeImage=true and the route accepts images', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false })
    const value = await harness.tool.execute({ inspectionId: 'demo', includeImage: true }, harness.exec)

    expect(value.evidenceMode).toBe('image')
    expect(value.imageStatus).toBe('attached')
    expect(value.image).toMatchObject({ attachmentId: 'img-1', mediaType: 'image/png', width: 100 })
    expect(value.visualClickReady).toBe(true)
    expect(value.visualFrameId).toBe('browser-visual-current')
    expect(harness.readImageCalls).toBe(1)
    expect(harness.screenshotArgs[0]).toMatchObject({ format: 'jpeg', maxWidth: 1024, quality: 68 })
    expect(harness.observed).toHaveLength(1)
  })

  it('requires and forwards a target hint for action-map observations', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false })
    await expect(harness.tool.execute({
      inspectionId: 'demo',
      includeImage: true,
      actionMap: true,
    }, harness.exec)).rejects.toThrow(/requires targetHint/i)

    const value = await harness.tool.execute({
      inspectionId: 'demo',
      includeImage: true,
      actionMap: true,
      targetHint: '10.192.3.174 行的 RDP',
    }, harness.exec)

    expect(harness.screenshotArgs.at(-1)).toMatchObject({
      actionMap: true,
      actionMapTargetHint: '10.192.3.174 行的 RDP',
    })
    expect(value.actionMapTargeted).toBe(true)
    expect(value.actionMapTargetHint).toBe('10.192.3.174 行的 RDP')
  })

  it('prunes historical Patrol payloads before every new visual attachment instead of imposing a screenshot-count cap', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false, prune: true })
    for (let index = 0; index < 4; index += 1) {
      const value = await harness.tool.execute({ inspectionId: 'demo', includeImage: true }, harness.exec)
      expect(value.imageStatus).toBe('attached')
    }
    expect(harness.pruneCalls).toBe(4)
    expect(harness.readImageCalls).toBe(4)
    expect(harness.screenshotArgs).toHaveLength(4)
  })

  it('trusts the actual read_image attachment dimensions even when older browser metadata omits targetPixelWidth', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false, omitRasterBudget: true })
    const value = await harness.tool.execute({ inspectionId: 'demo', includeImage: true }, harness.exec)

    expect(value.evidenceMode).toBe('image')
    expect(value.imageStatus).toBe('attached')
    expect(value.visualClickReady).toBe(true)
    expect(value.visualFrameId).toBe('browser-visual-current')
    expect(harness.readImageCalls).toBe(1)
  })

  it('refuses an actually oversized model attachment and withholds the visual frame', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false, imageWidth: 1600 })
    const value = await harness.tool.execute({ inspectionId: 'demo', includeImage: true }, harness.exec)

    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('read-failed')
    expect(value.imageError).toMatch(/1600px wide.*1024px Patrol budget/i)
    expect(value.visualClickReady).toBe(false)
    expect(value.visualFrameId).toBeUndefined()
    expect(value.image).toBeUndefined()
    expect(harness.readImageCalls).toBe(1)
  })

  it('falls back to compact evidence when explicit image attachment is unavailable', async () => {
    const harness = setupObservationHarness({ readImage: 'failed', captcha: false })
    const value = await harness.tool.execute({ inspectionId: 'demo', includeImage: true }, harness.exec)

    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('read-failed')
    expect(value.imageError).toMatch(/does not declare image input/i)
    expect(value.ocrTextWithheld).toBe(false)
    expect(value.ocrText).toContain('LOGIN')
  })

  it('detects CAPTCHA inputs and never copies their current value into snapshot evidence', () => {
    const snapshot = {
      elements: [
        { tag: 'input', selector: '#captcha', name: 'captcha', type: 'text', value: 'GLTK' },
        { tag: 'img', selector: '#captcha-image', text: 'visual:img 155x40' },
      ],
    }
    expect(snapshotContainsCaptchaInput(snapshot)).toBe(true)
    const evidence = summarizeSnapshotEvidence(snapshot)
    expect(evidence).toContain('#captcha')
    expect(evidence).toContain('#captcha-image')
    expect(evidence).not.toContain('GLTK')
  })

  it('bounds a large snapshot before it reaches model context', () => {
    const snapshot = {
      elements: Array.from({ length: 100 }, (_, index) => ({
        tag: 'a', selector: `#item-${index}`, text: `menu item ${index} ${'x'.repeat(180)}`,
      })),
      truncated: true,
    }
    const evidence = summarizeSnapshotEvidence(snapshot)
    expect(evidence.length).toBeLessThanOrEqual(3050)
    expect(evidence).not.toContain('#item-99')
  })
})

function setupObservationHarness(options: {
  readImage: 'missing' | 'failed' | 'success'
  captcha: boolean
  prune?: boolean
  omitRasterBudget?: boolean
  imageWidth?: number
}) {
  const definitions: any[] = []
  const observed: Array<{ inspectionId: string; rootCallId: unknown }> = []
  const organized: Array<{ inspectionId: string; sourcePath: string; workspaceRoot: string }> = []
  let readImageCalls = 0
  let pruneCalls = 0
  const screenshotArgs: any[] = []

  const ctx = {
    get(name: string) {
      if (name !== 'toolResultPruner' || options.prune !== true) return undefined
      return {
        pruneSession() {
          pruneCalls += 1
          return { pruned: [{ kind: 'old-image' }], charsRemoved: 1024 }
        },
      }
    },
    logger: { info() {}, warn() {} },
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
      get(name: string) {
        if (name !== 'read_image' || options.readImage === 'missing') return undefined
        return { name: 'read_image' }
      },
      async execute() {
        readImageCalls += 1
        if (options.readImage === 'success') {
          return {
            isError: false,
            value: {
              image: {
                attachmentId: 'img-1',
                mediaType: 'image/png',
                bytes: 123,
                width: options.imageWidth ?? 100,
                height: 50,
              },
            },
          }
        }
        return {
          isError: true,
          error: new Error('model "text-only" does not declare image input'),
        }
      },
    },
  } as unknown as Context

  const store = {
    async organizeTeachingScreenshot(inspectionId: string, sourcePath: string, workspaceRoot: string) {
      organized.push({ inspectionId, sourcePath, workspaceRoot })
      return `C:\\workspace\\patrol-results\\${inspectionId}\\teaching\\screenshots\\current.png`
    },
  } as unknown as PatrolStore

  const runner = {
    async dispatch(tool: string, args: any) {
      if (tool === 'browser_screenshot') {
        screenshotArgs.push(args)
        return {
          ok: true,
          text: 'Screenshot saved',
          value: {
            ok: true,
            path: 'C:\\workspace\\current.png',
            ocrStatus: 'recognized',
            ocrText: options.captcha ? 'LOGIN\nGLTK\n验证码' : `LOGIN\nUsername\nPassword\n${'status '.repeat(500)}`,
            visualFrameId: 'browser-visual-current',
            urlIdentity: 'https://example.com/login',
            viewportWidth: 1280,
            viewportHeight: 720,
            captureClientLeft: 0,
            captureClientTop: 0,
            captureWidth: 1280,
            captureHeight: 720,
            captureMode: 'cdp-css-visual-viewport',
            scrollX: 0,
            scrollY: 0,
            actionMap: args.actionMap === true,
            actionMapTargeted: args.actionMap === true && typeof args.actionMapTargetHint === 'string' && args.actionMapTargetHint.length > 0,
            ...(typeof args.actionMapTargetHint === 'string' ? { actionMapTargetHint: args.actionMapTargetHint } : {}),
            ...(args.actionMap === true ? { actionCandidateCount: 1 } : {}),
            ...(args.format === 'jpeg' && options.omitRasterBudget !== true ? { targetPixelWidth: 1024, compactVisual: true } : {}),
          },
        }
      }
      if (tool === 'browser_snapshot') {
        return {
          ok: true,
          text: 'Snapshot',
          value: {
            ok: true,
            url: 'https://example.com/login',
            title: 'Login',
            elements: options.captcha
              ? [
                  { tag: 'input', selector: '#username', name: 'username', type: 'text' },
                  { tag: 'input', selector: '#captcha', name: 'captcha', type: 'text', value: 'GLTK' },
                  { tag: 'img', selector: '#captcha-image', text: 'visual:img 155x40' },
                ]
              : [
                  { tag: 'input', selector: '#username', name: 'username', type: 'text' },
                  { tag: 'input', selector: '#password', name: 'password', type: 'password' },
                ],
            truncated: false,
          },
        }
      }
      throw new Error(`unexpected browser tool ${tool}`)
    },
  } as unknown as PatrolRunner

  const gate = {
    markObserved(inspectionId: string, rootCallId: unknown) {
      observed.push({ inspectionId, rootCallId })
    },
    markBootstrap() {},
    guard() { return undefined },
  } as unknown as PatrolObservationGate

  registerPatrolObservationTools(ctx, store, runner, gate)
  const tool = definitions.find(definition => definition.name === 'patrol_observe')
  if (!tool) throw new Error('patrol_observe was not registered')

  const exec = {
    token: Symbol('observe-test'),
    rootCallId: 'observe-call',
    signal: new AbortController().signal,
    agent: {
      session: {
        header: { id: 'session-demo', cwd: 'C:\\workspace' },
      },
    },
  } as unknown as ToolRunContext

  return {
    tool,
    exec,
    observed,
    organized,
    screenshotArgs,
    get readImageCalls() { return readImageCalls },
    get pruneCalls() { return pruneCalls },
  }
}
