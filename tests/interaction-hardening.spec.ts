import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
const source = readFileSync(join(process.cwd(), 'browser-extension', 'interaction-hardening.js'), 'utf8')

describe('browser interaction hardening layer', () => {
  it('loads after frame resilience so it can normalize every final snapshot/click path', () => {
    expect(entry.indexOf("importScripts('interaction-hardening.js')")).toBeGreaterThan(entry.indexOf("importScripts('frame-resilient.js')"))
  })

  it('makes top-document selectors explicit instead of searching identical CSS across iframes', () => {
    expect(source).toContain("const INTERACTION_TOP_FRAME_PREFIX = 'top-frame::'")
    expect(source).toContain('interactionNormalizeSnapshot')
    expect(source).toContain('`${INTERACTION_TOP_FRAME_PREFIX}${rawSelector}`')
  })

  it('promotes input submit values to semantic text and prefers MAIN-world actionability clicks', () => {
    expect(source).toContain("['button', 'submit', 'reset']")
    expect(source).toContain('inputActionText')
    expect(source).toContain("resilientDomFallback(clickTabId, 'click', args)")
    expect(source).toContain('interactionAdoptSingleOpenedTab(clickTabId, clickTabsBefore)')
  })

  it('never focuses the OS browser window for tab activation or screenshots', () => {
    expect(source).toContain("if (cmd === 'activateTab')")
    expect(source).toContain("if (cmd === 'screenshot')")
    expect(source).not.toMatch(/^\s*(?:await\s+)?chrome\.windows\.update\(/m)
    expect(source).toContain('captureVisibleTab(tab.windowId')
  })

  it('filters structured rows and gives close/remove Action Maps precise micro-control hit points', () => {
    expect(source).toContain('actionMapTargetHint')
    expect(source).toContain('structuredIdentities')
    expect(source).toContain('structuredActions')
    expect(source).toContain('candidateMatchesStructuredTarget')
    expect(source).toContain('rowContext')
    expect(source).toContain('localCandidateContext')
    expect(source).toContain('isMicroCloseAction')
    expect(source).toContain("microActionKind: microCloseAction ? 'close' : ''")
    expect(source).toContain("activationKind: microCloseAction")
    expect(source).toContain('closeBusinessCore')
    expect(source).toContain('preciseClose')
    expect(source).toContain('candidate.safeX')
    expect(source).toContain("rgba(0,255,110,0.96)")
    expect(source).toContain('interactionStructuredRowCandidateMismatch')
    expect(source).toContain('REFUSED before physical input')
  })

  it('renders a separate magnified Action Map candidate sheet with exact safe-point crosses', () => {
    expect(source).toContain('interactionRenderActionCandidateZoomSheetInWorker')
    expect(source).toContain('PATROL TARGET ZOOM')
    expect(source).toContain('choose A# only')
    expect(source).toContain('Green crosshair = exact safe point')
    expect(source).toContain('actionMapZoomDataUrl')
    expect(source).toContain('actionMapZoomCount')
    expect(source).toContain('candidates.length > 16')
  })

  it('binds candidateId clicks to the selected candidate fingerprint before trusted input', () => {
    expect(source).toContain("requestedCandidateId && typeof selectedCandidate?.tag === 'string'")
    expect(source).toContain("requestedCandidateId && typeof selectedCandidate?.role === 'string'")
    expect(source).toContain("requestedCandidateId && typeof selectedCandidate?.ariaLabel === 'string'")
    expect(source).toContain("requestedCandidateId && typeof selectedCandidate?.title === 'string'")
    expect(source).toContain('actionCandidateFingerprint')
    expect(source).toContain('selectedCandidate?.localContext')
  })

  it('preflights close/remove visual points before trusted input instead of blindly clicking a nearby search field', () => {
    expect(source).toContain('visual close/remove preflight rejected this point before physical input')
    expect(source).toContain('hasCloseEvidence')
    expect(source).toContain('hasBusinessContext')
    expect(source).toContain('Try the same fresh screenshot with the other visual strategy')
  })

  it('implements exact native select by value, label, or index with change events', () => {
    expect(source).toContain("if (cmd === 'select')")
    expect(source).toContain('HTMLSelectElement')
    expect(source).toContain("new Event('change', { bubbles: true })")
  })
})
