import { describe, expect, it, vi } from 'vitest'
import { createShipAudio, playShipCue, type ShipAudioOutput } from './ship-audio'
import { IMPACT_NOISE_SECONDS, SHIP_CUE_SOUNDS } from './cue-sounds'
import type { ShipCueKind } from './ship-cues'

type Param = {
  value: number
  events: [string, number, number][]
  [method: string]: unknown
}

// Just enough of an AudioContext for the cues: params log their automation.
class FakeAudioContext {
  state: AudioContextState = 'running'
  currentTime = 3
  sampleRate = 8000
  destination = { name: 'destination' }
  nodes: Record<string, unknown>[] = []
  oscillators = 0
  buffers = 0
  addEventListener() {}
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  suspend() {
    this.state = 'suspended'
    return Promise.resolve()
  }
  param(): Param {
    const events: Param['events'] = []
    const log = (name: string) => (value: number, time: number) => void events.push([name, value, time])
    return {
      value: 0,
      events,
      setValueAtTime: log('set'),
      linearRampToValueAtTime: log('linear'),
      exponentialRampToValueAtTime: log('exponential'),
      setTargetAtTime: log('target'),
      cancelScheduledValues: vi.fn(),
    }
  }
  node(fields: object) {
    const node = { connect: vi.fn(), disconnect: vi.fn(), ...fields }
    this.nodes.push(node)
    return node
  }
  createGain() {
    return this.node({ gain: this.param() })
  }
  createBiquadFilter() {
    return this.node({ type: 'lowpass', frequency: this.param(), Q: this.param() })
  }
  createOscillator() {
    this.oscillators++
    return this.node({ type: 'sine', frequency: this.param(), detune: this.param(), start: vi.fn(), stop: vi.fn(), onended: null })
  }
  createBufferSource() {
    return this.node({ buffer: null, start: vi.fn(), stop: vi.fn(), onended: null })
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    this.buffers++
    const data = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => data }
  }
}

function running() {
  let context: FakeAudioContext | null = null
  const audio = createShipAudio({
    createContext: () => (context = new FakeAudioContext()) as unknown as AudioContext,
    storage: null,
    hasActivation: () => true,
  })
  audio.activate()
  audio.gesture()
  return { audio, context: context! }
}

const KINDS: ShipCueKind[] = ['impact', 'klaxon', 'lock', 'assistOn', 'assistOff']

// The pitches an oscillator steps through.
const notes = (out: ShipAudioOutput, kind: ShipCueKind) => {
  const cue = SHIP_CUE_SOUNDS[kind](out, 3)
  return (cue.end as unknown as { frequency: Param }).frequency.events.filter(([name]) => name === 'set').map(([, hz]) => hz)
}

describe('ship cue sounds (tides-a4j.3)', () => {
  it.each(KINDS)('%s is short, ends on its source, and plays into the bus', (kind) => {
    const { audio, context } = running()
    const out = audio.output()!
    const cue = SHIP_CUE_SOUNDS[kind](out, 3)
    const stop = cue.end.stop as unknown as ReturnType<typeof vi.fn>
    const at = stop.mock.calls[0][0] as number
    expect(at).toBeGreaterThan(3)
    expect(at).toBeLessThan(4)
    const intoBus = cue.nodes.filter((node) =>
      (node.connect as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([target]) => target === out.bus)
    )
    expect(intoBus.length).toBeGreaterThan(0)
    // Nothing touches the destination but the master gain.
    for (const node of context.nodes.slice(1)) {
      const connect = node.connect as ReturnType<typeof vi.fn>
      expect(connect.mock.calls.some(([target]) => target === context.destination)).toBe(false)
    }
  })

  it('tells the blips apart: lock on one note, assist up for on and down for off', () => {
    const out = running().audio.output()!
    const lock = notes(out, 'lock')
    expect(new Set(lock).size).toBe(1)
    const on = notes(out, 'assistOn')
    const off = notes(out, 'assistOff')
    expect(on[1]).toBeGreaterThan(on[0])
    expect(off[1]).toBeLessThan(off[0])
  })

  it('plays the impact’s crunch from the shared noise, a slice of it each time', () => {
    const { audio, context } = running()
    const out = audio.output()!
    SHIP_CUE_SOUNDS.impact(out, 3)
    SHIP_CUE_SOUNDS.impact(out, 3)
    // The voices' brown and white, made once.
    expect(context.buffers).toBe(2)
    const sources = context.nodes.filter((node) => 'buffer' in node)
    expect(sources).toHaveLength(2)
    for (const source of sources) {
      const [at, offset, duration] = (source.start as ReturnType<typeof vi.fn>).mock.calls[0] as number[]
      expect(at).toBe(3)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset + duration).toBeLessThanOrEqual(2)
      expect(duration).toBe(IMPACT_NOISE_SECONDS)
    }
  })

  it('makes nothing while muted, and frees a played cue when it ends', () => {
    const { audio, context } = running()
    audio.setMuted(true)
    expect(playShipCue(SHIP_CUE_SOUNDS.lock, audio)).toBe(false)
    expect(context.oscillators).toBe(0)
    audio.setMuted(false)
    expect(playShipCue(SHIP_CUE_SOUNDS.impact, audio)).toBe(true)
    const made = context.nodes.slice(1)
    const end = made.find((node) => 'detune' in node) as { onended: () => void }
    end.onended()
    for (const node of made) expect(node.disconnect).toHaveBeenCalled()
  })
})
