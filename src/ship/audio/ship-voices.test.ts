import { describe, expect, it, vi } from 'vitest'
import { createShipTelemetry } from '../ship-telemetry'
import type { ShipInput } from '../ship-input'
import { createShipAudio, type ShipAudio } from './ship-audio'
import { stepShipAudioFrame } from './useShipAudioFrame'
import { stepShipVoices, teardownShipVoices, type ShipVoices } from './ship-voices'

type Param = { value: number; setTargetAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> }
type Node = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; [key: string]: unknown }

// Just enough of an AudioContext for the voices: every node and param it
// makes is recorded.
class FakeAudioContext {
  state: AudioContextState = 'running'
  currentTime = 1
  sampleRate = 8000
  destination = {}
  nodes: Node[] = []
  params: Param[] = []
  oscillators = 0
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
    const param = { value: 0, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn() }
    this.params.push(param)
    return param
  }
  node(fields: object): Node {
    const node = { connect: vi.fn(), disconnect: vi.fn(), ...fields }
    this.nodes.push(node)
    return node
  }
  source(fields: object): Node {
    return this.node({ start: vi.fn(), stop: vi.fn(), onended: null, ...fields })
  }
  createGain() {
    return this.node({ gain: this.param() })
  }
  createBiquadFilter() {
    return this.node({ type: 'lowpass', frequency: this.param(), Q: this.param() })
  }
  createOscillator() {
    this.oscillators++
    return this.source({ type: 'sine', frequency: this.param(), detune: this.param() })
  }
  createBufferSource() {
    return this.source({ buffer: null, loop: false })
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length)
    return { getChannelData: () => data }
  }
}

const input = (): ShipInput => ({
  throttle: 0,
  strafeX: 0,
  strafeY: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  level: false,
  flightAssist: true,
  boost: false,
})

function setup() {
  const contexts: FakeAudioContext[] = []
  const audio: ShipAudio = createShipAudio({
    createContext: () => {
      const context = new FakeAudioContext()
      contexts.push(context)
      return context as unknown as AudioContext
    },
    storage: null,
    hasActivation: () => true,
  })
  const telemetry = createShipTelemetry()
  telemetry.speedCap = 10
  const pilot = input()
  let voices: ShipVoices | null = null
  // As ShipSound's frame.
  const frame = (dt = 1 / 60) =>
    stepShipAudioFrame((out, step) => (voices = stepShipVoices(voices, out, telemetry, pilot, step)), dt, audio)
  const scheduled = () =>
    contexts.reduce((n, c) => n + c.params.reduce((m, p) => m + p.setTargetAtTime.mock.calls.length, 0), 0)
  return { audio, contexts, telemetry, pilot, frame, voices: () => voices!, scheduled }
}

const lastTarget = (param: AudioParam) => {
  const calls = (param.setTargetAtTime as unknown as Param['setTargetAtTime']).mock.calls
  return calls[calls.length - 1][0] as number
}

describe('ship voices (tides-a4j.2)', () => {
  it('makes nothing before the first gesture', () => {
    const { audio, contexts, frame } = setup()
    audio.activate()
    for (let i = 0; i < 5; i++) frame()
    expect(contexts).toHaveLength(0)
    audio.gesture()
    // Only the master gain (ship-audio.ts).
    expect(contexts[0].nodes).toHaveLength(1)
    frame()
    expect(contexts[0].oscillators).toBe(2)
  })

  it('builds the graph once and makes no nodes per frame', () => {
    const { audio, contexts, telemetry, pilot, frame } = setup()
    audio.activate()
    audio.gesture()
    frame()
    const built = contexts[0].nodes.length
    for (let i = 0; i < 100; i++) {
      telemetry.throttle = (i % 10) / 10
      telemetry.speed = i % 7
      telemetry.boost = (i % 5) / 5
      telemetry.air.dynamicPressure = i * 100
      pilot.strafeX = i % 2
      frame()
    }
    expect(contexts[0].nodes).toHaveLength(built)
    expect(contexts[0].oscillators).toBe(2)
  })

  it('raises the engine’s pitch and level with the throttle', () => {
    const { audio, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    const idleHz = lastTarget(voices().saws[0].frequency)
    const idleGain = lastTarget(voices().oscGain.gain)
    telemetry.throttle = 1
    frame()
    expect(lastTarget(voices().saws[0].frequency)).toBeGreaterThan(idleHz)
    expect(lastTarget(voices().saws[1].frequency)).toBeGreaterThan(idleHz)
    expect(lastTarget(voices().oscGain.gain)).toBeGreaterThan(idleGain)
  })

  it('blows wind in the air and none in space', () => {
    const { audio, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    expect(lastTarget(voices().windGain.gain)).toBe(0)
    telemetry.air.dynamicPressure = 20_000
    frame()
    expect(lastTarget(voices().windGain.gain)).toBeGreaterThan(0)
  })

  it('hisses for a throttle change, then settles', () => {
    const { audio, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    telemetry.throttle = 0.1
    frame()
    expect(lastTarget(voices().thrustGain.gain)).toBeGreaterThan(0)
    frame()
    expect(lastTarget(voices().thrustGain.gain)).toBe(0)
  })

  it('schedules nothing while the ship holds steady', () => {
    const { audio, telemetry, frame, scheduled } = setup()
    audio.activate()
    audio.gesture()
    telemetry.throttle = 0.6
    telemetry.speed = 4
    telemetry.air.dynamicPressure = 5000
    frame()
    frame()
    const before = scheduled()
    for (let i = 0; i < 10; i++) frame()
    expect(scheduled()).toBe(before)
  })

  it('skips frames while the context is suspended', () => {
    const { audio, contexts, telemetry, frame, scheduled } = setup()
    audio.activate()
    audio.gesture()
    frame()
    contexts[0].state = 'suspended'
    const before = scheduled()
    telemetry.throttle = 1
    frame()
    expect(scheduled()).toBe(before)
  })

  it('rebuilds on a new context, taking the old graph down', () => {
    const { audio, contexts, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    const old = voices()
    contexts[0].state = 'closed'
    audio.gesture()
    frame()
    expect(contexts).toHaveLength(2)
    expect(voices()).not.toBe(old)
    expect(voices().context).toBe(contexts[1])
    for (const node of old.nodes) expect(node.disconnect).toHaveBeenCalled()
    expect(contexts[1].oscillators).toBe(2)
  })

  it('fades out and stops the sources, then disconnects everything', () => {
    const { audio, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    const v = voices()
    teardownShipVoices(v)
    expect(lastTarget(v.mix.gain)).toBe(0)
    for (const source of v.sources) expect(source.stop).toHaveBeenCalledWith(expect.any(Number))
    for (const node of v.nodes) expect(node.disconnect).not.toHaveBeenCalled()
    v.sources[0].onended?.(new Event('ended'))
    for (const node of v.nodes) expect(node.disconnect).toHaveBeenCalled()
  })

  it('takes a silent graph down at once', () => {
    const { audio, contexts, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    contexts[0].state = 'suspended'
    teardownShipVoices(voices())
    for (const node of voices().nodes) expect(node.disconnect).toHaveBeenCalled()
    for (const source of voices().sources) expect(source.stop).toHaveBeenCalled()
  })
})
