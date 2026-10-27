import { describe, expect, it, vi } from 'vitest'
import { MAX_DT } from '../flight'
import { stepShipAudioFrame } from './useShipAudioFrame'
import type { ShipAudio, ShipAudioOutput } from './ship-audio'

const audioWith = (out: ShipAudioOutput | null, running = out?.context.state === 'running') =>
  ({ output: () => out, isRunning: () => running }) as unknown as ShipAudio

describe('stepShipAudioFrame (tides-a4j.1)', () => {
  it('skips the update until there is sound to drive', () => {
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith(null))
    expect(update).not.toHaveBeenCalled()
  })

  it('skips the update while the context is suspended', () => {
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith({ context: { state: 'suspended' }, bus: {} } as ShipAudioOutput))
    expect(update).not.toHaveBeenCalled()
  })

  it('skips the update in the fade before a suspend', () => {
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith({ context: { state: 'running' }, bus: {} } as ShipAudioOutput, false))
    expect(update).not.toHaveBeenCalled()
  })

  it('passes the output and the frame time, capped like the flight step', () => {
    const out = { context: { state: 'running' }, bus: {} } as ShipAudioOutput
    const update = vi.fn()
    stepShipAudioFrame(update, 0.016, audioWith(out))
    stepShipAudioFrame(update, 3, audioWith(out))
    expect(update).toHaveBeenNthCalledWith(1, out, 0.016)
    expect(update).toHaveBeenNthCalledWith(2, out, MAX_DT)
  })
})
