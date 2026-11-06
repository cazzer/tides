// How often the low tier's side panels (View from Earth, Moon Phase) redraw
// (tides-0oi.18, audit arch-7). At real time they barely move from frame to
// frame, so they draw at a reduced rate and hold their last frame in between
// (renderers/HeldPanel.tsx); anything that moves them quickly brings back the
// full rate.

/** ?panelhz=: auto (the rule below; the low tier's default), 60 (every frame; the high tier's default), or a fixed rate. */
export type PanelRateConfig = { mode: 'auto'; hz: number } | { mode: 'fixed'; hz: number }

const FIXED_RATES = [60, 30, 20, 15]

/** The reduced rate under auto. */
export const PANEL_HZ = 15

/** From this speed up (sim seconds a second) the panels move every frame. */
export const PANEL_FULL_RATE_SPEED = 60 * 60

/** How long after an input on a panel it stays at the full rate. */
export const PANEL_INPUT_MS = 500

/**
 * The URL's ?panelhz=, or the tier's default when absent or unreadable: auto
 * on the low tier (on since the S21 showed GPU work -0.8 ms a frame at no
 * frame cost, tides-0oi.18/.41), 60 (drei draws every frame) otherwise.
 * ?panelhz=60 turns pacing off on either tier.
 */
export function parsePanelRate(search: string, lowTier = false): PanelRateConfig {
  const raw = new URLSearchParams(search).get('panelhz')
  if (raw === 'auto') return { mode: 'auto', hz: PANEL_HZ }
  const hz = Number(raw)
  if (raw && FIXED_RATES.includes(hz)) return { mode: 'fixed', hz }
  return lowTier ? { mode: 'auto', hz: PANEL_HZ } : { mode: 'fixed', hz: 60 }
}

/** Whether panels are paced at all: ?panelhz=60 draws them every frame through drei, as before. */
export function panelsPaced(config: PanelRateConfig): boolean {
  return config.hz < 60
}

export interface PanelRateInput {
  /** The store's timeScale. */
  timeScale: number
  /** A date jump is easing (the store's jumpDate is set). */
  jumping: boolean
  /** A demo is running. */
  demo: boolean
  /** performance.now() of the panel's last input, or null. */
  interactingAt: number | null
  now: number
}

/** The panel's draw period in ms; 0 is every frame. */
export function panelPeriodMs(input: PanelRateInput, config: PanelRateConfig): number {
  if (config.mode === 'fixed') return config.hz >= 60 ? 0 : 1000 / config.hz
  const touched = input.interactingAt !== null && input.now - input.interactingAt < PANEL_INPUT_MS
  if (Math.abs(input.timeScale) >= PANEL_FULL_RATE_SPEED || input.jumping || input.demo || touched) return 0
  return 1000 / config.hz
}

export interface PanelSchedule {
  /** Each panel's last draw, frame time in ms. */
  lastDraw: Map<string, number>
  /** The frame time (ms) a paced panel last drew on (forced and full-rate draws don't count). */
  drewOn: number
  /** This frame's time and the one before it (ms). */
  frame: number
  previousFrame: number
}

export function createPanelSchedule(): PanelSchedule {
  return { lastDraw: new Map(), drewOn: -1, frame: -1, previousFrame: -1 }
}

/**
 * Whether the panel `id` draws this frame (`frameTime`: R3F's
 * clock.elapsedTime, seconds, the same for every callback in a frame). A
 * panel is due once its period has passed to within half a frame, so 15 Hz
 * is every 4th frame at 60 Hz and every 8th at 120 Hz. Unless forced or at
 * the full rate, a due panel waits a frame when another one already drew on
 * this one, so the panels take turns; forced draws never hold another
 * panel back. Records the draw when it returns true.
 */
export function panelDrawDue(
  schedule: PanelSchedule,
  id: string,
  frameTime: number,
  periodMs: number,
  forced: boolean
): boolean {
  const t = frameTime * 1000
  if (t !== schedule.frame) {
    schedule.previousFrame = schedule.frame
    schedule.frame = t
  }
  const last = schedule.lastDraw.get(id)
  if (forced || periodMs <= 0 || last === undefined) {
    schedule.lastDraw.set(id, t)
    return true
  }
  // Capped, so a long gap since the last frame (a hidden tab) can't make a panel due early.
  const halfFrame = schedule.previousFrame >= 0 ? Math.min((t - schedule.previousFrame) / 2, periodMs / 4) : 0
  if (t - last + halfFrame < periodMs || schedule.drewOn === t) return false
  schedule.lastDraw.set(id, t)
  schedule.drewOn = t
  return true
}

/** Forgets a panel (on unmount). */
export function dropPanel(schedule: PanelSchedule, id: string): void {
  schedule.lastDraw.delete(id)
}

/**
 * The useFrame priority of HeldPanel's copy: after every other frame
 * callback, so the copy takes the panel's final pixels (the glow's
 * composite, at 2, included). panel-rate.test.ts holds every other
 * useFrame in src below it.
 */
export const PANEL_COPY_PRIORITY = 100

/** A rect of canvas pixels (x, y, width, height), as THREE.Vector4 holds one. */
export interface PixelRect {
  x: number
  y: number
  z: number
  w: number
}

export interface PanelFrameInput {
  /** The scene has compiled (sceneReady); until then the panel draws every frame. */
  ready: boolean
  /** The held copy is the panel's last draw. */
  valid: boolean
  /** The panel's canvas pixels this frame, and the ones the copy holds. */
  rect: PixelRect
  heldRect: PixelRect
  periodMs: number
}

/**
 * This frame's work for a paced panel: draw it (and then copy it, so the
 * next frames can hold it), or fill it from its copy. A draw is forced
 * while not ready, with no valid copy, or once the panel's pixels moved or
 * resized (a pixel ratio change); otherwise `due(forced)` (panelDrawDue)
 * decides. At the full rate nothing is copied: every frame draws.
 */
export function panelFrame(input: PanelFrameInput, due: (forced: boolean) => boolean): { draw: boolean; copy: boolean } {
  const { rect: r, heldRect: h } = input
  const forced = !input.ready || !input.valid || r.x !== h.x || r.y !== h.y || r.z !== h.z || r.w !== h.w
  if (!due(forced)) return { draw: false, copy: false }
  return { draw: true, copy: input.ready && input.periodMs > 0 }
}
