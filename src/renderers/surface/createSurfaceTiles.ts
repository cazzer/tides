// Builds the streamed surface (tides-zmw.9.1): a 3d-tiles-renderer
// TilesRenderer fed by Mapterhorn's Terrarium-encoded elevation tiles, meshed
// on the client and draped with SurfaceImageryOverlay, in Earth's local frame
// (surface-frame.ts). SurfaceTiles owns the instance's life; this module owns
// its recipe, kept out of the component so it reads as one place.
//
// tides-zmw.9.2 made it robust for whole-globe flight: ocean tiles that 404
// come back as flat sea level and failed imagery as the day map's ocean
// colour (no holes); elevation grids decode in workers and finish a couple
// per frame (no long stalls), nearest-filtered where the GPU can't filter
// float textures (iOS); and the instance has its own memory cap and
// download queue rather than the library's shared defaults.
//
// tides-zmw.9.7 handed the ground over from the globe by stencil
// (surface-scale.ts): the plugin is built at the page's RELIEF, the tiles
// draw first, and each tile dithers in (TilesFadePlugin)
// rather than popping over the globe it replaces.
//
// tides-zmw.9.21 drew the tiles past the source's coverage (Mapterhorn has
// nothing finer than z12 over the Himalaya, and 404s under it as over the
// sea) from the coarser data instead of sea level, and stopped refining
// there; tides-zmw.9.17 took the view error near the eye from the drawn
// ground rather than infinity (surface-coverage.ts).
//
// tides-zmw.9.22 kept the tiles under the eye at their rest detail whatever
// the speed ramp asks (setErrorTarget), and tides-zmw.9.24 sized the cache
// and the detail resolution to the view (setViewSize, surface-lod.ts).
//
// tides-zmw.9.16 built each tile's material in one composer (tile-material.ts):
// Phong, the relief and handover, and the globe's features from its link
// (surface-link.ts) in the globe's order (tile-features.ts).
import * as THREE from 'three'
import { DEFAULT_DOWNLOAD_QUEUE, DEFAULT_LRU_CACHE, DownloadPriorityQueue, LRUCache } from '3d-tiles-renderer/core'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins'
import { RELIEF } from '../../relief'
import { FrameBudget } from './frame-budget'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import { applySurfaceFrame, SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import type { GlobeLink } from './surface-link'
import { TILE_FEATURES } from './tile-features'
import { createTileComposer, createTileMaterialPlugin, type TileComposer } from './tile-material'
import { boundSurfaceViewError, type SurfaceViewError } from './surface-coverage'
import { cacheMarkSetter, surfaceDetail } from './surface-lod'
import {
  GRID_LEVEL_STEP,
  installSurfaceGridCache,
  protectOverlayBitmaps,
  quietTilesetVersion,
  shareGridBytes,
  startFailedTileRetry,
  type SurfaceGridCache,
} from './terrain-internals'
import { decodeTerrariumImage } from './terrarium'
import { createTerrariumDecoder, type DecodeWorker } from './terrariumDecoder'

/** Mapterhorn's global terrain (Copernicus GLO-30 and national DEMs), 512 px WebP Terrarium. */
export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
export const MAPTERHORN_TILE_SIZE = 512
/** Mapterhorn's deepest level everywhere it has data (~2.4 m/px at the equator). */
export const MAPTERHORN_MAX_ZOOM = 16

/** How often failed tiles are retried, and the first wait of each one's backoff. */
export const RETRY_FAILED_MS = 10_000
/** Downloads in flight per server (the library's shared queue allows 25). */
export const SURFACE_JOBS_PER_ORIGIN = 8

export interface SurfaceTilesOptions {
  /** OES_texture_float_linear: the elevation grids filter linearly, else nearest. */
  floatLinear: boolean
  /** Uploads each finished grid at once (the renderer's initTexture). */
  upload?: (texture: THREE.Texture) => void
  /** The globe's side of the tiles' features (its haze, eclipse, ...). */
  link?: GlobeLink | null
}

export interface SurfaceTiles {
  tiles: TilesRenderer
  terrain: TerrariumMeshPlugin
  overlay: SurfaceImageryOverlay
  grids: SurfaceGridCache
  /** Builds each tile's material (tile-material.ts). */
  composer: TileComposer
  /** Tick once per frame: lets the next grids finish. */
  budget: FrameBudget
  /** The view error near the eye and past the coverage end (surface-coverage.ts). */
  viewError: SurfaceViewError
  /**
   * Sets this frame's errorTarget and its rest value (surface-lod.ts): the
   * tiles within `eyeMargin` metres of the eye take their error times
   * target / rest, so they refine as at rest (surface-coverage.ts).
   */
  setErrorTarget(target: number, rest: number, eyeMargin?: number): void
  /**
   * The view's size in CSS pixels, as setResolutionFromRenderer would give
   * (the error target is in those pixels): sets the camera's detail
   * resolution and the cache's marks from it (surfaceDetail; marks that
   * fall wait for the size to settle, cacheMarkSetter). Call after the
   * camera is registered and on every resize.
   */
  setViewSize(camera: THREE.Camera, width: number, height: number): void
  /** Copies the robustness counters onto tiles.group.userData. */
  syncCounters(): void
  dispose(): void
}

/** The decode worker needs OffscreenCanvas 2D (Safari 16.4+). */
function canWorkerDecode(): boolean {
  try {
    return (
      typeof Worker === 'function' &&
      typeof OffscreenCanvas === 'function' &&
      new OffscreenCanvas(1, 1).getContext('2d') !== null
    )
  } catch {
    return false
  }
}

function createDecodeWorker(): DecodeWorker | null {
  if (!canWorkerDecode()) return null
  return new Worker(new URL('./terrarium-decode.worker.ts', import.meta.url), {
    type: 'module',
    name: 'terrain',
  }) as unknown as DecodeWorker
}

/** The draw order of the tiles' group: before the globe, whose pixels they
 * take by stencil (surface-scale.ts). three sorts a Group's children by it. */
export const SURFACE_RENDER_ORDER = -1

export function createSurfaceTiles({ floatLinear, upload, link = null }: SurfaceTilesOptions): SurfaceTiles {
  const overlay = new SurfaceImageryOverlay()
  protectOverlayBitmaps(overlay)
  const terrain = new TerrariumMeshPlugin({
    url: MAPTERHORN_URL,
    tileDimension: MAPTERHORN_TILE_SIZE,
    maxZoom: MAPTERHORN_MAX_ZOOM,
    // The page's relief, the globe's (surface-scale.ts); the setter is never
    // called again (it rewrites every material and refits the whole tree).
    heightScale: RELIEF,
    overlay,
    applyOverlayTexture: true,
  })
  const decoder = createTerrariumDecoder({ createWorker: createDecodeWorker, inThread: decodeTerrariumImage })
  const budget = new FrameBudget()
  const grids = installSurfaceGridCache(terrain, {
    // Nearest is core WebGL2 at full precision, and three warns about (and
    // the GPU refuses) linear float filtering without the extension. Its
    // cost: per-texel facets in the bump shading below a few km.
    filter: floatLinear ? 'linear' : 'nearest',
    decode: decoder.decode,
    bake: decoder.bake,
    canBake: () => decoder.bakes,
    budget,
    upload,
  })

  const tiles = new TilesRenderer()
  // A sphere like the app's globe, not WGS84, so a lat/lon lands where the
  // globe's map has it. registerPlugin sets errorTarget to 1 (the plugin's
  // recommended settings); SurfaceTiles moves it with the ship's speed
  // (surface-lod.ts) every frame.
  tiles.ellipsoid.radius.setScalar(SURFACE_ELLIPSOID_RADIUS)
  // Its own cache and queue, set before the first update (the cache can't be
  // swapped after, though its marks can): the shared defaults would hold 0.3
  // to 0.4 GB whatever the view and put 25 downloads at once on each server,
  // with the decodes to match. The marks follow the view (setViewSize); each
  // tile is charged half the elevation grid it shares (shareGridBytes).
  const lruCache = new LRUCache()
  const cacheMarks = cacheMarkSetter(({ min, max }) => {
    lruCache.minBytesSize = min
    lruCache.maxBytesSize = max
  })
  cacheMarks.set(surfaceDetail(0, 0).cache)
  lruCache.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback
  tiles.lruCache = lruCache
  const downloads = new DownloadPriorityQueue()
  downloads.maxJobsPerOrigin = SURFACE_JOBS_PER_ORIGIN
  downloads.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback
  tiles.downloadQueue = downloads
  overlay.downloadQueue = downloads
  quietTilesetVersion(tiles)
  tiles.registerPlugin(terrain)
  shareGridBytes(tiles)
  // Each tile's material as it parses (Phong, the scale and the handover,
  // the globe's features), then the fade, which wraps it at load-model; root
  // tiles fade in too, over the globe they replace.
  const composer = createTileComposer(link, TILE_FEATURES)
  tiles.registerPlugin(createTileMaterialPlugin(composer))
  tiles.registerPlugin(new TilesFadePlugin({ fadeRootTiles: true }))
  // The error near the eye from the drawn ground, the eye's chain at rest
  // detail, and none past the source's coverage (surface-coverage.ts).
  let restErrorTarget = tiles.errorTarget
  let eyeMarginRadians = 0
  const viewError = boundSurfaceViewError(tiles, {
    coverageLevel: (x, y, level) => grids.coverageLevel(x, y, level),
    hasCoverageEnds: () => grids.coverageEnd.size > 0,
    maxSourceLevel: GRID_LEVEL_STEP * Math.floor(MAPTERHORN_MAX_ZOOM / GRID_LEVEL_STEP),
    eyeErrorScale: () => tiles.errorTarget / restErrorTarget,
    eyeMarginRadians: () => eyeMarginRadians,
  })
  applySurfaceFrame(tiles.group)
  tiles.group.renderOrder = SURFACE_RENDER_ORDER
  tiles.group.name = 'surface-tiles'
  tiles.group.userData.tiles = tiles
  // Out of ShipWarmup's reach (ship-warmup.ts): tiles come and go too fast to
  // queue, and the grids are uploaded as they finish (upload, above).
  tiles.group.userData.warmup = false

  // Earth's mesh takes pointer events (OrbitingBody's onPointerDown), and R3F
  // raycasts its children too: the group's own raycast would hit-test every
  // loaded tile against a CPU-displaced copy of its mesh on each pointer
  // event. Returning false skips the tiles and everything under them, which
  // is what the scene did before they existed.
  tiles.group.raycast = () => false

  // Ocean 404s and failed imagery no longer fail a tile (above); anything
  // else that does is said once, and counted.
  let loadErrors = 0
  tiles.addEventListener('load-error', (event) => {
    loadErrors++
    tiles.group.userData.loadErrors = loadErrors
    if (loadErrors === 1) console.warn('surface tiles: a tile failed to load (more are counted in userData.loadErrors)', event.url)
  })

  // A failed tile stays failed until it's reset; the grid cache forgets
  // failed grids (terrain-internals.ts), so retry them every RETRY_FAILED_MS,
  // each backing off while it keeps failing, and all at once when the
  // network comes back. Not the library's resetFailedTiles, which throws on
  // the plugin's tree and wouldn't reload them (retryFailedTiles).
  const stopRetry = startFailedTileRetry(tiles, RETRY_FAILED_MS)

  const syncCounters = () => {
    const data = tiles.group.userData
    data.flatTiles = grids.flatTiles
    data.cappedTiles = grids.cappedTiles
    data.coverageEnds = grids.coverageEnd.size
    data.nearViews = viewError.near
    data.cappedViews = viewError.capped
    data.underEyeViews = viewError.underEye
    data.maxViewError = viewError.maxError
    data.imageryFallbacks = overlay.fallbacks
    data.errorTarget = tiles.errorTarget
  }

  return {
    tiles,
    terrain,
    overlay,
    grids,
    composer,
    budget,
    viewError,
    setErrorTarget(target, rest, eyeMargin = 0) {
      tiles.errorTarget = target
      restErrorTarget = rest > 0 ? rest : target
      eyeMarginRadians = eyeMargin > 0 ? eyeMargin / SURFACE_ELLIPSOID_RADIUS : 0
    },
    setViewSize(camera, width, height) {
      const detail = surfaceDetail(width, height)
      tiles.setResolution(camera, detail.width, detail.height)
      cacheMarks.set(detail.cache)
    },
    syncCounters,
    // tiles.dispose() unregisters the terrain plugin, which releases every
    // loaded tile's grid and overlay texture; in-flight parses release theirs
    // as they abort. The overlay's caches are reference counted, so they
    // empty themselves (disposing each texture and aborting its download) a
    // microtask later. Don't also dispose the overlay's caches: the library's
    // DataCache.dispose throws on an entry already released and awaiting that
    // microtask, and a throw in an effect cleanup unmounts the whole app.
    // The grid cache, budget and decoder go first: fetches, retries, decodes
    // and grids waiting their turn reject as aborted, which the plugin takes
    // as a cancelled load.
    dispose() {
      cacheMarks.dispose()
      stopRetry()
      grids.shutDown()
      budget.dispose()
      decoder.dispose()
      tiles.dispose()
    },
  }
}
