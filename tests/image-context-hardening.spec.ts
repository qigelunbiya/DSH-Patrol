import { describe, expect, it } from 'vitest'
import {
  countRetainedToolResultImages,
  offloadHistoricalToolResultImages,
} from '../src/image-context-hardening.ts'

function fakeSession() {
  const images = [
    { type: 'image', attachment: { attachmentId: 'old' }, offloaded: false },
    { type: 'image', attachment: { attachmentId: 'new' }, offloaded: false },
  ]
  const events = [
    {
      type: 'tool/result',
      data: {},
      message: {
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'old screenshot' }, images[0]] }],
      },
    },
    {
      type: 'tool/result',
      data: {},
      message: {
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'new screenshot' }, images[1]] }],
      },
    },
  ]
  const appendCalls: Array<{ type: string; data: any }> = []
  const session = {
    surface: { nodes: [0, 1] },
    eventAt(seq: number) {
      return events[seq]
    },
    deriveEventMessage(event: any) {
      return event.message
    },
    append(type: string, data: any) {
      appendCalls.push({ type, data })
      if (type !== 'image/offload') throw new Error(`unexpected append ${type}`)
      for (const target of data.targets as Array<{ seq: number; imageIndexes: number[] }>) {
        const event = events[target.seq]!
        let imageIndex = 0
        const visit = (blocks: any[]): void => {
          for (const block of blocks) {
            if (block?.type === 'image') {
              if (target.imageIndexes.includes(imageIndex)) block.offloaded = true
              imageIndex += 1
            } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
              visit(block.content)
            }
          }
        }
        visit(event.message.content)
      }
      return { seq: 99 }
    },
  }
  return { session, images, appendCalls }
}

describe('Patrol image context hardening', () => {
  it('offloads older tool-result image blocks instead of mistaking text pruning for image removal', () => {
    const { session, images, appendCalls } = fakeSession()
    expect(countRetainedToolResultImages(session)).toBe(2)

    const result = offloadHistoricalToolResultImages(session, 1)
    expect(result).toMatchObject({
      retainedBefore: 2,
      retainedAfter: 1,
      offloaded: 1,
      applied: true,
    })
    expect(appendCalls).toEqual([{
      type: 'image/offload',
      data: { targets: [{ seq: 0, imageIndexes: [0] }] },
    }])
    expect(images[0]?.offloaded).toBe(true)
    expect(images[1]?.offloaded).toBe(false)
  })

  it('can offload every previous image before a fresh CURRENT screenshot is attached', () => {
    const { session } = fakeSession()
    const result = offloadHistoricalToolResultImages(session, 0)
    expect(result.offloaded).toBe(2)
    expect(result.retainedAfter).toBe(0)
  })

  it('fails open when the Harness image/offload projection is unavailable', () => {
    const { session } = fakeSession()
    session.append = () => { throw new Error('unknown event type image/offload') }
    const result = offloadHistoricalToolResultImages(session, 1)
    expect(result.applied).toBe(false)
    expect(result.error).toMatch(/image\/offload/)
    expect(countRetainedToolResultImages(session)).toBe(2)
  })
})
