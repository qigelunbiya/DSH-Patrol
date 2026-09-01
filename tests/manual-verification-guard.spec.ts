import { describe, expect, it } from 'vitest'
import { createManualVerificationGuard } from '../src/manual-verification-guard.js'

describe('Patrol manual verification guard', () => {
  it('always blocks ordinary image-code checkpoints, even after an automatic attempt', () => {
    const guard = createManualVerificationGuard()
    expect(guard({
      name: 'patrol_add_checkpoint',
      arguments: {
        inspectionId: 'demo',
        stepName: 'captcha checkpoint',
        reason: 'other',
        prompt: '请手动填写图片验证码',
      },
    })).toMatch(/禁止人工 checkpoint/)

    expect(guard({
      name: 'patrol_detect_auth_challenge',
      arguments: { inspectionId: 'demo', stepName: 'detect verification' },
    })).toBeUndefined()

    expect(guard({
      name: 'patrol_add_checkpoint',
      arguments: {
        inspectionId: 'demo',
        stepName: 'captcha checkpoint',
        reason: 'other',
        prompt: 'OCR 自动识别失败后请手动填写图片验证码',
      },
    })).toMatch(/直接失败/)
  })

  it('blocks model-visible input tools from copying a screenshot captcha into #captcha', () => {
    const guard = createManualVerificationGuard()
    for (const name of ['patrol_type_transient', 'patrol_type_text', 'patrol_type_credential', 'patrol_reteach_transient']) {
      expect(guard({
        name,
        arguments: {
          inspectionId: 'demo',
          stepName: '填写图片验证码',
          selector: '#captcha',
          text: 'SHOULD-NOT-BE-INSPECTED',
        },
      })).toMatch(/禁止通过通用输入工具手工填写/)
    }
  })

  it('blocks model-driven captcha refresh clicks after automatic recognition failure', () => {
    const guard = createManualVerificationGuard()
    expect(guard({
      name: 'patrol_click',
      arguments: { inspectionId: 'demo', stepName: '刷新验证码图片', selector: '#captcha-image' },
    })).toMatch(/禁止模型.*刷新验证码/)
  })

  it('allows genuinely human-only OTP and device-approval checkpoints immediately', () => {
    const guard = createManualVerificationGuard()
    expect(guard({
      name: 'patrol_add_checkpoint',
      arguments: { inspectionId: 'otp', stepName: 'otp', reason: 'otp', prompt: '请输入手机动态码' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_add_checkpoint',
      arguments: { inspectionId: 'approval', stepName: 'approve', reason: 'approval', prompt: '请在设备上确认登录' },
    })).toBeUndefined()
  })

  it('does not confuse a true OTP field with an ordinary image-code input', () => {
    const guard = createManualVerificationGuard()
    expect(guard({
      name: 'patrol_type_transient',
      arguments: { inspectionId: 'otp', stepName: '填写 OTP 动态码', selector: '#captcha', text: '123456' },
    })).toBeUndefined()
  })
})
