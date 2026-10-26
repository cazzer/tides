// The cloud layer's geometry (tides-y2e): where the clouds sit above the
// ground, how high their tops reach, and where a sunbeam meets them. The GLSL
// in renderers/cloudShaders.ts mirrors these functions; keep them in step.
//
// Altitudes are scene units above the sea-level sphere, in the Earth's local
// frame (the cloud and ground meshes share it). The scene is compressed, so
// heights are exaggerated: terrain by the elevation map's displacement scale,
// cloud tops by CLOUD_UNITS_PER_KM. Lighting (sunset colour, the horizon dip)
// uses true kilometres instead, since those effects don't scale with the scene.
import { MAX_CLOUD_TOP_KM } from './geo-clouds'
import { DEFAULT_RELIEF, REFERENCE_RELIEF, RELIEF } from './relief'

export { MAX_CLOUD_TOP_KM }

export const EARTH_RADIUS_KM = 6371

/** The ground's displacementScale at REFERENCE_RELIEF (./relief.ts, 25x true
 * scale, the exaggeration the scene was first tuned at): scene units at grey
 * 1, the old 8-bit bump map's white. The others are in proportion. */
export const REFERENCE_TERRAIN_DISPLACEMENT = 0.075
/** The ground's displacementScale at the default relief (12x, 0.036). The
 * horizon map is baked at it (scripts/build-earth-horizon.mjs). */
export const DEFAULT_TERRAIN_DISPLACEMENT = REFERENCE_TERRAIN_DISPLACEMENT * (DEFAULT_RELIEF / REFERENCE_RELIEF)
/** The ground's displacementScale at this page's relief (?relief=, read once
 * at load). Everything that follows the drawn ground derives from it. With
 * the live terrain scale on (../terrain-scale.ts, ?blend=1, tides-zmw.9.5)
 * the ground is drawn lower near it, and this is the maximum bound: the
 * shells, the cloud layer's top and the flat deck stay sized for it. */
export const TERRAIN_DISPLACEMENT = REFERENCE_TERRAIN_DISPLACEMENT * (RELIEF / REFERENCE_RELIEF)
/** The ground's displacementScale at true scale (1x, 0.003): what the live
 * terrain scale (../terrain-scale.ts, tides-zmw.9.5) multiplies. */
export const TRUE_TERRAIN_DISPLACEMENT = REFERENCE_TERRAIN_DISPLACEMENT / REFERENCE_RELIEF
/** Kilometres of elevation per unit of grey: the old bump map's 1/39 km a
 * level, which the 16-bit elevation map (earth-dem.ts) keeps. */
export const TERRAIN_KM_PER_GREY = 255 / 39
/**
 * The highest the drawn ground stands, in metres, rounded up: the ground
 * texture's top level (renderers/earthDemTexture.ts, the limb sphere's
 * 512 × 256, as half floats) read at its texel corners, where the mesh's
 * vertices sit, which is the most any ground read stands (the base sphere's
 * coarser level and the cloud march's 256-wide one average lower). The same
 * on either tier: the 2k map's level of that size is the 4k map's to the
 * metre. A test checks it against the shipped maps. Its grey bounds the
 * cloud layer and the flat deck. The full maps' peaks (6.4 km) are higher
 * but only shade the ground; a streamed surface layer that draws them
 * (tides-zmw.9) must raise this.
 */
export const TERRAIN_MAX_METRES = 5385
export const TERRAIN_MAX_GREY = TERRAIN_MAX_METRES / (1000 * TERRAIN_KM_PER_GREY)

/**
 * Gap between the (smoothed) ground and a cloud's base: three times the
 * ship's EARTH_GROUND_CLEARANCE, so its floor (the ground's highest nearby
 * plus that) stays under the base over most lowland (tides-42p; at 0.006 it
 * did over almost none).
 */
export const CLOUD_CLEARANCE = 0.012
/** Cloud-top exaggeration: about 9x the true scale, whatever the terrain's
 * (true scale by default since tides-zmw.21, 12x before; ?relief=,
 * ./relief.ts). At a relief under about 8.7 the clouds are exaggerated more
 * than the ground they sit on, as they are at the default. */
export const CLOUD_UNITS_PER_KM = 0.004
/** Lowest top a measured cloud gets; daytime low cloud reads ~0 from IR. */
export const MIN_MEASURED_TOP_KM = 1

/** Highest a cloud top can reach: the outer bound of the relief march. */
export const CLOUD_LAYER_TOP =
  TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * MAX_CLOUD_TOP_KM

/** The low-quality path's single flat shell: the clearance over the highest
 * ground (tides-7oi), at a typical low-cloud top. */
export const CLOUD_FLAT_ALTITUDE =
  TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * 1.5

/** Where no satellite measured a top: thicker (brighter) cloud, taller tops. */
export function defaultTopKm(alpha: number): number {
  return 1.5 + 7 * alpha * alpha
}

/** The tallest top a texture can give, which bounds the relief march. */
export function maxTopKm(measured: boolean): number {
  return measured ? MAX_CLOUD_TOP_KM : defaultTopKm(1)
}

/**
 * Cloud-top height above the ground (km) from a texel: r = measured height
 * (0..1 of MAX_CLOUD_TOP_KM), coverage = how far r can be trusted (0..1),
 * alpha = cloud opacity. measured = 0 for textures that carry no heights.
 */
export function cloudTopKm(r: number, coverage: number, alpha: number, measured: number): number {
  const trust = coverage * measured
  const fromIr = Math.max(r * MAX_CLOUD_TOP_KM, MIN_MEASURED_TOP_KM)
  return defaultTopKm(alpha) * (1 - trust) + fromIr * trust
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** How much of its height a cloud's top keeps: thin edges sit low, so a
 * cloud is a dome rather than a slab. */
export function cloudShape(alpha: number): number {
  return 0.25 + 0.75 * smoothstep(0, 0.65, alpha)
}

/** A cloud column: base and top altitudes over ground of the given grey,
 * drawn at `displacement` (the ground's displacementScale: TERRAIN_DISPLACEMENT
 * at the full relief; with the live terrain scale on, ../terrain-scale.ts
 * liveTerrainDisplacement(), which the cloud GLSL follows, tides-zmw.9.6).
 * The base follows the ground; the top stands CLOUD_UNITS_PER_KM over it. */
export function cloudColumn(
  alpha: number,
  topKm: number,
  terrainGrey: number,
  displacement: number
): { base: number; top: number } {
  const base = terrainGrey * displacement + CLOUD_CLEARANCE
  return { base, top: base + CLOUD_UNITS_PER_KM * topKm * cloudShape(alpha) }
}

/** The faintest cloud drawn: a column under it is a gap in the deck. */
export const CLOUD_MIN_ALPHA = 0.02

/** How far down its column a point at `altitude` lies: 0 at the top, 1 at
 * the base. Undersides and the lower sides of gaps shade darker by it
 * (tides-01v.8.5). */
export function columnDepth(altitude: number, base: number, top: number): number {
  return Math.min(1, Math.max(0, (top - altitude) / Math.max(top - base, 1e-6)))
}

/** How much light crosses `path` scene units of a column of opacity `alpha`
 * (top to bottom) and `thickness`: the cloud past a side, seen across. */
export function cloudPathClear(alpha: number, thickness: number, path: number): number {
  return (1 - Math.min(alpha, 0.995)) ** (path / Math.max(thickness, 1e-4))
}

/** How far along a stretch of even cloud that lets `clear` through (0..1 of
 * the stretch) the light it sends back comes from on average: half way
 * through a thin one, nearer its front the thicker it is. The march from
 * inside shades a side, a base met from below or a veil from there
 * (shadeAdd(), tides-tvr.1). */
export function lightCentroid(clear: number): number {
  const c = Math.max(clear, 1e-6)
  const tau = -Math.log(c)
  return tau < 0.05 ? 0.5 - tau / 12 : 1 / tau - c / (1 - c)
}

/** Where the light a hit sends back comes from (cloudShaders.ts'
 * FLIP_SIDED march, tides-tvr.1): sums, by each stretch's share of the light,
 * of its depth down its column (columnDepth()), its distance along the ray,
 * and its column's top and base, and those shares. */
export interface ShadeSum {
  weight: number
  depth: number
  distance: number
  top: number
  base: number
}

/** A stretch of the march through cloud from `from` to `to` (its column and
 * the ray's altitude taken to change linearly between, as the crossing takes
 * them), at distances `s0` and `s1` along the ray, sending back `light`:
 * added to `sum` as from `t` of the way, its light's centroid
 * (lightCentroid()). cloudShaders.ts cloudShadeAdd(). */
export function shadeAdd(
  sum: ShadeSum,
  light: number,
  from: MarchSample,
  to: MarchSample,
  s0: number,
  s1: number,
  t: number
): void {
  const at = (a: number, b: number) => a + (b - a) * t
  const top = at(from.top, to.top)
  const base = at(from.base, to.base)
  sum.weight += light
  sum.depth += light * columnDepth(at(from.alt, to.alt), base, top)
  sum.distance += light * at(s0, s1)
  sum.top += light * top
  sum.base += light * base
}

/** Where a hit is shaded from: the sides and veils the march went through
 * (`sum`), with a top or flank at the end of it by `hitLight` (what of it
 * shows past the veils; 0 for a side), at its own `hit` place. Null where
 * nothing sends any light back. */
export function shadePlace(
  sum: ShadeSum,
  hitLight: number,
  hit: Omit<ShadeSum, 'weight'>
): Omit<ShadeSum, 'weight'> | null {
  const w = sum.weight + hitLight
  if (!(w > 0)) return null
  const mean = (a: number, b: number) => (a + hitLight * b) / w
  return {
    depth: mean(sum.depth, hit.depth),
    distance: mean(sum.distance, hit.distance),
    top: mean(sum.top, hit.top),
    base: mean(sum.base, hit.base),
  }
}

/** The path over which fog in opaque cloud stops its opacity's share of
 * the light, whatever the column's height: under a march step, as real
 * cloud is far denser inside than its opacity from above suggests. */
export const FOG_PATH = 0.004

/** How far into its column (as a share of its thickness) fog thickens from
 * nothing at the top and base: a soft edge (tides-01v.8.6). */
export const FOG_SOFT = 0.15

/**
 * With reduced motion, the seconds over which fog thickens after the eye
 * enters a cloud (tides-01v.8.15), from the cloud as its side looked from
 * just outside (cloudPathClear()) to the fog's own (fogExtinction()); and
 * how many points back along the eye's path over that time the shader
 * reads to tell how long it has been in. So flying in fades in time, never
 * flashing, at any speed, and never shows what lay past the wall; a still
 * eye's fog is the same either way.
 */
export const FOG_EASE_SECONDS = 0.8
export const FOG_EASE_SAMPLES = 6

/**
 * Fog's extinction (per scene unit) at `altitude` in a column, for an eye
 * inside a cloud (tides-01v.8.6): the column's optical depth over
 * FOG_PATH, and as patchy as the cloud is thin (times its opacity), so
 * dense cloud whites out and thin cloud only veils. It thins to nothing at
 * the column's top and base over `soft` of its thickness. None outside it,
 * or where it is a gap.
 */
export function fogExtinction(alpha: number, base: number, top: number, altitude: number): number {
  const inside = Math.min(altitude - base, top - altitude)
  if (alpha < CLOUD_MIN_ALPHA || inside <= 0) return 0
  const thickness = top - base
  return (
    ((alpha * -Math.log(1 - Math.min(alpha, 0.995))) / FOG_PATH) *
    smoothstep(0, FOG_SOFT * thickness, inside)
  )
}

/**
 * The fog's extinction as it eases in (ease 0 to 1, FOG_EASE_SECONDS): from
 * cloudPathClear()'s, the side's, to fogExtinction().
 */
export function easedFogExtinction(
  alpha: number,
  base: number,
  top: number,
  altitude: number,
  ease: number
): number {
  const fog = fogExtinction(alpha, base, top, altitude)
  const inside = Math.min(altitude - base, top - altitude)
  if (ease >= 1 || alpha < CLOUD_MIN_ALPHA || inside <= 0) return fog
  const side = -Math.log(1 - Math.min(alpha, 0.995)) / Math.max(top - base, 1e-4)
  return side + (fog - side) * ease
}

/**
 * How far fog has eased in (0 to 1, smoothed) for a march whose start is
 * `insideNow` inside its cloud (in column thicknesses, at most 0 outside),
 * and was `insidePast` inside where the eye was at evenly spaced times over
 * FOG_EASE_SECONDS back (newest first): the share of that time since it
 * was last out, read between the samples. Mirrored by cloudShaders.ts
 * cloudFogEase().
 */
export function fogEaseShare(insideNow: number, insidePast: readonly number[]): number {
  if (insideNow <= 0) return 0
  let prev = insideNow
  for (let k = 0; k < insidePast.length; k++) {
    const inside = insidePast[k]
    if (inside <= 0) return smoothstep(0, 1, (k + prev / (prev - inside)) / insidePast.length)
    prev = inside
  }
  return 1
}

/** A point on the eye's path: seconds, and where. */
export interface EyeSample {
  t: number
  p: Vec3
}

/**
 * Where the eye was at `count` times over the last `seconds`, (k + 1) /
 * count of them back, less where it is now (the newest of `track`, oldest
 * first, which holds at least one sample), read between its samples;
 * before the oldest, there.
 */
export function eyePastOffsets(
  track: readonly EyeSample[],
  seconds: number,
  count: number
): Vec3[] {
  const now = track[track.length - 1]
  const offsets: Vec3[] = []
  let i = track.length - 1
  for (let k = 0; k < count; k++) {
    const t = now.t - ((k + 1) / count) * seconds
    while (i > 0 && track[i].t > t) i--
    const a = track[i]
    const b = track[Math.min(i + 1, track.length - 1)]
    const w = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0
    offsets.push([0, 1, 2].map((j) => a.p[j] + (b.p[j] - a.p[j]) * w - now.p[j]) as Vec3)
  }
  return offsets
}

/** One step of the cloud march: its altitude, and its column's base, top
 * and opacity there. */
export interface MarchSample {
  alt: number
  base: number
  top: number
  alpha: number
}

/** A crossing the march meets: how far from one step to the next (0..1)
 * the ray goes into the cloud and how far it is still in it, whether it
 * goes on through it as through a side, and a top's depth down its column. */
export interface MarchHit {
  at: number
  until: number
  side: boolean
  depth: number | null
}

/** The stretch (from, until) of a step over which a quantity changing
 * linearly from f0 to f1 is at most 0; from > until where it is nowhere. */
function spanAtMost0(f0: number, f1: number): [number, number] {
  if (f0 <= 0 && f1 <= 0) return [0, 1]
  if (f0 > 0 && f1 > 0) return [1, 0]
  const w = f0 / (f0 - f1)
  return f0 > 0 ? [w, 1] : [0, w]
}

/**
 * Whether the march from inside the shell (cloudShaders.ts' FLIP_SIDED
 * branch) meets cloud between two steps (tides-01v.8.12): with the ray's
 * altitude and the column taken to change linearly over the step, where the
 * ray first is under the top, over the base and where the cloud shows
 * (at least CLOUD_MIN_ALPHA), having been outside it at the last step. Down
 * through a top, a top (unless the column's top rose past the ray's height
 * between the steps); otherwise, up through a base or into cloud coming up
 * to showing beside it, the ray goes on through it as through a side. Null
 * where the ray carries on. `fromAbove`, for a camera above the tops around
 * it (the shader reads them from a coarse mip): as from outside, a top is
 * met however faint, and is never a side.
 */
export function marchCrossing(
  prev: MarchSample,
  next: MarchSample,
  fromAbove = false
): MarchHit | null {
  const underTop = spanAtMost0(prev.alt - prev.top, next.alt - next.top)
  const overBase = spanAtMost0(prev.base - prev.alt, next.base - next.alt)
  const shows: [number, number] =
    fromAbove && prev.alt > prev.top
      ? [0, 1]
      : spanAtMost0(CLOUD_MIN_ALPHA - prev.alpha, CLOUD_MIN_ALPHA - next.alpha)
  const at = Math.max(underTop[0], overBase[0], shows[0])
  const until = Math.min(underTop[1], overBase[1], shows[1])
  if (at <= 0 || at > until) return null
  const side =
    at !== underTop[0] || (!fromAbove && prev.alt <= next.top && prev.alt >= next.base)
  return { at, until, side, depth: side ? null : 0 }
}

/**
 * Where within a step the march from inside meets a top it went down
 * through (marchCrossing() with side false; cloudShaders.ts, after the
 * march, tides-ndh), pinned to the field rather than to the field taken
 * linear over the step, which lands wherever the steps fall: from `prev`
 * (over the top) to `next` (at or under it), each of `iterations` reads
 * (`sampleAt`, of a share of the step) halves the stretch where the ray's
 * height over the top changes sign, and the crossing is solved linearly on
 * the last; within 2^-iterations of a step of where the ray meets the top.
 * No further than `until`, where the step has the ray leave the cloud. As a
 * share of the step.
 */
export function refineTopCrossing(
  prev: MarchSample,
  next: MarchSample,
  sampleAt: (w: number) => MarchSample,
  iterations: number,
  until = 1
): number {
  let lo = 0
  let hi = 1
  let gLo = prev.alt - prev.top
  let gHi = next.alt - next.top
  for (let k = 0; k < iterations; k++) {
    const mid = (lo + hi) / 2
    const m = sampleAt(mid)
    const g = m.alt - m.top
    if (g <= 0) {
      hi = mid
      gHi = g
    } else {
      lo = mid
      gLo = g
    }
  }
  return Math.min(lo + ((hi - lo) * gLo) / (gLo - gHi), until)
}

export type Vec3 = [number, number, number]

/**
 * Texture coordinates of a local direction, matching THREE.SphereGeometry:
 * u = 0.5 (Greenwich) at local +X, east toward -Z; v = 1 at the north (+Y).
 */
export function directionToUv([x, y, z]: Vec3): [number, number] {
  const u = Math.atan2(z, -x) / (2 * Math.PI)
  return [u - Math.floor(u), 0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI]
}

/**
 * Distance along a ray from radius r0, at sine-of-elevation mu, to where it
 * reaches radius r (outward). r must be at least r0.
 */
export function distanceToRadius(r0: number, mu: number, r: number): number {
  return -r0 * mu + Math.sqrt(r0 * r0 * (mu * mu - 1) + r * r)
}

/** The stretch of a view ray the march from inside covers
 * (marchSpanFromEye()): from where it starts and its steps count from. */
export interface MarchSpan {
  origin: number
  end: number
}

/**
 * The stretch of a view ray the cloud march covers within the ship camera's
 * reach of the shell (tides-01v.8.4; cloudShaders.ts' FLIP_SIDED branch), as
 * distances along the unit `dir` from `eye` (both in the body's frame, about
 * its centre): from its `origin`, the eye, or from outside `outer`, where the
 * ray comes within it, to where it leaves that sphere or, if it goes on to
 * meet the sea, drops below the lowest base anywhere, or from below that,
 * meets the sea (one that skims over the sea comes back up under the deck).
 * Not from the near plane (tides-tvr.1): what the ray starts in, and what it
 * meets short of the near plane, would then hang on where the near plane
 * cuts it; the near plane only bounds the depth a hit is drawn at. Null when
 * the ray never comes within `outer`.
 */
export function marchSpanFromEye(
  eye: Vec3,
  dir: Vec3,
  seaLevel: number,
  outer: number
): MarchSpan | null {
  const b = eye[0] * dir[0] + eye[1] * dir[1] + eye[2] * dir[2]
  const eye2 = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]
  const discOuter = b * b - (eye2 - outer * outer)
  if (discOuter <= 0) return null
  const toOuter = -b - Math.sqrt(discOuter)
  const origin = Math.max(toOuter, 0)
  let end = -b + Math.sqrt(discOuter)
  const inner = seaLevel + CLOUD_CLEARANCE
  const discInner = b * b - (eye2 - inner * inner)
  const discSea = b * b - (eye2 - seaLevel * seaLevel)
  const toSea = -b - Math.sqrt(Math.max(discSea, 0))
  if (discSea > 0 && toSea > 0) {
    // From below every base, the sea itself.
    const toInner = -b - Math.sqrt(discInner)
    end = toInner > origin ? toInner : toSea
  }
  return end > origin ? { origin, end } : null
}

/**
 * Where along the ray the march from inside reads (cloudShaders.ts'
 * FLIP_SIDED branch, without the steps the cloud ceiling lets it leave out):
 * its origin, then steps of `step` from there, `phase` of a step short
 * (vMarchPhase, tides-ndh: uMarchPhase, moved on with the eye in flight,
 * times marchPhaseShare() of the fog at the eye), the last cut
 * short at its end (tides-16z). At least three steps over the span, and no
 * more than `maxSteps`, but for one more where the phase pushes the last
 * past them. From the eye, with no near plane in them (tides-tvr.1), a
 * ray's steps, the first too, hold still as the camera turns about it.
 */
export function marchSteps(
  { origin, end }: MarchSpan,
  step: number,
  maxSteps: number,
  phase = 0
): number[] {
  const span = end - origin
  const ds = Math.max(Math.min(step, span / 3), span / maxSteps)
  const steps = Math.min(Math.max(Math.ceil(span / ds + phase - 1e-3), 1), maxSteps + 1)
  const at = [origin]
  for (let i = 1; i <= steps; i++) at.push(Math.min(origin + ds * (i - phase), end))
  return at
}

/** How far around a point (degrees of arc) its cloud ceiling holds. */
export const CEILING_ARC_DEG = 2
/** Texels across the elevation map's mip the cloud march reads its ground
 * from (cloudShaders.ts cloudTerrain()). */
export const TERRAIN_READ_TEXELS = 256
/** Grey levels (of 255) added to the ceiling, over the ground's half-float
 * rounding on the GPU (under 0.07 of a level up to grey 1). */
export const CEILING_GREY_MARGIN = 0.5

/**
 * How far a straight path can run from a point and stay within the
 * ceiling's arc of it, where it never comes nearer the centre than
 * `seaLevel`: the chord of the arc at that radius.
 */
export function ceilingReach(seaLevel: number, arcDeg = CEILING_ARC_DEG): number {
  return 2 * seaLevel * Math.sin((arcDeg * Math.PI) / 360)
}

/**
 * The highest of each element of a row that wraps around and the `half`
 * either side of it, into `into`: van Herk's running maxima over blocks of
 * the window's width, forward and back, so the cost doesn't grow with it.
 */
function wrappedWindowMax(row: Float32Array, half: number, into: Float32Array): void {
  const n = row.length
  const size = 2 * half + 1
  if (size >= n) {
    into.fill(row.reduce((a, b) => Math.max(a, b), 0))
    return
  }
  // The row from half before its start to half past its end.
  const length = n + 2 * half
  const at = (k: number) => row[(k - half + n) % n]
  const ahead = new Float32Array(length)
  const behind = new Float32Array(length)
  for (let k = 0; k < length; k++) ahead[k] = k % size ? Math.max(ahead[k - 1], at(k)) : at(k)
  for (let k = length - 1; k >= 0; k--) {
    behind[k] = (k + 1) % size && k + 1 < length ? Math.max(behind[k + 1], at(k)) : at(k)
  }
  for (let i = 0; i < n; i++) into[i] = Math.max(behind[i], ahead[i + size - 1])
}

/**
 * The cloud ceiling (tides-01v.8.10), from the elevation map max-pooled to
 * `width` × `height` (earth-dem-max.bin as grey, 1 at TERRAIN_DISPLACEMENT;
 * rows north first, columns from −180° east): for each of its texels, a
 * grey level (of 255, rounded up, with CEILING_GREY_MARGIN) that no ground
 * the cloud march reads within `arcDeg` of any point in it rises above, so
 * no cloud top there stands above that grey's ground plus the clearance and
 * the tallest top. The march from inside the shell (cloudShaders.ts) skips
 * what lies above it.
 *
 * The march reads the ground bilinearly from the elevation map's
 * TERRAIN_READ_TEXELS-wide mip, whose texels average the ones the pooled
 * texels hold the max of; its taps reach 1½ of them from the point. Texels
 * within the arc are found centre to centre, with each one's reach from its
 * centre to its corners added.
 *
 * Not called at runtime: scripts/build-cloud-ceiling.mjs ships its output
 * as earth-cloud-ceiling.bin, and a test checks the two agree.
 */
export function cloudCeiling(
  pooled: Float32Array,
  width: number,
  height: number,
  arcDeg = CEILING_ARC_DEG
): Uint8Array<ArrayBuffer> {
  const row = (grid: Float32Array, j: number) => grid.subarray(j * width, (j + 1) * width)
  // The highest ground a read from each texel can see.
  const read = Math.ceil((1.5 * width) / TERRAIN_READ_TEXELS)
  const rows = new Float32Array(width * height)
  for (let j = 0; j < height; j++) wrappedWindowMax(row(pooled, j), read, row(rows, j))
  const seen = new Float32Array(width * height)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let max = 0
      for (let dj = Math.max(0, j - read); dj <= Math.min(height - 1, j + read); dj++) {
        max = Math.max(max, rows[dj * width + i])
      }
      seen[j * width + i] = max
    }
  }
  // Then the highest within the arc.
  const dLon = (2 * Math.PI) / width
  const dLat = Math.PI / height
  const lat = (j: number) => Math.PI / 2 - (j + 0.5) * dLat
  const arc = (lat0: number, lat1: number, lon: number) =>
    Math.acos(
      Math.min(1, Math.sin(lat0) * Math.sin(lat1) + Math.cos(lat0) * Math.cos(lat1) * Math.cos(lon))
    )
  const corner = Array.from({ length: height }, (_, j) =>
    Math.max(arc(lat(j), lat(j) + dLat / 2, dLon / 2), arc(lat(j), lat(j) - dLat / 2, dLon / 2))
  )
  const highest = new Float32Array(width * height)
  const within = new Float32Array(width)
  for (let j = 0; j < height; j++) {
    const into = row(highest, j)
    for (let j2 = 0; j2 < height; j2++) {
      const reach = (arcDeg * Math.PI) / 180 + corner[j] + corner[j2]
      if (Math.abs(lat(j) - lat(j2)) > reach) continue
      // The longitudes within reach, the same for every texel of the row.
      const c = Math.cos(lat(j)) * Math.cos(lat(j2))
      const cosLon = c > 1e-9 ? (Math.cos(reach) - Math.sin(lat(j)) * Math.sin(lat(j2))) / c : -1
      const span = cosLon <= -1 ? width : Math.ceil(Math.acos(Math.min(1, cosLon)) / dLon)
      wrappedWindowMax(row(seen, j2), span, within)
      for (let i = 0; i < width; i++) into[i] = Math.max(into[i], within[i])
    }
  }
  return Uint8Array.from(highest, (grey) => Math.min(255, Math.ceil(grey * 255 + CEILING_GREY_MARGIN)))
}

/**
 * Where a sunbeam to the ground point (unit direction `ground`, at radius r0)
 * crosses the altitude `altitude` above radius `seaLevel`: the cloud that
 * would shade the point from there. Toward the Sun, by about
 * height·tan(zenith) when the Sun is high.
 */
export function shadowCaster(
  ground: Vec3,
  sun: Vec3,
  r0: number,
  seaLevel: number,
  altitude: number
): Vec3 {
  const mu = ground[0] * sun[0] + ground[1] * sun[1] + ground[2] * sun[2]
  const t = distanceToRadius(r0, mu, seaLevel + altitude)
  const p: Vec3 = [
    ground[0] * r0 + sun[0] * t,
    ground[1] * r0 + sun[1] * t,
    ground[2] * r0 + sun[2] * t,
  ]
  const len = Math.hypot(...p)
  return [p[0] / len, p[1] / len, p[2] / len]
}

/** Sine of how far below the horizon the Sun can be and still light a cloud
 * top at heightKm (true scale). */
export function horizonDipSin(heightKm: number): number {
  const c = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(0, heightKm))
  return Math.sqrt(Math.max(0, 1 - c * c))
}

/** Kasten & Young's relative air mass at sine-of-elevation mu, held at the
 * horizon's for a Sun below it. */
export function airMass(mu: number): number {
  const zenith = Math.min(90, (Math.acos(Math.max(-1, Math.min(1, mu))) * 180) / Math.PI)
  return 1 / (Math.cos((zenith * Math.PI) / 180) + 0.50572 * (96.07995 - zenith) ** -1.6364)
}

/** Vertical optical depth (red, green, blue) at sea level: Rayleigh plus a
 * little haze, softened a touch for taste. */
export const SUNLIGHT_EXTINCTION: Vec3 = [0.045, 0.1, 0.22]
const SCALE_HEIGHT_KM = 8

/** Sunset light keeps at least this much of its red's brightness: the low
 * Sun's light on cloud still glows a little, but dimmer than noon (at 1 it
 * would be the plain extinction). */
export const SUNSET_FLOOR = 0.75

/** The lowest air a grazing sunbeam can cross: haze and low cloud below it
 * block the beam, so a cloud top loses the Sun when its beam would pass
 * closer to the ground than this (km). */
export const SUNBEAM_FLOOR_KM = 2

/** Sine of how far below the cloud top's horizon the Sun can be before its
 * beam would graze SUNBEAM_FLOOR_KM: the end of a top's sunset. */
export function sunsetDipSin(heightKm: number): number {
  return horizonDipSin(Math.max(0, heightKm) - SUNBEAM_FLOOR_KM)
}

/** How much of the Sun a cloud top sees, 0..1: all of it until just before
 * sunsetDipSin, softened over about the Sun's disc and refraction. */
export function sunVisibility(mu: number, heightKm: number): number {
  return smoothstep(-0.01, 0.01, mu + sunsetDipSin(heightKm))
}

/** The height (km) where a sunbeam to a point heightKm up passes closest to
 * the ground: the point itself while the Sun is above its horizon, lower
 * once the Sun has set there. */
export function sunbeamTangentKm(mu: number, heightKm: number): number {
  const h = Math.max(0, heightKm)
  if (mu >= 0) return h
  return (EARTH_RADIUS_KM + h) * Math.sqrt(1 - mu * mu) - EARTH_RADIUS_KM
}

/** Air masses a sunbeam to a cloud top crosses beyond the overhead Sun's
 * one: Kasten & Young's above the horizon, thinned for the top's height;
 * below it, the beam grazes the ground at sunbeamTangentKm and crosses the
 * dense air on both sides of that point, so it reddens and dims fast. */
export function sunbeamAirMass(mu: number, heightKm: number): number {
  const h = Math.max(0, heightKm)
  const thin = (km: number) => Math.exp(-Math.max(0, km) / SCALE_HEIGHT_KM)
  if (mu >= 0) return (airMass(mu) - 1) * thin(h)
  const tangent = sunbeamTangentKm(mu, h)
  return (airMass(0) - 1) * thin(tangent) * (2 - thin(h - tangent))
}

/** Sunlight's colour reaching a cloud top: white with the Sun overhead,
 * reddening toward the terminator. It keeps the colour of the extinction and
 * most of its dimming (down to SUNSET_FLOOR the red is lifted back), so the
 * terminator shows a thin, dim band of warm light rather than a bright one. */
export function sunlightTint(mu: number, heightKm: number): Vec3 {
  const m = sunbeamAirMass(mu, heightKm)
  const t = SUNLIGHT_EXTINCTION.map((tau) => Math.exp(-tau * m))
  const norm = Math.max(t[0], SUNSET_FLOOR)
  return t.map((c) => c / norm) as Vec3
}

// Fine detail where the cloud map is magnified (tides-01v.2): octaves of noise
// from DETAIL_BASE_TEXELS cloud texels down, each halving the last, each
// faded out as it shrinks toward a few screen pixels so none of it sparkles.
// From further out than the map's own resolution, no octave survives.

/** The coarsest octave's wavelength, in cloud-map texels. */
export const DETAIL_BASE_TEXELS = 2
/** An octave is whole down to 1/start pixels a wave and gone by 1/end. */
export const DETAIL_FADE_START = 1 / 6
export const DETAIL_FADE_END = 1 / 3
/** Octaves for the relief march; the low-quality flat shell takes fewer. */
export const DETAIL_OCTAVES = 6
export const DETAIL_OCTAVES_FLAT = 3

/** How much of an octave of `wavelength` shows at a pixel `footprint` wide
 * (both scene units), 0..1. */
export function detailOctaveWeight(footprint: number, wavelength: number): number {
  return 1 - smoothstep(DETAIL_FADE_START, DETAIL_FADE_END, footprint / wavelength)
}

/** The weight of each octave that shows, coarsest first, for a cloud map of
 * `texel` scene units seen at `footprint`. */
export function detailOctaveWeights(footprint: number, texel: number, octaves: number): number[] {
  const weights: number[] = []
  let wavelength = DETAIL_BASE_TEXELS * texel
  for (let k = 0; k < octaves; k++) {
    const weight = detailOctaveWeight(footprint, wavelength)
    if (weight <= 0) break
    weights.push(weight)
    wavelength /= 2
  }
  return weights
}

/** A local direction turned into the clouds' own frame for a drift of
 * `turns` (uCloudShift): directionToUv of the result is the texture
 * coordinate the cloud there was painted at. The detail noise lives here. */
export function cloudFrame([x, y, z]: Vec3, turns: number): Vec3 {
  const c = Math.cos(2 * Math.PI * turns)
  const s = Math.sin(2 * Math.PI * turns)
  return [x * c - z * s, y, z * c + x * s]
}

/** The static clouds drift east at this many radians per frame. */
export const STATIC_DRIFT_PER_FRAME = 0.0001

/** Texture-u offset of the static clouds after a drift of `radians`: the
 * cloud seen at Earth u was painted at u - offset. */
export function driftOffset(radians: number): number {
  const u = radians / (2 * Math.PI)
  return u - Math.floor(u)
}
