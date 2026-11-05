// The low tier's idle frame rate (tides-0oi.31, audit arch-1/arch-5). An idle
// frame costs a full frame, and the default view isn't static (the aurora's
// and the Sun's time, the clouds' drift), so it can't simply stop drawing.
// Once nothing has moved for IDLE_AFTER_MS it draws at IDLE_HZ instead
// (renderers/IdleRate.tsx); any input, store change or camera motion brings
// back the full rate on the next frame.

/** ?idlehz=auto turns the cap on (low tier only); off when absent, until the S21 shows a gain. */
export interface IdleRateConfig {
  hz: number
}

/** The capped rate. */
export const IDLE_HZ = 30

/** How long after the last activity the cap starts. */
export const IDLE_AFTER_MS = 2000

/** From this speed up (sim seconds a second, either way) the view keeps the full rate. */
export const IDLE_MAX_SPEED = 1

/** The URL's ?idlehz=: auto caps idle frames at IDLE_HZ; anything else (or none) leaves the rate alone. */
export function parseIdleRate(search: string): IdleRateConfig | null {
  return new URLSearchParams(search).get('idlehz') === 'auto' ? { hz: IDLE_HZ } : null
}

/**
 * The root Canvas's frameloop: 'never' hands the loop to IdleRate's driver,
 * on the low tier with the cap asked for; otherwise R3F's own loop, as before.
 */
export function idleFrameloop(config: IdleRateConfig | null, low: boolean): 'always' | 'never' {
  return config && low ? 'never' : 'always'
}

export interface IdleInput {
  /** The rAF timestamp (ms, performance.now()'s timeline). */
  now: number
  /** performance.now() of the last input, store change or camera motion; -Infinity for none yet. */
  activityAt: number
  /** The store's timeScale. */
  timeScale: number
  /** A date jump is easing (the store's jumpDate is set). */
  jumping: boolean
  demo: boolean
  ship: boolean
  /** The first load's compile and draw are done. */
  sceneReady: boolean
  /** The opening move has played or been cut short. */
  openingDone: boolean
}

/** Whether this frame may be held to the idle rate. */
export function isIdle(input: IdleInput): boolean {
  return (
    input.sceneReady &&
    input.openingDone &&
    !input.jumping &&
    !input.demo &&
    !input.ship &&
    Math.abs(input.timeScale) <= IDLE_MAX_SPEED &&
    input.now - input.activityAt >= IDLE_AFTER_MS
  )
}

export interface IdleSchedule {
  /** The rAF timestamp (ms) of the last drawn tick, and of the last tick. */
  lastDraw: number
  lastTick: number
}

export function createIdleSchedule(): IdleSchedule {
  return { lastDraw: -Infinity, lastTick: -Infinity }
}

/**
 * Whether the tick at `ts` (rAF timestamp, ms) draws. Every tick draws unless
 * idle; idle, a tick is due once periodMs has passed to within half a tick,
 * so 30 Hz is exactly every 2nd tick at 60 Hz and every 4th at 120 Hz,
 * whatever the jitter. The half tick is capped at a quarter period, so a long
 * gap (a hidden tab) can't make a tick due early. Records the tick.
 */
export function idleTick(schedule: IdleSchedule, ts: number, idle: boolean, periodMs: number): boolean {
  const halfTick = Number.isFinite(schedule.lastTick) ? Math.min((ts - schedule.lastTick) / 2, periodMs / 4) : 0
  schedule.lastTick = ts
  if (idle && ts - schedule.lastDraw + halfTick < periodMs) return false
  schedule.lastDraw = ts
  return true
}

/** Camera motion over these marks activity: turning (degrees a second)... */
export const CAMERA_TURN_DEG_S = 0.05
/**
 * ...or the eye moving about its target (a share of its distance from it, a
 * second): over Earth's spin (7.3e-5 rad/s), which close zoom follows, so a
 * still close-zoom view stays capped.
 */
export const CAMERA_MOVE_PER_S = 1e-4

/** Whether a camera turning `turnRad` and moving `moveShare` (of its target distance) over `dtMs` is moving. */
export function cameraMoving(turnRad: number, moveShare: number, dtMs: number): boolean {
  if (!(dtMs > 0)) return false
  const s = dtMs / 1000
  return (turnRad * 180) / Math.PI / s > CAMERA_TURN_DEG_S || moveShare / s > CAMERA_MOVE_PER_S
}
