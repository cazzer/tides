import { afterEach, describe, expect, it } from 'vitest'
import { resetShipApproach, shipApproach } from '../approach'
import { shipImpacts } from '../impact'
import { resetShipInput, shipInput } from '../ship-input'
import { setShipTarget } from '../ship-telemetry'
import {
  createShipCueWatch,
  IMPACT_CUE_COOLDOWN_MS,
  KLAXON_COOLDOWN_MS,
  readShipCueSignals,
  watchShipCues,
  type ShipCueKind,
  type ShipCueSignals,
} from './ship-cues'

function setup(initial: Partial<ShipCueSignals> = {}) {
  const watch = createShipCueWatch()
  const signals: ShipCueSignals = {
    impacts: 0,
    status: 'open',
    target: null,
    flightAssist: true,
    ...initial,
  }
  let now = 0
  const fired: ShipCueKind[] = []
  // Whether the sound plays what fires (false: muted, say).
  const sound = { on: true }
  /** One frame, `ms` after the last; returns what it fired. */
  const frame = (ms = 16) => {
    now += ms
    const before = fired.length
    watchShipCues(watch, signals, now, (kind) => {
      fired.push(kind)
      return sound.on
    })
    return fired.slice(before)
  }
  frame()
  return { signals, frame, fired, sound }
}

describe('ship cue watcher (tides-a4j.3)', () => {
  it('takes in the state on entry without a sound', () => {
    const { fired } = setup({ impacts: 7, status: 'over', target: 'moon', flightAssist: false })
    expect(fired).toEqual([])
  })

  it('sounds nothing while nothing changes', () => {
    const { frame, fired } = setup({ status: 'fast', target: 'earth' })
    for (let i = 0; i < 100; i++) frame()
    expect(fired).toEqual([])
  })

  it('thuds once per impact, with a cooldown', () => {
    const { signals, frame } = setup()
    signals.impacts = 1
    expect(frame()).toEqual(['impact'])
    expect(frame()).toEqual([])
    signals.impacts = 2
    expect(frame()).toEqual([])
    signals.impacts = 3
    expect(frame(IMPACT_CUE_COOLDOWN_MS)).toEqual(['impact'])
  })

  it('sounds the klaxon once as a warning starts, not while it holds', () => {
    const { signals, frame, fired } = setup({ status: 'closing' })
    signals.status = 'fast'
    expect(frame()).toEqual(['klaxon'])
    for (let i = 0; i < 1000; i++) frame()
    expect(fired).toEqual(['klaxon'])
  })

  it('rate-limits the klaxon over a warning that comes and goes', () => {
    const { signals, frame } = setup({ status: 'closing' })
    signals.status = 'fast'
    expect(frame()).toEqual(['klaxon'])
    signals.status = 'closing'
    frame()
    signals.status = 'fast'
    expect(frame(1000)).toEqual([])
    signals.status = 'closing'
    frame()
    signals.status = 'fast'
    expect(frame(KLAXON_COOLDOWN_MS)).toEqual(['klaxon'])
  })

  it('sounds again when a warning worsens to overshooting', () => {
    const { signals, frame } = setup({ status: 'closing' })
    signals.status = 'fast'
    frame()
    signals.status = 'over'
    expect(frame(KLAXON_COOLDOWN_MS)).toEqual(['klaxon'])
    signals.status = 'fast'
    expect(frame(KLAXON_COOLDOWN_MS)).toEqual([])
  })

  it('starts a cooldown only for a cue that played', () => {
    const { signals, frame, sound } = setup({ status: 'closing' })
    sound.on = false
    signals.impacts = 1
    signals.status = 'fast'
    expect(frame()).toEqual(['impact', 'klaxon'])
    sound.on = true
    signals.impacts = 2
    signals.status = 'closing'
    expect(frame()).toEqual(['impact'])
    signals.status = 'fast'
    expect(frame()).toEqual(['klaxon'])
  })

  it('blips on a lock and on moving it, not on clearing it', () => {
    const { signals, frame } = setup()
    signals.target = 'mars'
    expect(frame()).toEqual(['lock'])
    signals.target = 'moon'
    expect(frame()).toEqual(['lock'])
    signals.target = null
    expect(frame()).toEqual([])
    expect(frame()).toEqual([])
  })

  it('blips Flight Assist off and on as it switches', () => {
    const { signals, frame } = setup()
    signals.flightAssist = false
    expect(frame()).toEqual(['assistOff'])
    expect(frame()).toEqual([])
    signals.flightAssist = true
    expect(frame()).toEqual(['assistOn'])
  })

  it('fires each cue an event calls for in one frame', () => {
    const { signals, frame } = setup({ status: 'closing' })
    Object.assign(signals, { impacts: 1, status: 'over', target: 'moon', flightAssist: false })
    expect(frame()).toEqual(['impact', 'klaxon', 'lock', 'assistOff'])
  })
})

describe('readShipCueSignals', () => {
  afterEach(() => {
    resetShipApproach()
    resetShipInput()
    setShipTarget(null)
  })

  it('reads the live impacts, approach, lock and Flight Assist', () => {
    shipImpacts.count = 4
    shipApproach.key = 'moon'
    shipApproach.status = 'fast'
    // The subject isn't the lock: the lock is the target set by the HUD or T.
    shipApproach.locked = false
    setShipTarget('mars')
    shipInput.flightAssist = false
    expect(readShipCueSignals({ impacts: 0, status: 'open', target: null, flightAssist: true })).toEqual({
      impacts: 4,
      status: 'fast',
      target: 'mars',
      flightAssist: false,
    })
  })
})
