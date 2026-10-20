// Which real cloud keyframes to show, and when (tides-kzj.4.1). Playback steps
// through real frames at a cadence that gives each at least MIN_FRAME_WALL_MS
// of wall time, and the GPU cross-fades the two that bracket the sim time
// (renderers/cloudBlend.ts). Inside the geostationary archive the frames sit
// on the cadence's grid; before it, on the daily composites' noons. Stepping
// on to the next frames commits at once and lets the builds in flight finish,
// so fast playback keeps moving; jumps, scrubs and rate changes settle first.
// Too fast for any cadence, one frame is held and refreshed now and then.
// Pure logic; the fetching lives in renderers/realCloudController.ts.
import {
  DAY_MS,
  GEO_ARCHIVE_MS,
  GEO_SLOT_MS,
  selectCloudSource,
  selectGeoSlot,
  selectRealCloudSource,
  sourceKey,
  type CloudSource,
} from './real-clouds'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const CADENCES_MS = [
  10 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
] as const
/** Shortest wall time a frame may last: about what a build takes. */
export const MIN_FRAME_WALL_MS = 3000
/** Too fast for any cadence, the held frame is replaced this often at most. */
export const HOLD_REFRESH_MS = 4000
/** A plan that isn't the next step along must be wanted this long (wall
 * clock) before it is fetched, so the frames of a jump tween or a scrub never
 * trigger downloads. */
export const SETTLE_MS = 1500
export const MAX_CACHED_FRAMES = 5
export const MAX_IN_FLIGHT = 2

export type CloudStatus = 'loading' | 'ready' | 'failed'

export interface CloudFrame {
  key: string
  /** The sim time the imagery shows. */
  timeMs: number
  source: CloudSource
}

export interface FrameView<T> extends CloudFrame {
  status: CloudStatus
  /** Null for static frames and frames without a texture yet. */
  texture: T | null
}

/** Frames in priority order: the one at or before the sim time, the one
 * after it, then a prefetch. */
export type CloudPlan =
  | { mode: 'bracket'; cadenceMs: number; frames: CloudFrame[] }
  | { mode: 'hold'; frames: [CloudFrame] }

function frameOf(source: CloudSource, timeMs: number): CloudFrame {
  return { key: sourceKey(source), timeMs, source }
}

/** The keyframe spacing for a playback rate (sim seconds per wall second), or
 * null when even a day goes by too fast. Paused shows the finest. */
export function cadenceFor(timeScale: number): number | null {
  if (timeScale === 0) return CADENCES_MS[0]
  return CADENCES_MS.find((c) => c / Math.abs(timeScale) >= MIN_FRAME_WALL_MS) ?? null
}

const noonAtOrBefore = (t: number) => Math.floor((t - DAY_MS / 2) / DAY_MS) * DAY_MS + DAY_MS / 2

/** The first geostationary slot inside the archive. */
const archiveStart = (nowMs: number) => Math.ceil((nowMs - GEO_ARCHIVE_MS) / GEO_SLOT_MS) * GEO_SLOT_MS

/** The frame on the cadence's grid at or before t: a geostationary slot (the
 * latest published one past it) inside the archive, the daily composite's noon
 * before it, static outside the imagery. */
export function frameAtOrBefore(t: number, cadenceMs: number, nowMs: number): CloudFrame {
  const g = Math.floor(t / cadenceMs) * cadenceMs
  const slot = selectGeoSlot(g, nowMs)
  if (slot !== null) {
    const source = selectRealCloudSource(g, nowMs)
    return frameOf(source, source.kind === 'geo' ? slot : g)
  }
  const noon = noonAtOrBefore(t)
  return frameOf(selectCloudSource(noon, nowMs), noon)
}

/** The next frame after the one at t, or null when either is static (static
 * is never blended) or there is no later imagery. */
export function frameAfter(t: number, cadenceMs: number, nowMs: number): CloudFrame | null {
  const at = frameAtOrBefore(t, cadenceMs, nowMs)
  if (at.source.kind === 'static') return null
  const g = Math.floor(t / cadenceMs) * cadenceMs
  let next: CloudFrame
  if (selectGeoSlot(g, nowMs) !== null) {
    next = frameAtOrBefore(g + cadenceMs, cadenceMs, nowMs)
  } else {
    // The next noon, or the first slot of the archive if that comes first.
    const firstSlot = Math.ceil(archiveStart(nowMs) / cadenceMs) * cadenceMs
    next = frameAtOrBefore(Math.min(noonAtOrBefore(t) + DAY_MS, firstSlot), cadenceMs, nowMs)
  }
  return next.source.kind === 'static' || next.key === at.key ? null : next
}

export function planCloudFrames(simMs: number, timeScale: number, nowMs: number): CloudPlan {
  const cadenceMs = cadenceFor(timeScale)
  if (cadenceMs === null) {
    return { mode: 'hold', frames: [frameOf(selectRealCloudSource(simMs, nowMs), simMs)] }
  }
  const frames = [frameAtOrBefore(simMs, cadenceMs, nowMs)]
  const after = frameAfter(simMs, cadenceMs, nowMs)
  if (after) {
    frames.push(after)
    // Prefetch forward only; paused needs nothing past the bracket.
    const prefetch = timeScale > 0 ? frameAfter(after.timeMs, cadenceMs, nowMs) : null
    if (prefetch) frames.push(prefetch)
  }
  return {
    mode: 'bracket',
    cadenceMs,
    frames: frames.filter((f, i) => frames.findIndex((o) => o.key === f.key) === i),
  }
}

function samePlan(a: CloudPlan, b: CloudPlan): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'bracket' && b.mode === 'bracket' && a.cadenceMs !== b.cadenceMs) return false
  return a.frames.length === b.frames.length && a.frames.every((f, i) => f.key === b.frames[i].key)
}

/** True when next is the next step along from prev at the same cadence. */
export function isContinuation(prev: CloudPlan, next: CloudPlan): boolean {
  return (
    prev.mode === 'bracket' &&
    next.mode === 'bracket' &&
    prev.cadenceMs === next.cadenceMs &&
    next.frames.some((f) => prev.frames.some((p) => p.key === f.key))
  )
}

export interface PlanState {
  committed: CloudPlan | null
  /** Wall-clock ms of the last commit. */
  committedAt: number
  /** A plan waiting to settle, or null. */
  candidate: CloudPlan | null
  /** Wall-clock ms when the candidate (or the one it continues) was first
   * wanted. */
  since: number
}

export const initialPlanState: PlanState = {
  committed: null,
  committedAt: 0,
  candidate: null,
  since: 0,
}

/**
 * Decides when the wanted plan replaces the committed one. The first commits
 * at once, as does the next step along; a held frame is refreshed every
 * HOLD_REFRESH_MS once it has loaded (settled: ready or failed); anything
 * else must be wanted for SETTLE_MS, and then the builds it doesn't need are
 * aborted. Returns the same state object when nothing changed, so calling it
 * again in the same frame is a no-op.
 */
export function stepCloudPlan(
  prev: PlanState,
  next: CloudPlan,
  wallMs: number,
  { jumping, settled }: { jumping: boolean; settled: boolean }
): { state: PlanState; commit: CloudPlan | null; abortUnwanted: boolean } {
  const commit = (abortUnwanted: boolean) => ({
    state: { committed: next, committedAt: wallMs, candidate: null, since: wallMs },
    commit: next,
    abortUnwanted,
  })
  const keep = (state: PlanState) => ({ state, commit: null, abortUnwanted: false })
  const stay = () => keep(prev.candidate === null ? prev : { ...prev, candidate: null })

  const committed = prev.committed
  if (committed === null) return commit(false)
  if (samePlan(committed, next)) return stay()
  if (committed.mode === 'hold' && next.mode === 'hold' && !jumping) {
    return wallMs - prev.committedAt >= HOLD_REFRESH_MS && settled ? commit(false) : stay()
  }
  if (isContinuation(committed, next)) return commit(false)

  const candidate = prev.candidate
  const same = candidate !== null && samePlan(candidate, next)
  const since = same || (candidate !== null && isContinuation(candidate, next)) ? prev.since : wallMs
  if (wallMs - since >= SETTLE_MS) return commit(true)
  return same ? keep(prev) : keep({ ...prev, candidate: next, since })
}

/**
 * The two loaded frames to cross-fade for a sim time: the latest at or before
 * it and the earliest after, mix 0..1 between them. With only one of them, that
 * one alone. 'static' stands for the static clouds. Null while nothing has
 * loaded yet (keep showing what was there); static once everything failed.
 */
export function pickBlend<T>(
  frames: readonly FrameView<T>[],
  simMs: number
): { a: T | 'static'; b: T | 'static'; mix: number } | null {
  let before: FrameView<T> | null = null
  let after: FrameView<T> | null = null
  for (const f of frames) {
    if (f.status !== 'ready') continue
    if (f.timeMs <= simMs) {
      if (!before || f.timeMs > before.timeMs) before = f
    } else if (!after || f.timeMs < after.timeMs) {
      after = f
    }
  }
  const show = (f: FrameView<T>): T | 'static' =>
    f.source.kind === 'static' || f.texture === null ? 'static' : f.texture
  if (before && after) {
    const mix = (simMs - before.timeMs) / (after.timeMs - before.timeMs)
    return { a: show(before), b: show(after), mix: Math.min(1, Math.max(0, mix)) }
  }
  const only = before ?? after
  if (only) return { a: show(only), b: show(only), mix: 0 }
  if (frames.length > 0 && frames.every((f) => f.status === 'failed')) {
    return { a: 'static', b: 'static', mix: 0 }
  }
  return null
}
