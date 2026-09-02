// @ts-nocheck
import { describe, expect, it } from 'vitest'
import {
  findExplicitImageCodeInputSelector,
  findVisualImageCodeCandidateSelectors,
  imageCodeConfidence,
  IMAGE_CODE_MIN_CONFIDENCE,
  normalizeImageCodeText,
  selectImageCodeCandidate,
} from '../browser-bridge-runtime/image-code.js'

describe('image-code OCR recovery', () => {
  it('finds an explicit captcha input even when the adjacent image has no captcha attributes', () => {
    expect(findExplicitImageCodeInputSelector({
      elements: [
        { selector: '#username', name: 'username', type: 'text' },
        { selector: '#password', name: 'password', type: 'password' },
        { selector: '#captcha', name: 'captcha', type: 'text' },
      ],
    })).toBe('#captcha')
  })

  it('prefers captcha-sized visual regions while excluding obvious branding noise', () => {
    expect(findVisualImageCodeCandidateSelectors({
      elements: [
        { selector: '#captcha', name: 'captcha', type: 'text' },
        { selector: '#brand-logo', tag: 'img', text: 'visual:img src=/static/logo.png 260x90' },
        { selector: '#random-image', tag: 'img', text: 'visual:img src=/random/image?id=123 155x40' },
        { selector: '#captcha-canvas', tag: 'canvas', text: 'visual:canvas 140x42' },
      ],
    }, '#captcha')).toEqual(['#captcha-canvas', '#random-image'])
  })

  it('prefers a spaced alphanumeric captcha line over ordinary page text', () => {
    const ocr = [
      '登录',
      'fangzheming',
      'J T M X E 8',
      '忘记密码?',
    ].join('\n')
    const known = '登录\nfangzheming\n忘记密码?'
    expect(selectImageCodeCandidate(ocr, known)).toBe('JTMXE8')
  })

  it('filters OCR lines that are already known page text', () => {
    expect(selectImageCodeCandidate('LOGIN\nAB12C\nPASSWORD', 'LOGIN PASSWORD')).toBe('AB12C')
  })

  it('keeps cropped OCR normalization compatible with compact image codes', () => {
    expect(normalizeImageCodeText(' A B 1 2 C ')).toBe('AB12C')
  })

  it('normalizes ddddocr confidence to the lockout-safe 0..1 policy', () => {
    expect(IMAGE_CODE_MIN_CONFIDENCE).toBe(0.8)
    expect(imageCodeConfidence({ confidence: 0.83 })).toBeCloseTo(0.83)
    expect(imageCodeConfidence({ confidence: 3 })).toBe(1)
    expect(imageCodeConfidence({ confidence: -1 })).toBe(0)
    expect(imageCodeConfidence({})).toBe(0)
  })
})
