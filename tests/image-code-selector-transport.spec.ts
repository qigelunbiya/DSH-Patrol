// @ts-nocheck
import { describe, expect, it, vi } from 'vitest'
import {
  imageCodeCaptureArgsForEngine,
  shouldRefreshImageCodeAfterAttempt,
} from '../browser-bridge-runtime/image-code.js'
import {
  canonicalImageCodeSelector,
  imageCodeSelectorsEquivalent,
} from '../browser-bridge-runtime/image-code-selector.js'
import { captureCurrentImageCodeVisual } from '../browser-bridge-runtime/image-code-visual-tool.js'

describe('image-code selector and capture transport', () => {
  it('treats top-frame selectors as the same DOM target as plain CSS', () => {
    expect(canonicalImageCodeSelector('top-frame::#captcha')).toBe('#captcha')
    expect(canonicalImageCodeSelector('#captcha')).toBe('#captcha')
    expect(imageCodeSelectorsEquivalent('top-frame::#captcha', '#captcha')).toBe(true)
    expect(imageCodeSelectorsEquivalent('top-frame::#captcha', '#other')).toBe(false)
  })

  it('normalizes snapshot selectors before either local OCR engine asks for CAPTCHA pixels', () => {
    expect(imageCodeCaptureArgsForEngine('windows', {
      tabId: 9,
      inputSelector: 'top-frame::#captcha',
      imageSelector: 'top-frame::div:nth-of-type(2) > img',
    })).toEqual({
      tabId: 9,
      inputSelector: '#captcha',
      imageSelector: 'div:nth-of-type(2) > img',
      visualScale: 2,
    })

    expect(imageCodeCaptureArgsForEngine('ddddocr', {
      tabId: 9,
      inputSelector: 'top-frame::#captcha',
      imageSelector: 'top-frame::div:nth-of-type(2) > img',
    })).toEqual({
      tabId: 9,
      inputSelector: '#captcha',
      imageSelector: 'div:nth-of-type(2) > img',
    })
  })

  it('does not let model vision crop the CAPTCHA input as if it were the CAPTCHA image', async () => {
    const request = vi.fn(async (_cmd, args) => ({
      ok: true,
      dataUrl: 'data:image/png;base64,AA==',
      captureMode: 'element-crop-visual-3x',
      inputSelector: args.inputSelector,
      imageSelector: args.imageSelector || 'div:nth-of-type(2) > img',
    }))

    const result = await captureCurrentImageCodeVisual(
      { request },
      {
        tabId: 5,
        inputSelector: 'top-frame::#captcha',
        imageSelector: '#captcha',
      },
      { signal: undefined },
      1000,
    )

    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe('captureImageCode')
    expect(request.mock.calls[0][1]).toEqual({
      tabId: 5,
      inputSelector: '#captcha',
      visualScale: 3,
    })
    expect(result.captured.imageSelector).toBe('div:nth-of-type(2) > img')
  })

  it('normalizes a real top-frame image selector for model vision', async () => {
    const request = vi.fn(async (_cmd, args) => ({
      ok: true,
      dataUrl: 'data:image/png;base64,AA==',
      captureMode: 'element-crop-visual-3x',
      inputSelector: args.inputSelector,
      imageSelector: args.imageSelector,
    }))

    await captureCurrentImageCodeVisual(
      { request },
      {
        tabId: 6,
        inputSelector: 'top-frame::#captcha',
        imageSelector: 'top-frame::div:nth-of-type(2) > img',
      },
      { signal: undefined },
      1000,
    )

    expect(request.mock.calls[0][1]).toEqual({
      tabId: 6,
      inputSelector: '#captcha',
      imageSelector: 'div:nth-of-type(2) > img',
      visualScale: 3,
    })
  })

  it('refreshes only after CAPTCHA pixels actually reached an OCR engine', () => {
    expect(shouldRefreshImageCodeAfterAttempt({ recognitionAttempted: true })).toBe(true)
    expect(shouldRefreshImageCodeAfterAttempt({ recognitionAttempted: false })).toBe(false)
    expect(shouldRefreshImageCodeAfterAttempt(undefined)).toBe(false)
  })
})
