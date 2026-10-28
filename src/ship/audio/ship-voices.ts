// The ship's continuous voices (tides-a4j.2): one fixed Web Audio graph per
// AudioContext, built on the first running frame and eased every frame
// toward engine-mix.ts's targets. Each param only hears setTargetAtTime when
// its target has really moved, so a steady ship schedules nothing, and a
// frame allocates nothing. On the first update the pitches and bands jump
// straight to where the ship is and only the levels fade in, so entering at
// speed doesn't open with a sweep.
//
//   2 detuned saws ─ oscGain ─┐
//   brown noise ─ noiseGain ──┴─ lowpass ─────────────┐
//   brown noise ─ lowpass ─ thrustGain ───────────────┤
//   brown noise ─ lowpass ─ boostGain ────────────────┼─ mix
//   brown noise ─ lowpass ─ windGain ─────────────────┘
//
//   mix ─ highpass ─ out.bus

import { MAX_DT } from '../flight'
import type { ShipInput } from '../ship-input'
import type { ShipTelemetry } from '../ship-telemetry'
import type { ShipAudioOutput } from './ship-audio'
import {
  BOOST_HZ,
  BOOST_Q,
  BOOST_TAU,
  boostParams,
  ENGINE_CUTOFF,
  ENGINE_DETUNE_CENTS,
  ENGINE_HZ,
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
  WIND_HZ,
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
// The "brown" noise is red-ish: white through a one-pole lowpass at this
// corner, Hz, which falls 6 dB an octave above it like brown noise but never
// drifts off. Its leak per sample follows the context's sample rate. Every
// noise voice is lowpassed under BOOST_HZ's top, so a low corner costs them
// little.
const BROWN_CORNER_HZ = 90
// The noise voices all loop one buffer; each plays it at its own rate, so
// their loops drift apart rather than repeat together, heard as a cycle in
// the rumble's swells.
const NOISE_RATES = [0.93, 0.97, 1.03, 1.07] as const
// The mix's highpass, Hz, and resonance, dB (about Butterworth): it drops
// the red noise's flat run under hearing, which only spends headroom and
// drives a small speaker's cone into distortion.
const SUBSONIC_HZ = 25
const SUBSONIC_Q = -3
// A target this close to the last one set is left alone.
const RELATIVE_STEP = 1e-4
const ABSOLUTE_STEP = 1e-5
// Leaving the ship: the mix fades over this, then the sources stop, seconds.
// Inside the master's own fade before its suspend (ship-audio.ts), so the
// stop lands while the context still runs.
const RELEASE_SECONDS = 0.06
// If the stop never lands (the context suspended first), the graph is
// released anyway after this, ms.
const RELEASE_FALLBACK_MS = (RELEASE_SECONDS + 0.25) * 1000
// A frame gap longer than this (muted, hidden, a stall) forgets the last
// throttle, so the change made meanwhile doesn't puff on the way back, ms.
const THROTTLE_GAP_MS = 2 * MAX_DT * 1000
// The throttle's rate is smoothed over this, seconds, so a touch slider's
// flutter doesn't patter; under RATE_EPSILON it is 0.
const RATE_TAU = 0.08
const RATE_EPSILON = 1e-3

// The params eased every frame, by slot in ShipVoices.last.
const SLOT = {
  engineHz: 0,
  engineGain: 1,
  engineCutoff: 2,
  engineNoise: 3,
  thrustGain: 4,
  boostGain: 5,
  boostHz: 6,
  windGain: 7,
  windHz: 8,
} as const
const SLOTS = 9

export interface ShipVoices {
  context: AudioContext
  mix: GainNode
  saws: [OscillatorNode, OscillatorNode]
  oscGain: GainNode
  noiseGain: GainNode
  lowpass: BiquadFilterNode
  thrustGain: GainNode
  boostFilter: BiquadFilterNode
  boostGain: GainNode
  windFilter: BiquadFilterNode
  windGain: GainNode
  sources: AudioScheduledSourceNode[]
  nodes: AudioNode[]
  /** The last target set per SLOT; NaN until the first. */
  last: Float64Array
  lastThrottle: number | null
  /** The wall clock at the last update, ms. */
  lastUpdateAt: number
  /** The throttle's smoothed rate, per second. */
  throttleRate: number
  released: boolean
  engine: EngineParams
  boost: BoostParams
  wind: WindParams
}

function noiseBuffer(context: BaseAudioContext, brown: boolean): AudioBuffer {
  const length = Math.round(NOISE_SECONDS * context.sampleRate)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  const leak = Math.exp((-2 * Math.PI * BROWN_CORNER_HZ) / context.sampleRate)
  let level = 0
  let peak = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    level = brown ? leak * level + (1 - leak) * white : white
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

// Made once per context: a rebuild (a voice graph per flight) reuses them.
const noiseBuffers = new WeakMap<BaseAudioContext, { brown: AudioBuffer; white: AudioBuffer }>()

/**
 * The context's looping noise, NOISE_SECONDS long: red-ish (see
 * BROWN_CORNER_HZ) and white. Made on first ask; the cues share it.
 */
export function shipNoise(context: BaseAudioContext): { brown: AudioBuffer; white: AudioBuffer } {
  let buffers = noiseBuffers.get(context)
  if (!buffers) {
    buffers = { brown: noiseBuffer(context, true), white: noiseBuffer(context, false) }
    noiseBuffers.set(context, buffers)
  }
  return buffers
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
  const { brown } = shipNoise(context)
  // Each noise voice starts at its own place in the loop, so two voices on
  // one buffer don't sound as one.
  const loop = (buffer: AudioBuffer, offset: number, rate: number) => {
    const node = context.createBufferSource()
    node.buffer = buffer
    node.loop = true
    node.playbackRate.value = rate
    node.start(0, offset * NOISE_SECONDS)
    nodes.push(node)
    sources.push(node)
    return node
  }

  const mix = gain()
  mix.gain.value = VOICES_GAIN
  const subsonic = filter('highpass', SUBSONIC_HZ, SUBSONIC_Q)
  mix.connect(subsonic)
  subsonic.connect(out.bus)

  const lowpass = filter('lowpass', ENGINE_CUTOFF[0], 0.7)
  lowpass.connect(mix)
  const oscGain = gain()
  oscGain.connect(lowpass)
  const saws = [-1, 1].map((sign) => {
    const node = context.createOscillator()
    node.type = 'sawtooth'
    node.frequency.value = ENGINE_HZ[0]
    node.detune.value = sign * ENGINE_DETUNE_CENTS
    node.connect(oscGain)
    node.start()
    nodes.push(node)
    sources.push(node)
    return node
  }) as [OscillatorNode, OscillatorNode]
  const noiseGain = gain()
  noiseGain.connect(lowpass)
  loop(brown, 0, NOISE_RATES[0]).connect(noiseGain)

  const thrustGain = gain()
  thrustGain.connect(mix)
  const thrustFilter = filter('lowpass', THRUST_HZ, THRUST_Q)
  thrustFilter.connect(thrustGain)
  loop(brown, 0.25, NOISE_RATES[1]).connect(thrustFilter)

  const boostGain = gain()
  boostGain.connect(mix)
  const boostFilter = filter('lowpass', BOOST_HZ[0], BOOST_Q)
  boostFilter.connect(boostGain)
  loop(brown, 0.75, NOISE_RATES[2]).connect(boostFilter)

  const windGain = gain()
  windGain.connect(mix)
  const windFilter = filter('lowpass', WIND_HZ[0], WIND_Q)
  windFilter.connect(windGain)
  loop(brown, 0.5, NOISE_RATES[3]).connect(windFilter)

  return {
    context,
    mix,
    saws,
    oscGain,
    noiseGain,
    lowpass,
    thrustGain,
    boostFilter,
    boostGain,
    windFilter,
    windGain,
    sources,
    nodes,
    last: new Float64Array(SLOTS).fill(NaN),
    lastThrottle: null,
    lastUpdateAt: -Infinity,
    throttleRate: 0,
    released: false,
    engine: { hz: 0, gain: 0, cutoff: 0, noiseGain: 0 },
    boost: { gain: 0, hz: 0 },
    wind: { gain: 0, hz: 0 },
  }
}

/**
 * Eases `param` (and `twin`, which follows the same target) toward `target`
 * when it has moved from the slot's last; 0 always lands, so a silenced
 * voice is silent. On the slot's first target, `jump` sets it at once.
 */
function ease(
  v: ShipVoices,
  slot: number,
  target: number,
  now: number,
  tau: number,
  jump: boolean,
  param: AudioParam,
  twin?: AudioParam
): void {
  const last = v.last[slot]
  const step = Math.abs(target - last)
  if (!(target === 0 && last !== 0) && step <= Math.max(ABSOLUTE_STEP, RELATIVE_STEP * Math.abs(last))) return
  v.last[slot] = target
  if (jump && Number.isNaN(last)) {
    param.setValueAtTime(target, now)
    twin?.setValueAtTime(target, now)
  } else {
    param.setTargetAtTime(target, now, tau)
    twin?.setTargetAtTime(target, now, tau)
  }
}

/**
 * Eases the voices toward the ship's state this frame; `dt` in seconds,
 * `wallMs` the wall clock (performance.now()), which tells a frame gap.
 */
export function updateShipVoices(
  v: ShipVoices,
  telemetry: ShipTelemetry,
  input: ShipInput,
  dt: number,
  wallMs: number
): void {
  const now = v.context.currentTime

  const drive = engineDrive(telemetry.throttle, telemetry.speed, telemetry.speedCap)
  const engine = engineParams(drive, v.engine)
  ease(v, SLOT.engineHz, engine.hz, now, ENGINE_TAU, true, v.saws[0].frequency, v.saws[1].frequency)
  ease(v, SLOT.engineGain, engine.gain, now, ENGINE_TAU, false, v.oscGain.gain)
  ease(v, SLOT.engineCutoff, engine.cutoff, now, ENGINE_TAU, true, v.lowpass.frequency)
  ease(v, SLOT.engineNoise, engine.noiseGain, now, ENGINE_TAU, false, v.noiseGain.gain)

  if (wallMs - v.lastUpdateAt > THROTTLE_GAP_MS) {
    v.lastThrottle = null
    v.throttleRate = 0
  }
  v.lastUpdateAt = wallMs
  if (v.lastThrottle != null && dt > 0) {
    const rate = (telemetry.throttle - v.lastThrottle) / dt
    v.throttleRate += (rate - v.throttleRate) * (1 - Math.exp(-dt / RATE_TAU))
    if (Math.abs(v.throttleRate) < RATE_EPSILON) v.throttleRate = 0
  }
  v.lastThrottle = telemetry.throttle
  const thrust = THRUST_GAIN * thrustLevel(input.strafeX, input.strafeY, v.throttleRate)
  const thrustTau = thrust > v.last[SLOT.thrustGain] ? THRUST_RISE_TAU : THRUST_FALL_TAU
  ease(v, SLOT.thrustGain, thrust, now, thrustTau, false, v.thrustGain.gain)

  const boost = boostParams(telemetry.boost, telemetry.boosted, v.boost)
  ease(v, SLOT.boostGain, boost.gain, now, BOOST_TAU, false, v.boostGain.gain)
  ease(v, SLOT.boostHz, boost.hz, now, BOOST_TAU, true, v.boostFilter.frequency)

  const wind = windParams(windLevel(telemetry.air.dynamicPressure), v.wind)
  ease(v, SLOT.windGain, wind.gain, now, WIND_TAU, false, v.windGain.gain)
  ease(v, SLOT.windHz, wind.hz, now, WIND_TAU, true, v.windFilter.frequency)
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
  dt: number,
  wallMs = performance.now()
): ShipVoices {
  if (v?.context !== out.context) {
    if (v) teardownShipVoices(v)
    v = buildShipVoices(out)
  }
  updateShipVoices(v, telemetry, input, dt, wallMs)
  return v
}

function release(v: ShipVoices): void {
  if (v.released) return
  v.released = true
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
  setTimeout(() => release(v), RELEASE_FALLBACK_MS)
}
