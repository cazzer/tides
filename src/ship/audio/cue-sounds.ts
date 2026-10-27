// The one-shot cues' sounds (tides-a4j.3), built for playShipCue: short,
// procedural, modest. Each is a few nodes made for the one event and freed
// when it ends. The blips tell themselves apart by shape: the lock is two
// pips on one high note, Flight Assist a two-note step, up for on and down
// for off.

import type { ShipAudioOutput, ShipCue } from './ship-audio'
import type { ShipCueKind } from './ship-cues'

/** [TUNE] The impact's thud: a sine falling from the first pitch to the second, Hz, over IMPACT_SECONDS. */
export const IMPACT_HZ: readonly [number, number] = [90, 38]
export const IMPACT_SECONDS = 0.35
export const IMPACT_GAIN = 0.3
/** [TUNE] The crunch over the thud: lowpassed noise, its corner, Hz, length, s, and level. */
export const IMPACT_NOISE_HZ = 500
export const IMPACT_NOISE_SECONDS = 0.12
export const IMPACT_NOISE_GAIN = 0.2

/** [TUNE] The approach klaxon: a lowpassed square alternating these notes, Hz. */
export const KLAXON_NOTES: readonly number[] = [660, 520, 660, 520]
export const KLAXON_NOTE_SECONDS = 0.16
export const KLAXON_CUTOFF = 2000
export const KLAXON_GAIN = 0.06

/** [TUNE] The blips: sine notes, Hz, each this long, s, at this level. */
export const LOCK_NOTES: readonly number[] = [1320, 1320]
export const ASSIST_ON_NOTES: readonly number[] = [660, 990]
export const ASSIST_OFF_NOTES: readonly number[] = [990, 660]
export const BLIP_NOTE_SECONDS = 0.06
export const BLIP_GAP_SECONDS = 0.04
export const BLIP_GAIN = 0.08

// Each note's attack and release, s: short enough to read as a blip, long
// enough not to click.
const EDGE_SECONDS = 0.005
// The source runs on this long past its last note, s.
const TAIL_SECONDS = 0.02

/**
 * One oscillator stepping through `notes`, each `noteSeconds` long with
 * `gapSeconds` of silence after, each enveloped, optionally through a
 * lowpass at `cutoff`.
 */
function tones(
  out: ShipAudioOutput,
  at: number,
  notes: readonly number[],
  type: OscillatorType,
  noteSeconds: number,
  gapSeconds: number,
  gain: number,
  cutoff?: number
): ShipCue {
  const { context } = out
  const osc = context.createOscillator()
  osc.type = type
  const level = context.createGain()
  level.gain.setValueAtTime(0, at)
  const nodes: AudioNode[] = [level]
  let into: AudioNode = level
  if (cutoff != null) {
    const lowpass = context.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = cutoff
    lowpass.connect(level)
    nodes.push(lowpass)
    into = lowpass
  }
  osc.connect(into)
  level.connect(out.bus)
  let t = at
  for (const hz of notes) {
    osc.frequency.setValueAtTime(hz, t)
    level.gain.setValueAtTime(0, t)
    level.gain.linearRampToValueAtTime(gain, t + EDGE_SECONDS)
    level.gain.setValueAtTime(gain, t + noteSeconds - EDGE_SECONDS)
    level.gain.linearRampToValueAtTime(0, t + noteSeconds)
    t += noteSeconds + gapSeconds
  }
  osc.start(at)
  osc.stop(t + TAIL_SECONDS)
  return { end: osc, nodes }
}

/** A falling sine thud with a short burst of lowpassed noise over its start. */
function impact(out: ShipAudioOutput, at: number): ShipCue {
  const { context } = out
  const end = at + IMPACT_SECONDS

  const osc = context.createOscillator()
  osc.frequency.setValueAtTime(IMPACT_HZ[0], at)
  osc.frequency.exponentialRampToValueAtTime(IMPACT_HZ[1], end)
  const thud = context.createGain()
  thud.gain.setValueAtTime(0, at)
  thud.gain.linearRampToValueAtTime(IMPACT_GAIN, at + EDGE_SECONDS)
  thud.gain.exponentialRampToValueAtTime(0.001, end)
  osc.connect(thud)
  thud.connect(out.bus)

  const length = Math.round(IMPACT_NOISE_SECONDS * context.sampleRate)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  const noise = context.createBufferSource()
  noise.buffer = buffer
  const lowpass = context.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = IMPACT_NOISE_HZ
  const crunch = context.createGain()
  crunch.gain.setValueAtTime(IMPACT_NOISE_GAIN, at)
  crunch.gain.exponentialRampToValueAtTime(0.001, at + IMPACT_NOISE_SECONDS)
  noise.connect(lowpass)
  lowpass.connect(crunch)
  crunch.connect(out.bus)

  noise.start(at)
  osc.start(at)
  osc.stop(end + TAIL_SECONDS)
  // The thud outlasts the crunch, so its end frees both.
  return { end: osc, nodes: [thud, noise, lowpass, crunch] }
}

/** The builder playShipCue takes for each cue. */
export const SHIP_CUE_SOUNDS: Readonly<Record<ShipCueKind, (out: ShipAudioOutput, at: number) => ShipCue>> = {
  impact,
  klaxon: (out, at) => tones(out, at, KLAXON_NOTES, 'square', KLAXON_NOTE_SECONDS, 0, KLAXON_GAIN, KLAXON_CUTOFF),
  lock: (out, at) => tones(out, at, LOCK_NOTES, 'sine', BLIP_NOTE_SECONDS, BLIP_GAP_SECONDS, BLIP_GAIN),
  assistOn: (out, at) => tones(out, at, ASSIST_ON_NOTES, 'sine', BLIP_NOTE_SECONDS, BLIP_GAP_SECONDS, BLIP_GAIN),
  assistOff: (out, at) => tones(out, at, ASSIST_OFF_NOTES, 'sine', BLIP_NOTE_SECONDS, BLIP_GAP_SECONDS, BLIP_GAIN),
}
