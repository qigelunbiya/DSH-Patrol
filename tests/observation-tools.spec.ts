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
  it('treats a successful screenshot as a valid observation when read_image is unavailable', async () => {
    const harness = setupObservationHarness({ readImage: 'missing', captcha: true })
    const value = await harness.tool.execute({ inspectionId: 'demo' }, harness.exec)

    expect(value.observationKind).toBe('visual')
    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('tool-unavailable')
    expect(value.ocrTextWithheld).toBe(true)
    expect(value.ocrText).toBeUndefined()
    expect(value.snapshotText).toContain('#captcha')
    expect(value.snapshotText).not.toContain('GLTK')
    expect(harness.observed).toEqual([{ inspectionId: 'demo', rootCallId: 'observe-call' }])
  })

  it('continues with fresh OCR/DOM evidence when the current model route rejects image input', async () => {
    const harness = setupObservationHarness({ readImage: 'failed', captcha: false })
    const value = await harness.tool.execute({ inspectionId: 'demo' }, harness.exec)

    expect(value.observationKind).toBe('visual')
    expect(value.evidenceMode).toBe('screenshot-ocr-snapshot')
    expect(value.imageStatus).toBe('read-failed')
    expect(value.imageError).toMatch(/does not declare image input/i)
    expect(value.ocrTextWithheld).toBe(false)
    expect(value.ocrText).toContain('LOGIN')
    expect(harness.observed).toHaveLength(1)
  })

  it('keeps the attached-image path when read_image is available and the route accepts images', async () => {
    const harness = setupObservationHarness({ readImage: 'success', captcha: false })
    const value = await harness.tool.execute({ inspectionId: 'demo' }, harness.exec)

    expect(value.evidenceMode).toBe('image')
    expect(value.imageStatus).toBe('attached')
    expect(value.image).toMatchObject({ attachmentId: 'img-1', mediaType: 'image/png' })
    expect(harness.observed).toHaveLength(1)
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
})

function setupObservationHarness(options: {
  readImage: 'missing' | 'failed' | 'success'
  captcha: boolean
}) {
  const definitions: any[] = []
  const observed: Array<{ inspectionId: string; rootCallId: unknown }> = []

  const ctx = {
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
        if (options.readImage === 'success') {
          return {
            isError: false,
            value: {
              image: {
                attachmentId: 'img-1',
                mediaType: 'image/png',
                bytes: 123,
                width: 100,
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

  const runner = {
    async dispatch(tool: string) {
      if (tool === 'browser_screenshot') {
        return {
          ok: true,
          text: 'Screenshot saved',
          value: {
            ok: true,
            path: 'C:\\workspace\\current.png',
            ocrStatus: 'recognized',
            ocrText: options.captcha ? 'LOGIN\nGLTK\n验证码' : 'LOGIN\nUsername\nPassword',
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

  registerPatrolObservationTools(ctx, runner, gate)
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

  return { tool, exec, observed }
}
