// The ship's continuous voices (tides-a4j.2): one fixed Web Audio graph per
// AudioContext, built on the first running frame and eased every frame
// toward engine-mix.ts's targets. Each param only hears setTargetAtTime when
// its target has really moved, so a steady ship schedules nothing, and a
// frame allocates nothing.
//
//   2 detuned saws ─ oscGain ─┐
//   brown noise ─ noiseGain ──┴─ lowpass ─────────────┐
//   white noise ─ bandpass ─ thrustGain ──────────────┤
//   white noise ─ bandpass ─ boostGain ───────────────┼─ mix ─ out.bus
//   brown noise ─ bandpass ─ windGain ────────────────┘

import type { ShipInput } from '../ship-input'
import type { ShipTelemetry } from '../ship-telemetry'
import type { ShipAudioOutput } from './ship-audio'
import {
  BOOST_Q,
  BOOST_TAU,
  boostParams,
  ENGINE_DETUNE_CENTS,
  ENGINE_TAU,
  engineDrive,
  engineParams,
  THRUST_FALL_TAU,
  THRUST_GAIN,
  THRUST_HZ,
  THRUST_Q,
  THRUST_RISE_TAU,
  thrustLevel,
  VOICES_GAIN,
  WIND_Q,
  WIND_TAU,
  windLevel,
  windParams,
  type BoostParams,
  type EngineParams,
  type WindParams,
} from './engine-mix'

// Loop length of the noise buffers, seconds: long enough not to be heard
// repeating under the filters.
const NOISE_SECONDS = 2
// The brown noise's leak per sample: a low rumble that never drifts off.
const BROWN_LEAK = 0.98
// A target this close to the last one set is left alone.
const RELATIVE_STEP = 1e-4
const ABSOLUTE_STEP = 1e-5
// Leaving the ship: the mix fades over this, then the sources stop, seconds.
// Inside the master's own fade before its suspend (ship-audio.ts), so the
// stop lands while the context still runs.
const RELEASE_SECONDS = 0.06

// The params eased every frame, by slot in ShipVoices.last.
const SLOT = {
  engineHzA: 0,
  engineHzB: 1,
  engineGain: 2,
  engineCutoff: 3,
  engineNoise: 4,
  thrustGain: 5,
  boostGain: 6,
  boostHz: 7,
  windGain: 8,
  windHz: 9,
} as const
const SLOTS = 10

export interface ShipVoices {
  context: AudioContext
  mix: GainNode
  saws: [OscillatorNode, OscillatorNode]
  oscGain: GainNode
  noiseGain: GainNode
  lowpass: BiquadFilterNode
  thrustGain: GainNode
  boostBand: BiquadFilterNode
  boostGain: GainNode
  windBand: BiquadFilterNode
  windGain: GainNode
  sources: AudioScheduledSourceNode[]
  nodes: AudioNode[]
  /** The last target set per SLOT; NaN until the first. */
  last: Float64Array
  lastThrottle: number | null
  engine: EngineParams
  boost: BoostParams
  wind: WindParams
}

function noiseBuffer(context: AudioContext, brown: boolean): AudioBuffer {
  const length = Math.round(NOISE_SECONDS * context.sampleRate)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  let level = 0
  let peak = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    level = brown ? BROWN_LEAK * level + (1 - BROWN_LEAK) * white : white
    data[i] = level
  }
  if (brown) {
    // Tilt the ends together so the loop doesn't click at its seam, then
    // bring the peak to 1.
    const step = (data[length - 1] - data[0]) / (length - 1)
    for (let i = 0; i < length; i++) {
      data[i] -= step * i
      peak = Math.max(peak, Math.abs(data[i]))
    }
    if (peak > 0) for (let i = 0; i < length; i++) data[i] /= peak
  }
  return buffer
}

/** The voices' graph on `out`, all silent until the first update. */
export function buildShipVoices(out: ShipAudioOutput): ShipVoices {
  const { context } = out
  const nodes: AudioNode[] = []
  const sources: AudioScheduledSourceNode[] = []
  const gain = () => {
    const node = context.createGain()
    node.gain.value = 0
    nodes.push(node)
    return node
  }
  const filter = (type: BiquadFilterType, hz: number, q: number) => {
    const node = context.createBiquadFilter()
    node.type = type
    node.frequency.value = hz
    node.Q.value = q
    nodes.push(node)
    return node
  }
  const brown = noiseBuffer(context, true)
  const white = noiseBuffer(context, false)
  // Each noise voice starts at its own place in the loop, so two voices on
  // one buffer don't sound as one.
  const loop = (buffer: AudioBuffer, offset: number) => {
    const node = context.createBufferSource()
    node.buffer = buffer
    node.loop = true
    node.start(0, offset * NOISE_SECONDS)
    nodes.push(node)
    sources.push(node)
    return node
  }

  const mix = gain()
  mix.gain.value = VOICES_GAIN
  mix.connect(out.bus)

  const lowpass = filter('lowpass', 220, 0.7)
  lowpass.connect(mix)
  const oscGain = gain()
  oscGain.connect(lowpass)
  const saws = [-1, 1].map((sign) => {
    const node = context.createOscillator()
    node.type = 'sawtooth'
    node.detune.value = sign * ENGINE_DETUNE_CENTS
    node.connect(oscGain)
    node.start()
    nodes.push(node)
    sources.push(node)
    return node
  }) as [OscillatorNode, OscillatorNode]
  const noiseGain = gain()
  noiseGain.connect(lowpass)
  loop(brown, 0).connect(noiseGain)

  const thrustGain = gain()
  thrustGain.connect(mix)
  const thrustBand = filter('bandpass', THRUST_HZ, THRUST_Q)
  thrustBand.connect(thrustGain)
  loop(white, 0).connect(thrustBand)

  const boostGain = gain()
  boostGain.connect(mix)
  const boostBand = filter('bandpass', 180, BOOST_Q)
  boostBand.connect(boostGain)
  loop(white, 0.5).connect(boostBand)

  const windGain = gain()
  windGain.connect(mix)
  const windBand = filter('bandpass', 250, WIND_Q)
  windBand.connect(windGain)
  loop(brown, 0.5).connect(windBand)

  return {
    context,
    mix,
    saws,
    oscGain,
    noiseGain,
    lowpass,
    thrustGain,
    boostBand,
    boostGain,
    windBand,
    windGain,
    sources,
    nodes,
    last: new Float64Array(SLOTS).fill(NaN),
    lastThrottle: null,
    engine: { hz: 0, gain: 0, cutoff: 0, noiseGain: 0 },
    boost: { gain: 0, hz: 0 },
    wind: { gain: 0, hz: 0 },
  }
}

function ease(v: ShipVoices, slot: number, param: AudioParam, target: number, now: number, tau: number): void {
  const last = v.last[slot]
  if (Math.abs(target - last) <= Math.max(ABSOLUTE_STEP, RELATIVE_STEP * Math.abs(last))) return
  v.last[slot] = target
  param.setTargetAtTime(target, now, tau)
}

/** Eases the voices toward the ship's state this frame; `dt` in seconds. */
export function updateShipVoices(v: ShipVoices, telemetry: ShipTelemetry, input: ShipInput, dt: number): void {
  const now = v.context.currentTime

  const drive = engineDrive(telemetry.throttle, telemetry.speed, telemetry.speedCap)
  const engine = engineParams(drive, v.engine)
  ease(v, SLOT.engineHzA, v.saws[0].frequency, engine.hz, now, ENGINE_TAU)
  ease(v, SLOT.engineHzB, v.saws[1].frequency, engine.hz, now, ENGINE_TAU)
  ease(v, SLOT.engineGain, v.oscGain.gain, engine.gain, now, ENGINE_TAU)
  ease(v, SLOT.engineCutoff, v.lowpass.frequency, engine.cutoff, now, ENGINE_TAU)
  ease(v, SLOT.engineNoise, v.noiseGain.gain, engine.noiseGain, now, ENGINE_TAU)

  const throttleRate =
    v.lastThrottle == null || dt <= 0 ? 0 : (telemetry.throttle - v.lastThrottle) / dt
  v.lastThrottle = telemetry.throttle
  const thrust = THRUST_GAIN * thrustLevel(input.strafeX, input.strafeY, throttleRate)
  const thrustTau = thrust > v.last[SLOT.thrustGain] ? THRUST_RISE_TAU : THRUST_FALL_TAU
  ease(v, SLOT.thrustGain, v.thrustGain.gain, thrust, now, thrustTau)

  const boost = boostParams(telemetry.boost, telemetry.boosted, v.boost)
  ease(v, SLOT.boostGain, v.boostGain.gain, boost.gain, now, BOOST_TAU)
  ease(v, SLOT.boostHz, v.boostBand.frequency, boost.hz, now, BOOST_TAU)

  const wind = windParams(windLevel(telemetry.air.dynamicPressure), v.wind)
  ease(v, SLOT.windGain, v.windGain.gain, wind.gain, now, WIND_TAU)
  ease(v, SLOT.windHz, v.windBand.frequency, wind.hz, now, WIND_TAU)
}

/**
 * One frame of ShipSound: the voices on `out`, built for its context if `v`
 * is on another (or none), eased toward the ship's state. Returns them.
 */
export function stepShipVoices(
  v: ShipVoices | null,
  out: ShipAudioOutput,
  telemetry: ShipTelemetry,
  input: ShipInput,
  dt: number
): ShipVoices {
  if (v?.context !== out.context) {
    if (v) teardownShipVoices(v)
    v = buildShipVoices(out)
  }
  updateShipVoices(v, telemetry, input, dt)
  return v
}

function release(v: ShipVoices): void {
  for (const source of v.sources) {
    try {
      source.stop()
    } catch {
      // Already stopped, or its context closed: nothing left to stop.
    }
  }
  for (const node of v.nodes) node.disconnect()
}

/**
 * Takes the voices down: at once when nothing is sounding, otherwise after a
 * short fade, so leaving the ship doesn't click.
 */
export function teardownShipVoices(v: ShipVoices): void {
  if (v.context.state !== 'running') return release(v)
  const now = v.context.currentTime
  v.mix.gain.cancelScheduledValues(now)
  v.mix.gain.setTargetAtTime(0, now, RELEASE_SECONDS / 4)
  v.sources[0].onended = () => release(v)
  for (const source of v.sources) source.stop(now + RELEASE_SECONDS)
}
