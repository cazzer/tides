// The waves bent toward shallow water (tides-nh8.3): over the shelf a wave
// slows as the bottom comes up within about half its wavelength, so its
// crests swing round to meet the coast nearly head-on (Snell: the part of
// its wavenumber along the depth contours holds, its speed falls). From the
// depth map the water's body already reads (./waterDepth.ts: ETOPO, ~10 km
// texels at 4k), on the CPU at the eye, as the waves are aimed there
// (./water.ts aimWaves()): each wave's heading from the climate is turned
// for the depth and the up-slope direction under the eye, as if it had come
// in from deep water over straight contours. The depth's gradient, not a
// distance to land: over deep water nothing turns, so no wave is aimed at a
// cliff it can't feel. The map's texels can't resolve coves and reefs, and
// this doesn't pretend to.
import { climateUv } from './waterClimateLayout'
import { WATER_DEPTH_MAX } from './waterDepth'

/** The depth map's grey levels (rows north first, columns from -180 deg
 * east, texel centred), sqrt-encoded as ./waterDepth.ts encodeWaterDepth. */
export interface DepthGrid {
  width: number
  height: number
  levels: Uint8Array
}

const grids = new WeakMap<object, DepthGrid>()

/** The grey levels of a loaded depth map (its red channel), read once per
 * image; null while it has none. */
export function depthGridOf(image: (CanvasImageSource & { width: number; height: number }) | null | undefined): DepthGrid | null {
  if (!image || !image.width || !image.height) return null
  let grid = grids.get(image)
  if (!grid) {
    grid = depthGrid(image)
    grids.set(image, grid)
  }
  return grid
}

/** The grey levels of a loaded depth map (its red channel), on a canvas. */
export function depthGrid(image: CanvasImageSource & { width: number; height: number }): DepthGrid {
  const { width, height } = image
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('water: no 2d context to read the depth map')
  context.drawImage(image, 0, 0)
  const rgba = context.getImageData(0, 0, width, height).data
  const levels = new Uint8Array(width * height)
  for (let i = 0; i < levels.length; i++) levels[i] = rgba[4 * i]
  return { width, height, levels }
}

/** The depth (m) at texture coordinates (u from -180 deg, v = 0 north),
 * bilinear between texel centres, the longitude wrapped. */
function depthAtUv(grid: DepthGrid, u: number, v: number): number {
  const { width, height, levels } = grid
  const x = u * width - 0.5
  const y = Math.min(Math.max(v * height - 0.5, 0), height - 1)
  const i = Math.floor(x)
  const j = Math.min(Math.floor(y), height - 2)
  const fx = x - i
  const fy = y - j
  const at = (col: number, row: number) => {
    const g = levels[row * width + (((col % width) + width) % width)] / 255
    return WATER_DEPTH_MAX * g * g
  }
  return (
    (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy
  )
}

/** The sea floor under a local unit direction: its depth (m), the compass
 * bearing (radians, clockwise from north) up the slope, and how steep it
 * is (m per km), from central differences a texel either side, so all
 * three move smoothly as the eye does. */
export interface SeaFloor {
  depth: number
  upslope: number
  grade: number
}

export function seaFloor(grid: DepthGrid, up: readonly [number, number, number], radiusKm: number): SeaFloor {
  const [u, v] = climateUv(up)
  const du = 1 / grid.width
  const dv = 1 / grid.height
  const coslat = Math.max(Math.sqrt(1 - Math.min(up[1] * up[1], 1)), 1e-3)
  const eastKm = 2 * du * 2 * Math.PI * radiusKm * coslat
  const northKm = 2 * dv * Math.PI * radiusKm
  const east = (depthAtUv(grid, u + du, v) - depthAtUv(grid, u - du, v)) / eastKm
  const north = (depthAtUv(grid, u, v - dv) - depthAtUv(grid, u, v + dv)) / northKm
  return { depth: depthAtUv(grid, u, v), upslope: Math.atan2(-east, -north), grade: Math.hypot(east, north) }
}

const GRAVITY = 9.81

/** A wave's speed over `depth` m relative to its speed in deep water, for
 * its deep-water wavelength `metres`: k0 / k, k solving the dispersion
 * relation w^2 = g k tanh(k h) at its own w (Newton, from Eckart's guess). */
export function shallowRatio(metres: number, depth: number): number {
  const k0 = (2 * Math.PI) / metres
  const h = Math.max(depth, 0.5)
  if (k0 * h > 10) return 1
  let k = k0 / Math.sqrt(Math.tanh(k0 * h))
  for (let n = 0; n < 4; n++) {
    const t = Math.tanh(k * h)
    k -= (k * t - k0) / (t + k * h * (1 - t * t))
  }
  return k0 / k
}

/** How steep a floor must be (m per km) before its up-slope direction is
 * trusted: on a flat bottom the gradient's direction is noise. */
export const WATER_REFRACT_GRADE = [0.1, 0.5] as const
/** How far round from the up-slope (degrees) a wave still takes its whole
 * turn: past it the turn fades out by 90 deg, where a ray from deep water
 * would never have come up the slope. */
export const WATER_REFRACT_FULL_DEG = 60

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

/** A wave's heading (compass radians) refracted over `floor`, for its
 * deep-water wavelength `metres`: its angle off the up-slope, psi0, taken
 * to asin(sin psi0 c / c0); waves running along or away from the slope
 * keep theirs. */
export function refractHeading(heading: number, metres: number, floor: SeaFloor): number {
  const psi0 = wrapPi(heading - floor.upslope)
  const facing = 1 - smoothstep((WATER_REFRACT_FULL_DEG * Math.PI) / 180, Math.PI / 2, Math.abs(psi0))
  const trust = smoothstep(WATER_REFRACT_GRADE[0], WATER_REFRACT_GRADE[1], floor.grade)
  const weight = facing * trust
  if (weight === 0) return heading
  const psi = Math.asin(Math.sin(psi0) * shallowRatio(metres, floor.depth))
  return heading + (psi - psi0) * weight
}
