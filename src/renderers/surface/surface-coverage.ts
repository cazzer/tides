// The streamed tiles' view error near the eye and past the source's
// coverage (tides-zmw.9.17, tides-zmw.9.21), as a wrapper on the renderer's
// calculateTileViewError.
//
// Near the eye (9.17). 3d-tiles-renderer 0.5.3 takes a tile's distance as
// its bounding volume's distanceToPoint (TilesRenderer.calculateTileViewError,
// TileBoundingVolume.distanceToPoint): 0 anywhere inside the region's
// oriented box, and the error Infinity (1e13-1e16 a hair outside). So every
// tile whose box holds the eye refines to the deepest level whatever the
// ground under it. Here a distance under EYE_GROUND_MIN_METRES (the floor
// the distance is held to below, so a neighbour 1-30 m off never out-refines
// the tile under the eye) is taken again from the region itself: from the eye to the region's nearest point (its lat,
// lon and height clamped into the region's), and with the eye inside the
// region, from the eye down to the drawn ground under it (the ship's floor
// sampler, surface-ground.ts, times the relief), never under
// EYE_GROUND_MIN_METRES, the ship's stop on a float depth buffer: so the
// tile under the eye still refines as the ground comes near (never a flat
// cap: tides-zmw.9.8's floor is the window maximum over the drawn meshes,
// and a coarser one under the eye raises it in a canyon). Where no drawn
// tile covers the ground under the eye, the region's top stands in for it
// (the stop, so the tiles there refine as before, but finitely).
//
// Past the coverage end (9.21). Where the source has nothing finer than
// some level (Mapterhorn: z12 over the Himalaya, z13 over Israel),
// SurfaceGridCache draws the deeper grids from that data (terrain-
// internals.ts). Refining on still draws that data finer, up to about a
// texel a vertex (a 512-texel grid under 32-segment meshes: four levels
// down), and no further: a tile at least CAP_LEVELS under the data level
// all of whose children read grids past the coverage end takes error 0 (a
// leaf), applied last, over the near-eye error; above that, the screen-space
// error decides as anywhere. A tile with any child of its own data (a
// coverage boundary, a coast) refines as before. The ship's floor takes
// such a leaf as the tree's end (deepest()): no anticipating children that
// never come.
//
// Under the eye at speed (tides-zmw.9.22). The speed ramp raises the
// errorTarget (surface-lod.ts), which would stop the tiles under the eye
// short too, and the ship's floor reads them (the highest drawn ground
// within its window: a coarser mesh raises it in a canyon). So every tile
// within eyeMarginRadians of the eye's latitude and longitude (the floor's
// window, or a second's flight ahead, so the tile the ship crosses into is
// refined before the floor reads it) takes its error times eyeErrorScale
// (the errorTarget over its rest value), and refines as at rest whatever
// the speed, before the coverage cap.
//
// The library's no-child-in-view rule (traverseFunctions.js, 0.5.3: a
// REPLACE tile none of whose children is in the frustum clears its own
// inFrustum, so it is kept in the cache but never drawn, cascading up) is
// what turned 9.21's sea-level slabs into a hole; the coverage-end grids
// keep the children's regions on their ground.
import * as THREE from 'three'
import { surfaceGroundSampler } from '../../surface-ground'
import { RELIEF } from '../../relief'
import { EARTH_UNITS_PER_METRE, FINE_GROUND_CLEARANCE } from '../../ship/ship-bodies'
import { GRID_LEVEL_STEP } from './terrain-internals'
import { SURFACE_TREE_DEEPEST, TILE_VERTICES } from './surface-ground'

/** The least distance (m) the eye is taken to stand from the drawn ground: the ship's stop on a float depth buffer. */
export const EYE_GROUND_MIN_METRES = FINE_GROUND_CLEARANCE / EARTH_UNITS_PER_METRE
/**
 * Levels under the data level at which a tile past the coverage end stops
 * refining: the grid's texels (512) over the mesh's segments (32), 2^4, so
 * the data is drawn at about a texel a vertex.
 */
export const CAP_LEVELS = Math.round(Math.log2(512 / (TILE_VERTICES - 1)))
/** The window (m) the drawn ground under the eye is read across. */
const EYE_GROUND_WINDOW_METRES = 1
const TWO_PI = 2 * Math.PI

/** The renderer's view error output (0.5.3). */
export interface ViewErrorTarget {
  inView: boolean
  error: number
  distanceFromCamera: number
}

interface Cartographic {
  lat: number
  lon: number
  height: number
}

/** The renderer's ellipsoid, as the region distance uses it. */
export interface RegionEllipsoid {
  getPositionToCartographic(position: THREE.Vector3, target: Cartographic): Cartographic
  getCartographicToPosition(lat: number, lon: number, height: number, target: THREE.Vector3): THREE.Vector3
}

/** One camera's state as the renderer keeps it for its view error (0.5.3, pinned). */
interface CameraInfo {
  isOrthographic: boolean
  pixelSize: number
  sseDenominator: number
  /** The camera in the tiles' root frame (ECEF metres here). */
  position: THREE.Vector3
  frustum: unknown
}

interface RendererInternals {
  calculateTileViewError(tile: object, target: ViewErrorTarget): void
  cameraInfo: CameraInfo[]
  ellipsoid: RegionEllipsoid
  frameCount: number
}

/** A terrain tile as the wrapper reads it. */
interface ViewTile {
  geometricError: number
  boundingVolume?: { region?: readonly number[] }
  engineData?: { boundingVolume?: { intersectsFrustum(frustum: unknown): boolean } }
  children?: readonly object[]
}

function wrapPi(a: number): number {
  return a - TWO_PI * Math.round(a / TWO_PI)
}

const _clamped = new THREE.Vector3()

/**
 * The distance (m) from the eye (at `position`, `eye` its cartographic
 * form) to the region [west, south, east, north, min, max] (radians,
 * metres): to the point with the eye's latitude, longitude and height each
 * clamped into the region's, which is the nearest point straight over or
 * beside it, and near enough to it otherwise. null with the eye inside.
 */
export function regionDistance(
  region: readonly number[],
  eye: Cartographic,
  position: THREE.Vector3,
  ellipsoid: RegionEllipsoid
): number | null {
  const [west, south, east, north, min, max] = region
  const mid = (west + east) / 2
  const half = (east - west) / 2
  const dLon = wrapPi(eye.lon - mid)
  const lon = mid + Math.min(Math.max(dLon, -half), half)
  const lat = Math.min(Math.max(eye.lat, south), north)
  const height = Math.min(Math.max(eye.height, min), max)
  if (lat === eye.lat && Math.abs(dLon) <= half && height === eye.height) return null
  return ellipsoid.getCartographicToPosition(lat, lon, height, _clamped).distanceTo(position)
}

/** The plugin's per-tile symbols (module-private in 0.5.3, found by their descriptions; pinned). */
interface TileSymbols {
  x: symbol
  y: symbol
  level: symbol
}

let symbols: TileSymbols | null = null

/** TILE_X, TILE_Y and TILE_LEVEL from a terrain tile, or null on any other. */
export function terrainTileSymbols(tile: object): TileSymbols | null {
  if (symbols && symbols.level in tile) return symbols
  const own = Object.getOwnPropertySymbols(tile)
  const find = (name: string) => own.find((s) => s.description === name)
  const [x, y, level] = [find('TILE_X'), find('TILE_Y'), find('TILE_LEVEL')]
  if (!x || !y || !level) return null
  symbols = { x, y, level }
  return symbols
}

export interface SurfaceViewErrorOptions {
  /** The grid cache's coverage ends (SurfaceGridCache.coverageLevel). */
  coverageLevel(x: number, y: number, level: number): number
  /** Whether any coverage end is known yet (else the cap is skipped). */
  hasCoverageEnds(): boolean
  /** The plugin's deepest grid level (its _maxSourceLevel). */
  maxSourceLevel: number
  /** Levels under the data level a tile past the coverage end stops at (CAP_LEVELS). */
  capLevels?: number
  /** The relief the tiles are drawn at (the page's, RELIEF, by default). */
  relief?: number
  /** The highest drawn ground (true metres) within radiusM of (lat, lon), or null where no drawn tile covers it. */
  ground?(lat: number, lon: number, radiusM: number): number | null
  /** The factor on the error of tiles over or around the eye: the errorTarget over its rest value (1: none). */
  eyeErrorScale?(): number
  /** How far around the eye's latitude and longitude (radians of arc) a tile takes eyeErrorScale (0: the tiles over it only). */
  eyeMarginRadians?(): number
}

export interface SurfaceViewError {
  /** Tiles whose error was taken from the region this frame (eye inside the box). */
  readonly near: number
  /** Tiles capped at the coverage end this frame. */
  readonly capped: number
  /** Tiles under or around the eye whose error was scaled up this frame (eyeErrorScale). */
  readonly underEye: number
  /** The largest error written this frame, the root's and z0's aside (never Infinity), the eye's scaling included. */
  readonly maxError: number
  /**
   * The deepest level the tree reaches over a tile, for the floor's
   * anticipation (surface-ground.ts): the tile's own where it is a leaf at
   * the coverage end, else the tree's.
   */
  deepest(tile: unknown): number
}

/** The drawn ground from the ship's floor sampler, where the tiles cover the window. */
function drawnGround(lat: number, lon: number, radiusM: number): number | null {
  const query = surfaceGroundSampler()?.maxElevation(lat, lon, radiusM)
  return query?.covered ? query.metres : null
}

interface EyeState {
  frame: number
  carto: Cartographic
  /** Drawn ground under the eye, metres times the relief; NaN until read, null when none covers it. */
  ground: number | null
}

/** Wraps the renderer's view error (see the header). */
export function boundSurfaceViewError(tiles: object, options: SurfaceViewErrorOptions): SurfaceViewError {
  const renderer = tiles as RendererInternals
  const view = renderer.calculateTileViewError
  if (typeof view !== 'function' || !Array.isArray(renderer.cameraInfo)) {
    throw new Error('surface coverage: not the 0.5.3 renderer')
  }
  const { coverageLevel, hasCoverageEnds, maxSourceLevel, relief = RELIEF, ground = drawnGround, capLevels = CAP_LEVELS, eyeErrorScale, eyeMarginRadians } = options
  const eyes: EyeState[] = []
  let frame = -1
  let near = 0
  let capped = 0
  let underEye = 0
  let maxError = 0

  const eyeOf = (i: number): EyeState => {
    const eye = (eyes[i] ??= { frame: -1, carto: { lat: 0, lon: 0, height: 0 }, ground: NaN })
    if (eye.frame !== renderer.frameCount) {
      eye.frame = renderer.frameCount
      renderer.ellipsoid.getPositionToCartographic(renderer.cameraInfo[i].position, eye.carto)
      eye.ground = NaN
    }
    return eye
  }

  const groundUnder = (eye: EyeState): number | null => {
    if (Number.isNaN(eye.ground)) {
      const metres = ground(eye.carto.lat, eye.carto.lon, EYE_GROUND_WINDOW_METRES)
      eye.ground = metres === null ? null : metres * relief
    }
    return eye.ground
  }

  /** The camera's distance (m) to the tile: the region's, or down to the drawn ground with the eye inside it. */
  const distanceTo = (region: readonly number[], i: number): number => {
    const eye = eyeOf(i)
    const outside = regionDistance(region, eye.carto, renderer.cameraInfo[i].position, renderer.ellipsoid)
    if (outside !== null) return Math.max(EYE_GROUND_MIN_METRES, outside)
    const under = groundUnder(eye) ?? region[5]
    return Math.max(EYE_GROUND_MIN_METRES, eye.carto.height - under)
  }

  /**
   * Whether any camera's eye is within `margin` (radians of arc) of the
   * region: its latitude within margin of the region's, its longitude within
   * margin / cos(latitude) (every longitude where that passes a pole).
   */
  const nearEye = (region: readonly number[], margin: number): boolean => {
    const [west, south, east, north] = region
    for (let i = 0; i < renderer.cameraInfo.length; i++) {
      const { carto } = eyeOf(i)
      if (carto.lat < south - margin || carto.lat > north + margin) continue
      const cos = Math.cos(carto.lat)
      const lonMargin = cos > margin ? margin / cos : Math.PI
      if (Math.abs(wrapPi(carto.lon - (west + east) / 2)) <= (east - west) / 2 + lonMargin) return true
    }
    return false
  }

  // The library's loop (TilesRenderer.calculateTileViewError, 0.5.3) on
  // the region's distance.
  const nearError = (tile: ViewTile, target: ViewErrorTarget) => {
    const region = tile.boundingVolume?.region
    const volume = tile.engineData?.boundingVolume
    if (!region || region.length < 6 || !volume) return
    let inView = false
    let inViewError = 0
    let inViewDistance = Infinity
    let maxCameraError = 0
    let minCameraDistance = Infinity
    const { cameraInfo } = renderer
    for (let i = 0; i < cameraInfo.length; i++) {
      const info = cameraInfo[i]
      let error: number
      let distance: number
      if (info.isOrthographic) {
        error = tile.geometricError / info.pixelSize
        distance = Infinity
      } else {
        distance = distanceTo(region, i)
        error = tile.geometricError / (distance * info.sseDenominator)
      }
      if (volume.intersectsFrustum(info.frustum)) {
        inView = true
        inViewError = Math.max(inViewError, error)
        inViewDistance = Math.min(inViewDistance, distance)
      }
      maxCameraError = Math.max(maxCameraError, error)
      minCameraDistance = Math.min(minCameraDistance, distance)
    }
    target.inView = inView
    target.error = inView ? inViewError : maxCameraError
    target.distanceFromCamera = inView ? inViewDistance : minCameraDistance
    near++
  }

  /**
   * Whether the tile is at the coverage end's last level: CAP_LEVELS or more
   * under the data level every one of its children reads past the coverage.
   */
  const pastCoverage = (tile: object): boolean => {
    const children = (tile as ViewTile).children
    if (!children?.length) return false
    const sym = terrainTileSymbols(tile)
    if (!sym) return false
    const own = (tile as Record<symbol, number>)[sym.level]
    for (const child of children) {
      const c = child as Record<symbol, number>
      const level = c[sym.level]
      if (level === undefined) return false
      const source = Math.min(GRID_LEVEL_STEP * Math.floor(level / GRID_LEVEL_STEP), maxSourceLevel)
      const shift = level - source
      const data = coverageLevel(c[sym.x] >> shift, c[sym.y] >> shift, source)
      if (data < 0 || own < data + capLevels) return false
    }
    return true
  }

  const levelOf = (tile: object): number => {
    const sym = terrainTileSymbols(tile)
    return sym ? (tile as Record<symbol, number>)[sym.level] : -1
  }

  renderer.calculateTileViewError = function (tile: ViewTile, target) {
    view.call(this, tile, target)
    if (renderer.frameCount !== frame) {
      frame = renderer.frameCount
      near = capped = underEye = maxError = 0
    }
    if (target.distanceFromCamera < EYE_GROUND_MIN_METRES) nearError(tile, target)
    const eyeScale = eyeErrorScale ? eyeErrorScale() : 1
    if (eyeScale > 1 && target.error > 0) {
      const region = tile.boundingVolume?.region
      const margin = eyeMarginRadians ? Math.max(0, eyeMarginRadians()) || 0 : 0
      if (region && region.length >= 6 && nearEye(region, margin)) {
        target.error *= eyeScale
        underEye++
      }
    }
    if (target.error > 0 && hasCoverageEnds() && pastCoverage(tile)) {
      target.error = 0
      capped++
    }
    // Not the synthetic root's (geometricError Infinity: it always refines)
    // nor z0's (~78 km at the 30 m stop: 1.3e6, refining as it must).
    if (target.error > maxError && levelOf(tile) >= 1) maxError = target.error
  }

  return {
    get near() {
      return near
    },
    get capped() {
      return capped
    },
    get underEye() {
      return underEye
    },
    get maxError() {
      return maxError
    },
    deepest(tile) {
      return tile && hasCoverageEnds() && pastCoverage(tile as object) ? levelOf(tile as object) : SURFACE_TREE_DEEPEST
    },
  }
}
