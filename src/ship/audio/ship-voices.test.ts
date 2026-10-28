import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShipTelemetry } from '../ship-telemetry'
import type { ShipInput } from '../ship-input'
import { createShipAudio, type ShipAudio } from './ship-audio'
import { stepShipAudioFrame } from './useShipAudioFrame'
import { buildShipVoices, stepShipVoices, teardownShipVoices, type ShipVoices } from './ship-voices'
import { engineDrive, engineParams, windLevel, windParams } from './engine-mix'

type Param = {
  value: number
  /** Every value scheduled, by either method, in order. */
  targets: number[]
  setTargetAtTime: ReturnType<typeof vi.fn>
  setValueAtTime: ReturnType<typeof vi.fn>
  cancelScheduledValues: ReturnType<typeof vi.fn>
}
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
    const targets: number[] = []
    const record = (value: number) => void targets.push(value)
    const param = { value: 0, targets, setTargetAtTime: vi.fn(record), setValueAtTime: vi.fn(record), cancelScheduledValues: vi.fn() }
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
    this.buffers++
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
  // The wall clock runs on whether or not the frame reaches the voices.
  let wallMs = 0
  // As ShipSound's frame.
  const frame = (dt = 1 / 60) => {
    wallMs += dt * 1000
    stepShipAudioFrame((out, step) => (voices = stepShipVoices(voices, out, telemetry, pilot, step, wallMs)), dt, audio)
  }
  const scheduled = () => contexts.reduce((n, c) => n + c.params.reduce((m, p) => m + p.targets.length, 0), 0)
  return { audio, contexts, telemetry, pilot, frame, voices: () => voices!, scheduled }
}

const fake = (param: AudioParam) => param as unknown as Param
const lastTarget = (param: AudioParam) => fake(param).targets[fake(param).targets.length - 1]

describe('ship voices (tides-a4j.2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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
    for (let i = 0; i < 120; i++) frame()
    expect(lastTarget(voices().thrustGain.gain)).toBe(0)
  })

  it('opens at the ship’s pitch and bands, fading in only the levels', () => {
    const { audio, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    telemetry.throttle = 0.8
    telemetry.speed = 6
    telemetry.air.dynamicPressure = 20_000
    frame()
    const v = voices()
    const hz = engineParams(engineDrive(0.8, 6, 10), { hz: 0, gain: 0, cutoff: 0, noiseGain: 0 }).hz
    for (const saw of v.saws) {
      expect(fake(saw.frequency).setValueAtTime).toHaveBeenCalledWith(hz, expect.any(Number))
      expect(fake(saw.frequency).setTargetAtTime).not.toHaveBeenCalled()
    }
    const windHz = windParams(windLevel(20_000), { gain: 0, hz: 0 }).hz
    expect(fake(v.windFilter.frequency).setValueAtTime).toHaveBeenCalledWith(windHz, expect.any(Number))
    expect(fake(v.windFilter.frequency).setTargetAtTime).not.toHaveBeenCalled()
    expect(fake(v.windGain.gain).setTargetAtTime).toHaveBeenCalled()
    expect(fake(v.oscGain.gain).setValueAtTime).not.toHaveBeenCalled()
  })

  it('forgets a throttle moved while the sound was suspended', () => {
    const { audio, contexts, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    contexts[0].state = 'suspended'
    telemetry.throttle = 1
    for (let i = 0; i < 30; i++) frame()
    contexts[0].state = 'running'
    frame()
    expect(lastTarget(voices().thrustGain.gain)).toBe(0)
  })

  it('lets a voice reach exactly 0 from a level too small to step', () => {
    const { audio, telemetry, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    telemetry.boosted = true
    telemetry.boost = 1
    frame()
    telemetry.boost = 1e-5
    frame()
    expect(lastTarget(voices().boostGain.gain)).toBeGreaterThan(0)
    telemetry.boost = 0
    frame()
    expect(lastTarget(voices().boostGain.gain)).toBe(0)
  })

  it('makes the noise once per context', () => {
    const { audio, contexts } = setup()
    audio.activate()
    audio.gesture()
    const out = audio.output()!
    buildShipVoices(out)
    buildShipVoices(out)
    expect(contexts[0].buffers).toBe(2)
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
    vi.useFakeTimers()
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
    for (const node of v.nodes) expect(node.disconnect).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    for (const node of v.nodes) expect(node.disconnect).toHaveBeenCalledTimes(1)
  })

  it('takes the graph down even if the stop never lands', () => {
    vi.useFakeTimers()
    const { audio, frame, voices } = setup()
    audio.activate()
    audio.gesture()
    frame()
    const v = voices()
    teardownShipVoices(v)
    vi.advanceTimersByTime(400)
    for (const node of v.nodes) expect(node.disconnect).toHaveBeenCalledTimes(1)
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
