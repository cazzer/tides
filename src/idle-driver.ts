// The idle cap's driver and its shared state (tides-0oi.31), without React
// or three: renderers/IdleRate.tsx wires it to rAF, R3F and the store;
// AdaptivePixelRatio reads idleCapHeld and reports reportDprSettled; work
// with a per-frame pace registers registerIdleBusy.
import { createIdleSchedule, idleTick, isIdle, type IdleInput } from './idle-rate'

let activityAt = -Infinity
let lastActivity = ''
let capHeld = false
let dprSettled = true
const busyProbes = new Set<() => boolean>()

/** Something moved (an input, a store change, the camera): the next tick draws, and idle waits IDLE_AFTER_MS. */
export function markActivity(what: string, now: number = performance.now()): void {
  activityAt = now
  lastActivity = what
}

export function lastActivityName(): string {
  return lastActivity
}

/** Whether the idle cap holds this frame: the paced dpr controller pauses meanwhile (paced-dpr.ts). */
export function idleCapHeld(): boolean {
  return capHeld
}

/** The paced dpr controller reports whether it has stopped climbing; the cap waits until then. True when it doesn't run. */
export function reportDprSettled(settled: boolean): void {
  dprSettled = settled
}

export function dprSettledNow(): boolean {
  return dprSettled
}

/**
 * Registers work that runs a fixed amount per frame (tile uploads, shader
 * warm-ups): while `probe` says it has some queued, the view isn't idle, so
 * the cap doesn't halve its pace. Returns the unregister.
 */
export function registerIdleBusy(probe: () => boolean): () => void {
  busyProbes.add(probe)
  return () => void busyProbes.delete(probe)
}

export function idleBusy(): boolean {
  for (const probe of busyProbes) if (probe()) return true
  return false
}

/** The view's part of isIdle, read each tick. */
export type IdleView = Pick<IdleInput, 'timeScale' | 'jumping' | 'demo' | 'ship' | 'sceneReady' | 'openingDone'>

export interface IdleDriverDeps {
  periodMs: number
  view(): IdleView
  /** The R3F clock's elapsedTime (s): the first draw continues from it, so a remount keeps time continuous. */
  elapsed(): number
  /** Runs R3F's frame: global effects at `ms` (the rAF timestamp), advance to `sec`, after-effects. */
  frame(ms: number, sec: number): void
}

export interface IdleDriver {
  /** One rAF tick; whether it drew (null while held). */
  tick(ts: number): boolean | null
  /** The cap on or off (off draws every tick). */
  setOn(on: boolean): void
  /** No ticks at all while held (the harness's pause); the next draw's delta covers the hold. */
  hold(held: boolean): void
  /** The driver is gone: the cap no longer holds. */
  stop(): void
  draws: number
  skips: number
}

export function createIdleDriver(deps: IdleDriverDeps): IdleDriver {
  const schedule = createIdleSchedule()
  let on = true
  let held = false
  let start: number | null = null
  const driver: IdleDriver = {
    draws: 0,
    skips: 0,
    setOn: (next) => void (on = next),
    hold: (next) => void (held = next),
    stop() {
      held = true
      capHeld = false
    },
    tick(ts) {
      if (held) return null
      const idle = on && isIdle({ ...deps.view(), now: ts, activityAt, dprSettled, busy: idleBusy() })
      capHeld = idle
      if (!idleTick(schedule, ts, idle, deps.periodMs)) {
        driver.skips++
        return false
      }
      driver.draws++
      start ??= ts - deps.elapsed() * 1000
      deps.frame(ts, (ts - start) / 1000)
      return true
    },
  }
  return driver
}

/** For tests: back to no activity, the cap off, settled, nothing busy. */
export function resetIdleState(): void {
  activityAt = -Infinity
  lastActivity = ''
  capHeld = false
  dprSettled = true
  busyProbes.clear()
}
