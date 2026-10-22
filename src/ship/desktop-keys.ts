// Desktop keyboard → shipInput (tides-3bl.3). Pure: the hook feeds it
// keyboard events and frame times; everything here is testable without a DOM.
//
// Keys are matched by KeyboardEvent.code, i.e. by position, so WASD sits under
// the left hand on AZERTY and Dvorak too.

import { THROTTLE_MAX, THROTTLE_MIN, type ShipInput } from './ship-input'

export type ShipKeyAction =
  | 'throttleUp'
  | 'throttleDown'
  | 'throttleZero'
  | 'strafeLeft'
  | 'strafeRight'
  | 'strafeUp'
  | 'strafeDown'
  | 'rollLeft'
  | 'rollRight'
  | 'flightAssist'
  | 'level'

export const SHIP_KEYS: Readonly<Record<string, ShipKeyAction>> = {
  KeyW: 'throttleUp',
  KeyS: 'throttleDown',
  KeyX: 'throttleZero',
  KeyA: 'strafeLeft',
  KeyD: 'strafeRight',
  KeyR: 'strafeUp',
  KeyF: 'strafeDown',
  KeyQ: 'rollLeft',
  KeyE: 'rollRight',
  KeyZ: 'flightAssist',
  KeyL: 'level',
}

/** Holding W (or S) sweeps the whole throttle range in this long. */
export const THROTTLE_SWEEP_SECONDS = 1.5
export const THROTTLE_RATE = (THROTTLE_MAX - THROTTLE_MIN) / THROTTLE_SWEEP_SECONDS

/** The parts of a KeyboardEvent the mapping reads. */
export interface ShipKeyEvent {
  code: string
  repeat: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/** The ship keys currently held down. */
export type HeldKeys = Set<ShipKeyAction>

/**
 * The action a key press maps to, or null when ship mode should leave it
 * alone: unbound keys, and chords with Cmd/Ctrl/Alt so browser and OS
 * shortcuts (Cmd+R, Ctrl+W, …) keep working. Shift is not a modifier here.
 */
export function shipKeyAction(event: ShipKeyEvent): ShipKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  return SHIP_KEYS[event.code] ?? null
}

const axis = (held: HeldKeys, negative: ShipKeyAction, positive: ShipKeyAction) =>
  (held.has(positive) ? 1 : 0) - (held.has(negative) ? 1 : 0)

// Momentary inputs follow the held set; both keys of a pair cancel to 0.
function applyHeld(held: HeldKeys, input: ShipInput): void {
  input.strafeX = axis(held, 'strafeLeft', 'strafeRight')
  input.strafeY = axis(held, 'strafeDown', 'strafeUp')
  input.roll = axis(held, 'rollLeft', 'rollRight')
  input.level = held.has('level')
}

/**
 * Applies a keydown. Returns true when the key is a ship key (the caller
 * should preventDefault), false when it should pass through untouched.
 */
export function shipKeyDown(held: HeldKeys, event: ShipKeyEvent, input: ShipInput): boolean {
  const action = shipKeyAction(event)
  if (!action) return false
  if (action === 'flightAssist') {
    // A toggle: auto-repeat while Z is held must not flicker it.
    if (!event.repeat) input.flightAssist = !input.flightAssist
    return true
  }
  if (action === 'throttleZero') {
    input.throttle = 0
    return true
  }
  held.add(action)
  applyHeld(held, input)
  return true
}

/**
 * Applies a keyup. Modifiers are not checked: a key pressed before Cmd went
 * down must still let go. Returns true when it released a held ship key.
 */
export function shipKeyUp(held: HeldKeys, event: Pick<ShipKeyEvent, 'code'>, input: ShipInput): boolean {
  const action = SHIP_KEYS[event.code]
  if (!action || !held.delete(action)) return false
  applyHeld(held, input)
  return true
}

/**
 * Ramps the persistent throttle setpoint while W or S is held. Holding both
 * leaves it where it is.
 */
export function stepThrottle(held: HeldKeys, input: ShipInput, dt: number): void {
  const direction = axis(held, 'throttleDown', 'throttleUp')
  if (direction === 0 || !(dt > 0)) return
  const next = input.throttle + direction * THROTTLE_RATE * dt
  input.throttle = Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, next))
}

/** Lets go of every held key, e.g. when the window loses focus. */
export function releaseShipKeys(held: HeldKeys, input: ShipInput): void {
  held.clear()
  applyHeld(held, input)
}
