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

  it('repairs a broken Harness runtime only after a native dependency probe fails', () => {
    const dev = read('scripts/dev.ps1')

    expect(dev).toContain('function Test-HarnessRuntimeDependencies')
    expect(dev).toContain("['esbuild', () =>")
    expect(dev).toContain("['sharp', () =>")
    expect(dev).toContain("['koffi', () =>")
    expect(dev).toContain('pnpm install --force --frozen-lockfile')
    expect(dev).toContain('if (Test-HarnessRuntimeDependencies -HarnessRootPath $HarnessRootPath)')
    expect(dev).not.toContain('pnpm install --frozen-lockfile --prefer-offline')
    expect(dev.indexOf('Repair-HarnessRuntimeDependencies -HarnessRootPath $HarnessRoot')).toBeLessThan(dev.indexOf('& (Join-Path $PSScriptRoot "install-local.ps1")'))
  })

  it('restores only missing rc2 profile resolver links after a guarded Harness repair', () => {
    const dev = read('scripts/dev.ps1')

    expect(dev).toContain('function Restore-Rc2ProfileDependencyMirrors')
    expect(dev).toContain('if ([string]$harnessManifest.version -ne "0.1.1-rc.2") { return }')
    expect(dev).toContain('if ($null -ne $existingTarget)')
    expect(dev).toContain('New-Item -ItemType $linkType -Path $target -Target $resolvedSource')
    expect(dev).toContain('if ([string]::IsNullOrWhiteSpace($name) -or $name -eq "dsh-patrol-client-host") { continue }')
    expect(dev.indexOf('Restore-Rc2ProfileDependencyMirrors -HarnessRootPath $HarnessRoot -ProfileName $Profile')).toBeGreaterThan(dev.indexOf('& (Join-Path $PSScriptRoot "install-local.ps1")'))
    expect(dev.indexOf('Restore-Rc2ProfileDependencyMirrors -HarnessRootPath $HarnessRoot -ProfileName $Profile')).toBeLessThan(dev.indexOf('Invoke-NativeChecked pnpm dsh web'))
  })
})
