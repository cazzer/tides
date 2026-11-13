// Lightning on Earth (tides-ufyr.13): the flashes a feed hands the renderer,
// the clock they play on, which of them a frame emits, and the TypeScript
// mirrors of the flicker the vertex shader plays
// (shaders/lightning/vertex.glsl; keep them in step). Source-agnostic: the
// GOES GLM feed (./glm-feed.ts) is one producer. No DOM.

/** One file's 20 s of flashes. */
export const WINDOW_MS = 20_000

/**
 * A window's flashes, sorted by offsetMs. Arrays are the batch's own (moved
 * out of the worker that parsed them).
 */
export interface FlashBatch {
  source: 'glm'
  /** Unique per window and producer (the GLM object key); seeds the flicker. */
  key: string
  /** The window's start, epoch ms; offsets are from it. */
  startMs: number
  count: number
  /** Degrees. */
  lat: Float32Array
  lon: Float32Array
  /** From startMs to the flash's first light, ms (may be negative). */
  offsetMs: Float32Array
  durationMs: Float32Array
  energyJ: Float32Array
  areaKm2: Float32Array
  /** 1 where this batch draws the flash (two satellites see some of the same). */
  owned: Uint8Array
}

/** What the renderer asks of a feed each frame (renderers/lightningFeed.ts). */
export interface LightningTick {
  /** lightningClock(), epoch ms. */
  clockMs: number
  /** windowStride() for the time speed. */
  stride: number
  /** The time speed (scene ms per wall ms), signed. */
  rate: number
  /** Wall clock, ms (monotonic). */
  wallMs: number
  /** Date.now(). */
  nowMs: number
  /** False: start no download (Earth off screen or too small, clouds hidden). */
  fetch: boolean
}

export interface LightningFeed {
  /** The batches to play, the same array every call. */
  tick(args: LightningTick): readonly FlashBatch[]
  /** Real weather off: drop in-flight downloads, keep what is loaded. */
  deactivate(): void
}

/** Live, the newest data plays this late: a file is posted ~10-30 s after its window ends. */
export const LIVE_LAG_MS = 60_000
/** Past now by more than this, the scene time is a forecast's (no GLM there). */
export const FUTURE_SLACK_MS = 2 * 60_000

/**
 * The time lightning plays at: the scene time, held LIVE_LAG_MS behind now
 * near the present so live play shows the newest files; a scene well in the
 * future stays as it is (nothing observed covers it).
 */
export function lightningClock(sceneMs: number, nowMs: number): number {
  if (sceneMs > nowMs + FUTURE_SLACK_MS) return sceneMs
  return Math.min(sceneMs, nowMs - LIVE_LAG_MS)
}

/**
 * Sped up, only every stride-th window plays, its 20 s stretched over the
 * stride's span, so no more than one file plays per ~5 s of wall time: a
 * power of two (1 at up to 4x) so windows stay aligned as the speed steps.
 */
export function windowStride(timeScale: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, (Math.abs(timeScale) * 5) / 20)))
}

/** The scene time a flash shows at, at this stride. */
export function displayMs(batch: FlashBatch, i: number, stride: number): number {
  return batch.startMs + batch.offsetMs[i] * stride
}

/** A clock step too big to be play (a jump or a scrub): emit nothing for it. */
export function isJump(fromMs: number, toMs: number, stride: number): boolean {
  return Math.abs(toMs - fromMs) > 2 * WINDOW_MS * stride
}

// First index whose display time is > t (strict) or >= t.
function lowerBound(batch: FlashBatch, stride: number, t: number, strict: boolean): number {
  let lo = 0
  let hi = batch.count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const d = displayMs(batch, mid, stride)
    if (strict ? d <= t : d < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Calls emit for each owned flash whose display time the clock crossed going
 * from fromMs to toMs: (from, to] forward, [to, from) backward. emit returns
 * false to stop (the frame's cap). Returns how many were emitted.
 */
export function emitCrossed(
  batch: FlashBatch,
  stride: number,
  fromMs: number,
  toMs: number,
  emit: (batch: FlashBatch, index: number) => boolean
): number {
  if (toMs === fromMs || batch.count === 0) return 0
  const forward = toMs > fromMs
  const start = forward ? lowerBound(batch, stride, fromMs, true) : lowerBound(batch, stride, toMs, false)
  const end = forward ? lowerBound(batch, stride, toMs, true) : lowerBound(batch, stride, fromMs, false)
  let n = 0
  for (let i = start; i < end; i++) {
    if (batch.owned[i] === 0) continue
    if (!emit(batch, i)) break
    n++
  }
  return n
}

// --- The flicker (vertex.glsl) ----------------------------------------------

export const FLASH_MIN_S = 0.1
export const FLASH_MAX_S = 0.4
/** After its last pulse a flash fades for this long, then is gone. */
export const FLASH_TAIL_S = 0.15
/** The longest a flash lives: FLASH_MAX_S + FLASH_TAIL_S. */
export const FLASH_LIFETIME_S = FLASH_MAX_S + FLASH_TAIL_S
export const PULSE_ATTACK_S = 0.005
export const PULSE_DECAY_S = 0.035
/** The day side's share of a flash's light. */
export const DAY_FLOOR = 0.08

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)
const fract = (x: number) => x - Math.floor(x)

/** How many pulses a flash with this seed plays: 1 to 3. */
export function pulseCount(seed: number): number {
  return 1 + Math.min(Math.floor(seed * 3), 2)
}

/**
 * A flash's brightness `ageS` after it starts, 0..1: 1-3 pulses (by seed)
 * spread over its duration (clamped to FLASH_MIN_S..FLASH_MAX_S), each a 5
 * ms rise and a 35 ms exponential fall, the later ones dimmer; nothing
 * before 0 or after the duration plus FLASH_TAIL_S.
 */
export function flashIntensity(ageS: number, durS: number, seed: number): number {
  const d = clamp(durS, FLASH_MIN_S, FLASH_MAX_S)
  if (ageS < 0 || ageS > d + FLASH_TAIL_S) return 0
  const n = pulseCount(seed)
  let intensity = 0
  for (let k = 0; k < 3; k++) {
    if (k >= n) break
    const a = ageS - (d * k) / n
    if (a < 0) continue
    const envelope = a < PULSE_ATTACK_S ? a / PULSE_ATTACK_S : Math.exp(-(a - PULSE_ATTACK_S) / PULSE_DECAY_S)
    const amplitude = k === 0 ? 1 : 0.5 + 0.4 * fract(seed * (k + 1) * 13.7)
    intensity = Math.max(intensity, amplitude * envelope)
  }
  return intensity
}

/** Brightness by optical energy: 1e-15 J (GLM's faintest) dim, 1e-12 J and up full. */
export function flashBrightness(energyJ: number): number {
  return clamp((Math.log10(Math.max(energyJ, 1e-30)) + 15) / 3, 0.15, 1)
}

/** The glow's radius by the flash's footprint: past its edge, as the cloud scatters it. */
export function flashRadiusKm(areaKm2: number): number {
  return clamp(Math.sqrt(Math.max(areaKm2, 0) / Math.PI) * 2.5, 8, 80)
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** The share of a flash's light left by daylight, by the Sun's cosine at it. */
export function dayFade(sunCos: number): number {
  return 1 + (DAY_FLOOR - 1) * smoothstep(-0.1, 0.15, sunCos)
}

/** The flicker's seed for flash `index` of a batch whose key hashes to keyHash: 0..1. */
export function flashSeed(keyHash: number, index: number): number {
  let h = (keyHash ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** FNV-1a of a batch key. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** The ring's size and the most flashes one frame starts: smaller on the low tier and on phones. */
export function lightningCaps(low: boolean): { capacity: number; perFrame: number } {
  return low ? { capacity: 256, perFrame: 24 } : { capacity: 1024, perFrame: 96 }
}
