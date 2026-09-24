import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('browser visual V# binding and startup regression', () => {
  it('keeps the browser Action Map identity bound until trusted physical input', () => {
    const publicVisual = read('src/visual-click-tools.ts')
    const bridgeTools = read('browser-bridge-runtime/tools.js')
    const extension = read('browser-extension/interaction-hardening.js')

    expect(publicVisual).toContain('visualActionMapId: actionMapOwnedPoint ? boundPreview?.actionMapId : undefined')
    expect(publicVisual).toContain('visualCandidateId: actionMapOwnedPoint ? boundPreview?.visualCandidateId : undefined')
    expect(publicVisual).toContain('xRatio: actionMapOwnedPoint ? undefined')
    expect(bridgeTools).toContain('visualActionMapId: optStr, visualCandidateId: optStr')
    expect(bridgeTools).toContain('visualActionMapId: args.visualActionMapId, visualCandidateId: args.visualCandidateId')
    expect(extension).toContain("const requestedVisualActionMapId = typeof args.visualActionMapId === 'string'")
    expect(extension).toContain("const requestedVisualCandidateId = typeof args.visualCandidateId === 'string'")
    expect(extension).toContain('const resolvedVisualCandidate = await interactionBrowserResolveVisualCandidate({')
    expect(extension).toContain("coordinateSource = 'browser-visual-action-map-candidate'")
    expect(extension).toContain("'bound-browser-visual-action-map-candidate'")
  })

  it('maps new captureVisibleTab frames through the visual viewport while preserving legacy replay geometry', () => {
    const extension = read('browser-extension/interaction-hardening.js')

    expect(extension).toContain("captureMode: 'capture-visible-tab-visual-viewport'")
    expect(extension).toContain('captureClientLeft: visualLeft')
    expect(extension).toContain('captureClientTop: visualTop')
    expect(extension).toContain("if (recordedMode === 'capture-visible-tab-layout-viewport')")
    expect(extension).toContain("captureMode: 'capture-visible-tab-layout-viewport'")
    expect(extension).toContain("if (recordedMode === 'capture-visible-tab-visual-viewport')")
  })

  it('repairs the Harness pnpm closure before pnpm dsh web can hit an ESM module-not-found failure', () => {
    const dev = read('scripts/dev.ps1')

    expect(dev).toContain('pnpm install --frozen-lockfile --prefer-offline')
    expect(dev).toContain("import('tsx')")
    expect(dev).toContain('Invoke-NativeChecked -FilePath node -Arguments @("-e",')
    expect(dev).not.toContain('Invoke-NativeChecked node -e ')
    expect(dev.indexOf('pnpm install --frozen-lockfile --prefer-offline')).toBeLessThan(dev.indexOf('Invoke-NativeChecked pnpm dsh web'))
  })
})
