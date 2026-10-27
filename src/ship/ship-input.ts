// What the pilot is asking for this frame. Desktop (keyboard + virtual-joystick
// mouse) and mobile (steer stick + throttle/roll slider) both write here; the
// flight controller reads it every frame and hands it to stepShip. A plain
// mutable object rather than store state: it changes at pointer-event rate and
// nothing in React needs to re-render when it does.

export interface ShipInput {
  /**
   * Persistent speed setpoint as a share of the current speed cap, −0.25..1.
   * Stays where it was left (ED-style); negative is reverse, capped at a
   * quarter like Elite's reverse thrust.
   */
  throttle: number
  /** Momentary lateral thrust, −1 (left) .. 1 (right). */
  strafeX: number
  /** Momentary vertical thrust, −1 (down) .. 1 (up). */
  strafeY: number
  /** Turn-rate demand, −1..1; +1 is nose up. */
  pitch: number
  /** Turn-rate demand, −1..1; +1 is nose right. */
  yaw: number
  /** Turn-rate demand, −1..1; +1 rolls right (clockwise from the cockpit). */
  roll: number
  /** Held: roll back until the ship's up matches ecliptic north (+Y). */
  level: boolean
  /** Flight Assist: damp velocity to the throttle and rotation to the stick. */
  flightAssist: boolean
  /** Held: raise the speed cap in a body's air (flight.ts AirSpeedLaw.boost). */
  boost: boolean
}

export const THROTTLE_MIN = -0.25
export const THROTTLE_MAX = 1

/** A throttle setting as the HUD and the touch readout show it: "62%", "−15%". */
export function throttlePercent(throttle: number): string {
  const value = Math.round(throttle * 100)
  return value < 0 ? `−${-value}%` : `${value}%`
}

export const shipInput: ShipInput = {
  throttle: 0,
  strafeX: 0,
  strafeY: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  level: false,
  flightAssist: true,
  boost: false,
}

/** Back to a parked ship with Flight Assist on, e.g. on entering ship mode. */
export function resetShipInput(): void {
  shipInput.throttle = 0
  shipInput.strafeX = 0
  shipInput.strafeY = 0
  shipInput.pitch = 0
  shipInput.yaw = 0
  shipInput.roll = 0
  shipInput.level = false
  shipInput.flightAssist = true
  shipInput.boost = false
}
