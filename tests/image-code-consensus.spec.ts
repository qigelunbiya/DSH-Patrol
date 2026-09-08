// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { selectConsensusDdddocrCandidate } from '../browser-bridge-runtime/image-code-ddddocr.js'

describe('image-code ddddocr ensemble consensus', () => {
  it('prefers the strongly supported all-letter interpretation over a lone digit confusion', () => {
    const candidate = selectConsensusDdddocrCandidate({
      candidates: [
        { text: '44KQ', confidence: 0.91, support: 1 },
        { text: 'AAKQ', confidence: 0.84, support: 7 },
        { text: 'A4KQ', confidence: 0.86, support: 1 },
      ],
    })
    expect(candidate?.text).toBe('AAKQ')
  })

  it('does not force alphabetic output when numeric OCR consensus dominates', () => {
    const candidate = selectConsensusDdddocrCandidate({
      candidates: [
        { text: '7832', confidence: 0.86, support: 6 },
        { text: 'T832', confidence: 0.90, support: 1 },
        { text: '783Z', confidence: 0.84, support: 1 },
      ],
    })
    expect(candidate?.text).toBe('7832')
  })

  it('uses the ensemble dominant length instead of a high-confidence stray extra glyph', () => {
    const candidate = selectConsensusDdddocrCandidate({
      candidates: [
        { text: 'TCUFZ', confidence: 0.92, support: 1 },
        { text: 'TCUF', confidence: 0.85, support: 6 },
        { text: 'TCUE', confidence: 0.78, support: 2 },
      ],
    })
    expect(candidate?.text).toBe('TCUF')
  })
})
