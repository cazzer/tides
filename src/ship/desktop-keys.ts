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
  key: string
  repeat: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export interface ShipKeys {
  /** The ship keys currently held down. */
  held: Set<ShipKeyAction>
  /**
   * Throttle keys whose ramp stops at zero because they were pressed on the
   * far side of it: S from forward thrust, W from reverse. Crossing zero
   * takes a fresh press, as in Elite Dangerous.
   */
  detent: Set<ShipKeyAction>
}

export function createShipKeys(): ShipKeys {
  return { held: new Set(), detent: new Set() }
}

/**
 * The action a key press maps to, or null when ship mode should leave it
 * alone: unbound keys, and chords with Cmd/Ctrl/Alt so browser and OS
 * shortcuts (Cmd+R, Ctrl+W, …) keep working. Shift is not a modifier here.
 */
export function shipKeyAction(event: Omit<ShipKeyEvent, 'key' | 'repeat'>): ShipKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  return SHIP_KEYS[event.code] ?? null
}

const axis = (held: Set<ShipKeyAction>, negative: ShipKeyAction, positive: ShipKeyAction) =>
  (held.has(positive) ? 1 : 0) - (held.has(negative) ? 1 : 0)

// Momentary inputs follow the held set; both keys of a pair cancel to 0.
function applyHeld(held: Set<ShipKeyAction>, input: ShipInput): void {
  input.strafeX = axis(held, 'strafeLeft', 'strafeRight')
  input.strafeY = axis(held, 'strafeDown', 'strafeUp')
  input.roll = axis(held, 'rollLeft', 'rollRight')
  input.level = held.has('level')
}

/**
 * Applies a keydown. Returns true when the key is a ship key (the caller
 * should preventDefault), false when it should pass through untouched.
 */
export function shipKeyDown(keys: ShipKeys, event: ShipKeyEvent, input: ShipInput): boolean {
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
  if (!keys.held.has(action)) {
    const pastZero =
      (action === 'throttleDown' && input.throttle > 0) ||
      (action === 'throttleUp' && input.throttle < 0)
    if (pastZero) keys.detent.add(action)
    else keys.detent.delete(action)
  }
  keys.held.add(action)
  applyHeld(keys.held, input)
  return true
}

/**
 * Applies a keyup. Modifiers are not checked: a key pressed before Cmd went
 * down must still let go. Returns true when it released a held ship key (the
 * caller should preventDefault).
 *
 * Releasing Cmd lets go of everything: macOS sends no keyup for keys
 * released while Cmd is down, so they would otherwise stick.
 */
export function shipKeyUp(
  keys: ShipKeys,
  event: Pick<ShipKeyEvent, 'code' | 'key'>,
  input: ShipInput
): boolean {
  if (event.key === 'Meta') {
    releaseShipKeys(keys, input)
    return false
  }
  const action = SHIP_KEYS[event.code]
  if (!action || !keys.held.delete(action)) return false
  keys.detent.delete(action)
  applyHeld(keys.held, input)
  return true
}

/**
 * Ramps the persistent throttle setpoint while W or S is held. Holding both
 * leaves it where it is; a detented key stops at zero.
 */
export function stepThrottle(keys: ShipKeys, input: ShipInput, dt: number): void {
  const direction = axis(keys.held, 'throttleDown', 'throttleUp')
  if (direction === 0 || !(dt > 0)) return
  const from = input.throttle
  let next = Math.min(THROTTLE_MAX, Math.max(THROTTLE_MIN, from + direction * THROTTLE_RATE * dt))
  if (direction > 0 && keys.detent.has('throttleUp') && from <= 0 && next > 0) next = 0
  if (direction < 0 && keys.detent.has('throttleDown') && from >= 0 && next < 0) next = 0
  input.throttle = next
}

/** Lets go of every held key, e.g. when the window loses focus. */
export function releaseShipKeys(keys: ShipKeys, input: ShipInput): void {
  keys.held.clear()
  keys.detent.clear()
  applyHeld(keys.held, input)
}
