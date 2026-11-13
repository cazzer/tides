// A lightning flash's patch of lit cloud (tides-ufyr.13.1): a soft,
// irregular ellipse lying on the cloud deck's tangent plane, so it
// foreshortens toward the limb, its on-screen size held between a floor and
// a cap. These mirror shaders/lightning/vertex.glsl; keep them in step.
import * as THREE from 'three'

/** The smallest a flash's patch is drawn (its major half-axis), CSS px. */
export const MIN_FLASH_PX = 2.5
/** [TUNE] The largest a flash's major half-axis is drawn, as a share of the viewport's shorter side. */
export const MAX_FLASH_FRACTION = 0.06
/** [TUNE] The thinnest a patch seen edge-on at the limb is drawn, CSS px. */
export const MIN_EDGE_PX = 1
/** [TUNE] A flash under clear sky keeps this much of its light (no cloud to light). */
export const CLEAR_FLOOR = 0.3
/** [TUNE] A flash under the thickest cloud keeps this much of its light. */
export const THICK_FLOOR = 0.7

/** The main lobe's radius, in the quad's half-widths (vUv). */
export const LOBE_MAIN_RADIUS = 0.6
/** How far out from the quad's centre the other lobes reach (centre offset plus radius), vUv. */
export const LOBE_REACH = 0.84

const fract = (x: number) => x - Math.floor(x)

/** One of a patch's lobes, in vUv (the quad's half-widths, minor axis squashed). */
export interface FlashLobe {
  x: number
  y: number
  radius: number
  /** Its light; the main lobe's (the core's) is 1, the brightest. */
  weight: number
}

export interface FlashShape {
  /** The major axis' turn from local east toward north, radians. */
  angle: number
  /** Major over minor half-axis, 1..1.6. */
  aspect: number
  /** Where in the noise its footprint is cut from. */
  noiseX: number
  noiseY: number
  /** The main lobe, then two smaller, dimmer ones across from it. */
  lobes: [FlashLobe, FlashLobe, FlashLobe]
}

function outerLobe(lobeAngle: number, reachSeed: number, turn: number, weightSeed: number): FlashLobe {
  const reach = 0.3 + 0.2 * reachSeed
  const angle = lobeAngle + turn
  return { x: reach * Math.cos(angle), y: reach * Math.sin(angle), radius: LOBE_REACH - reach, weight: 0.45 + 0.4 * weightSeed }
}

/** A flash's shape from its flicker seed (0..1). */
export function flashShape(seed: number): FlashShape {
  const lobeAngle = 2 * Math.PI * fract(seed * 3.7)
  const offset = 0.15 * fract(seed * 7.3)
  return {
    angle: 2 * Math.PI * fract(seed * 97.31),
    aspect: 1 + 0.6 * fract(seed * 61.7),
    noiseX: fract(seed * 13.1) * 64,
    noiseY: fract(seed * 29.7) * 64,
    lobes: [
      { x: offset * Math.cos(lobeAngle), y: offset * Math.sin(lobeAngle), radius: LOBE_MAIN_RADIUS, weight: 1 },
      outerLobe(lobeAngle, fract(seed * 17.9), 2.1 + 0.8 * fract(seed * 23.3), fract(seed * 47.3)),
      outerLobe(lobeAngle, fract(seed * 37.1), -2.1 - 0.8 * fract(seed * 41.9), fract(seed * 53.9)),
    ],
  }
}

const POLE_Y = 0.9999

/**
 * The tangent plane at unit direction `dir` (Earth's local frame, +Y the
 * pole), local east and north turned by `angle` toward north: outE1 × outE2
 * = dir. Near a pole, where east is undefined, it starts from -Z (east at
 * longitude 0).
 */
export function flashTangentBasis(dir: THREE.Vector3, angle: number, outE1: THREE.Vector3, outE2: THREE.Vector3): void {
  // outE1 holds east, outE2 north, until the turn.
  if (Math.abs(dir.y) > POLE_Y) outE1.set(0, 0, -1)
  else outE1.set(dir.z, 0, -dir.x) // (0, 1, 0) × dir
  outE1.addScaledVector(dir, -outE1.dot(dir)).normalize()
  outE2.crossVectors(dir, outE1)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const { x: ex, y: ey, z: ez } = outE1
  const { x: nx, y: ny, z: nz } = outE2
  outE1.set(c * ex + s * nx, c * ey + s * ny, c * ez + s * nz)
  outE2.set(c * nx - s * ex, c * ny - s * ey, c * nz - s * ez)
}

/**
 * A patch's major half-axis, in world units, from its true one
 * (`worldMajor`: the shader's trueMajor, aFlash.w · uKmToScene · √aspect) at `pxWorld` world units a CSS px, in a `vw` × `vh` CSS px
 * viewport: no smaller than MIN_FLASH_PX, no bigger than MAX_FLASH_FRACTION
 * of the shorter side (the cap wins). `capped` when the cap applied.
 */
export function flashHalfSize(worldMajor: number, pxWorld: number, vw: number, vh: number): { major: number; capped: boolean } {
  const floored = Math.max(worldMajor, MIN_FLASH_PX * pxWorld)
  const cap = MAX_FLASH_FRACTION * Math.min(vw, vh) * pxWorld
  return { major: Math.min(floored, cap), capped: cap < floored }
}

/**
 * The shear that keeps a patch seen at `mu` (the cosine between its normal
 * and the view) at least `minMu` thick: the corners move along the normal
 * by this much of their offset toward the eye (pivoted about the near edge,
 * so none sinks under the deck), so it is seen as if at
 * mu + t·√(1 − mu²) = max(mu, minMu). The shader takes minMu from the
 * minor half-axis, the thinner whichever way the patch is turned, so
 * conservatively: MIN_EDGE_PX · pxWorld / minor.
 */
export function limbShear(mu: number, minMu: number): number {
  return Math.max(0, minMu - mu) / Math.max(Math.sqrt(1 - mu * mu), 1e-3)
}

/** Texture u unwrapped to within half a turn of `centreU`, so a patch across the seam has no jump. */
export function unwrapU(u: number, centreU: number): number {
  const d = u - centreU
  return centreU + d - Math.floor(d + 0.5)
}
