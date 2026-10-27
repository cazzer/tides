import { describe, expect, it, vi } from 'vitest'
import { MAX_DT } from '../flight'
import { stepShipAudioFrame } from './useShipAudioFrame'
import type { ShipAudio, ShipAudioOutput } from './ship-audio'

const audioWith = (out: ShipAudioOutput | null) => ({ output: () => out }) as unknown as ShipAudio

describe('stepShipAudioFrame (tides-a4j.1)', () => {
  it('skips the update until there is sound to drive', () => {
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith(null))
    expect(update).not.toHaveBeenCalled()
  })

  it('passes the output and the frame time, capped like the flight step', () => {
    const out = { context: {}, bus: {} } as ShipAudioOutput
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith(out))
    stepShipAudioFrame(update, 3, audioWith(out))
    expect(update).toHaveBeenNthCalledWith(1, out, 0.016)
    expect(update).toHaveBeenNthCalledWith(2, out, MAX_DT)
  })
})
