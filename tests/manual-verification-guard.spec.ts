import { describe, expect, it } from 'vitest'
import { createManualVerificationGuard } from '../src/manual-verification-guard.js'

describe('Patrol manual verification guard', () => {
  it('blocks an ordinary image-code checkpoint until the dedicated solver was attempted', () => {
    const guard = createManualVerificationGuard()
    expect(guard({
      name: 'patrol_add_checkpoint',
      arguments: {
        inspectionId: 'demo',
        stepName: 'captcha checkpoint',
        reason: 'other',
        prompt: '请手动填写图片验证码',
      },
    })).toMatch(/patrol_detect_auth_challenge/)

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
        prompt: 'OCR 尝试失败后请手动填写图片验证码',
      },
    })).toBeUndefined()
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
})
