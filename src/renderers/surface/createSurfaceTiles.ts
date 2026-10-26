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
// tides-zmw.9.7 put the tiles on the globe's live terrain scale and handed
// the ground over from the globe by stencil (surface-scale.ts): the plugin
// is built at the page's RELIEF (the skirts of the largest scale; the
// bounding regions follow the live scale stepwise), the tiles draw first, and each tile dithers in (TilesFadePlugin)
// rather than popping over the globe it replaces.
import * as THREE from 'three'
import { DEFAULT_DOWNLOAD_QUEUE, DEFAULT_LRU_CACHE, DownloadPriorityQueue, LRUCache } from '3d-tiles-renderer/core'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin, TilesFadePlugin } from '3d-tiles-renderer/three/plugins'
import { RELIEF } from '../../relief'
import type { GroundHaze } from '../groundHaze'
import { FrameBudget } from './frame-budget'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import { applySurfaceFrame, SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import { createSurfaceScalePlugin, fitSurfaceBounds, type SurfaceBounds } from './surface-scale'
import { terrainScaleUniform } from '../../terrain-scale'
import {
  installSurfaceGridCache,
  protectOverlayBitmaps,
  quietTilesetVersion,
  retryFailedTiles,
  shareGridBytes,
  type SurfaceGridCache,
} from './terrain-internals'
import { decodeTerrariumImage } from './terrarium'
import { createTerrariumDecoder, type DecodeWorker } from './terrariumDecoder'

/** Mapterhorn's global terrain (Copernicus GLO-30 and national DEMs), 512 px WebP Terrarium. */
export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
export const MAPTERHORN_TILE_SIZE = 512
/** Mapterhorn's deepest level everywhere it has data (~2.4 m/px at the equator). */
export const MAPTERHORN_MAX_ZOOM = 16

const GIGABYTE = 2 ** 30
/**
 * The instance's tile memory (the library's default shared cache allows 0.3
 * to 0.4 GB): evicts down to the low mark once past the high one. Each tile
 * is charged half the elevation grid it shares (shareGridBytes).
 */
export const SURFACE_CACHE_BYTES = { min: 0.15 * GIGABYTE, max: 0.25 * GIGABYTE }
/** How often failed tiles are retried. */
export const RETRY_FAILED_MS = 10_000
/** Downloads in flight per server (the library's shared queue allows 25). */
export const SURFACE_JOBS_PER_ORIGIN = 8

export interface SurfaceTilesOptions {
  /** OES_texture_float_linear: the elevation grids filter linearly, else nearest. */
  floatLinear: boolean
  /** Uploads each finished grid at once (the renderer's initTexture). */
  upload?: (texture: THREE.Texture) => void
  /** The globe's aerial perspective, laid on the tiles too (its surfacePatch). */
  haze?: GroundHaze | null
}

export interface SurfaceTiles {
  tiles: TilesRenderer
  terrain: TerrariumMeshPlugin
  overlay: SurfaceImageryOverlay
  grids: SurfaceGridCache
  /** Tick once per frame: lets the next grids finish. */
  budget: FrameBudget
  /** Update once per frame, before tiles.update(): the regions' fit. */
  bounds: SurfaceBounds
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

export function createSurfaceTiles({ floatLinear, upload, haze = null }: SurfaceTilesOptions): SurfaceTiles {
  const overlay = new SurfaceImageryOverlay()
  protectOverlayBitmaps(overlay)
  const terrain = new TerrariumMeshPlugin({
    url: MAPTERHORN_URL,
    tileDimension: MAPTERHORN_TILE_SIZE,
    maxZoom: MAPTERHORN_MAX_ZOOM,
    // The largest scale the live one reaches, for the skirts (the bounding
    // regions follow the live scale stepwise, fitSurfaceBounds); the shaders
    // draw at terrainScaleUniform (surface-scale.ts), and the setter is never
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
  // swapped after): the shared defaults would let the surface hold 0.4 GB and
  // put 25 downloads at once on each server, with the decodes to match.
  const lruCache = new LRUCache()
  lruCache.minBytesSize = SURFACE_CACHE_BYTES.min
  lruCache.maxBytesSize = SURFACE_CACHE_BYTES.max
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
  // The scale and the handover on each tile's materials as it parses, then
  // the fade, which wraps them at load-model; root tiles fade in too, over
  // the globe they replace.
  const hazePatches = haze ? [haze.surfacePatch] : []
  tiles.registerPlugin(createSurfaceScalePlugin(() => hazePatches))
  tiles.registerPlugin(new TilesFadePlugin({ fadeRootTiles: true }))
  // The bounding regions on the live scale, stepwise (surface-scale.ts).
  const bounds = fitSurfaceBounds(tiles, terrain, () => terrainScaleUniform.value)
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
  // failed grids (terrain-internals.ts), so retry them when the network
  // comes back and every RETRY_FAILED_MS (it returns at once while
  // stats.failed is 0). Not the library's resetFailedTiles, which throws on
  // the plugin's tree and wouldn't reload them (retryFailedTiles); a throw
  // here would be a page error each time, so it's said once and dropped.
  let retriedTiles = 0
  let retryWarned = false
  const retryFailed = () => {
    try {
      const reset = retryFailedTiles(tiles)
      if (reset > 0) tiles.group.userData.retriedTiles = retriedTiles += reset
    } catch (error) {
      if (!retryWarned) console.warn('surface tiles: retrying failed tiles threw (said once)', error)
      retryWarned = true
    }
  }
  const retryTimer = setInterval(retryFailed, RETRY_FAILED_MS)
  if (typeof window !== 'undefined') window.addEventListener('online', retryFailed)

  const syncCounters = () => {
    const data = tiles.group.userData
    data.flatTiles = grids.flatTiles
    data.imageryFallbacks = overlay.fallbacks
    data.errorTarget = tiles.errorTarget
    data.fitScale = bounds.fit
    data.refits = bounds.refits
  }

  return {
    tiles,
    terrain,
    overlay,
    grids,
    budget,
    bounds,
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
      clearInterval(retryTimer)
      if (typeof window !== 'undefined') window.removeEventListener('online', retryFailed)
      grids.shutDown()
      budget.dispose()
      decoder.dispose()
      tiles.dispose()
    },
  }
}
