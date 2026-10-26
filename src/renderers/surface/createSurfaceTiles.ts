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
import * as THREE from 'three'
import { DEFAULT_DOWNLOAD_QUEUE, DEFAULT_LRU_CACHE, DownloadPriorityQueue, LRUCache } from '3d-tiles-renderer/core'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { FrameBudget } from './frame-budget'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import { applySurfaceBumpScale, applySurfaceFrame, SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import {
  installSurfaceGridCache,
  protectOverlayBitmaps,
  quietTilesetVersion,
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
}

export interface SurfaceTiles {
  tiles: TilesRenderer
  terrain: TerrariumMeshPlugin
  overlay: SurfaceImageryOverlay
  grids: SurfaceGridCache
  /** Tick once per frame: lets the next grids finish. */
  budget: FrameBudget
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

export function createSurfaceTiles({ floatLinear, upload }: SurfaceTilesOptions): SurfaceTiles {
  const overlay = new SurfaceImageryOverlay()
  protectOverlayBitmaps(overlay)
  const terrain = new TerrariumMeshPlugin({
    url: MAPTERHORN_URL,
    tileDimension: MAPTERHORN_TILE_SIZE,
    maxZoom: MAPTERHORN_MAX_ZOOM,
    // True scale for now: the globe's RELIEF exaggeration reaches the tiles
    // with the shared terrain scale (tides-zmw.9.7).
    heightScale: 1,
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
  applySurfaceFrame(tiles.group)
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

  // The plugin has set each tile's bump scale by the time it reports the
  // model loaded; put it in scene units (see applySurfaceBumpScale).
  tiles.addEventListener('load-model', ({ scene }) => applySurfaceBumpScale(scene, terrain.heightScale))

  // Ocean 404s and failed imagery no longer fail a tile (above); anything
  // else that does is said once, and counted.
  let loadErrors = 0
  tiles.addEventListener('load-error', (event) => {
    loadErrors++
    tiles.group.userData.loadErrors = loadErrors
    if (loadErrors === 1) console.warn('surface tiles: a tile failed to load (more are counted in userData.loadErrors)', event.url)
  })

  // A failed tile stays failed in the library until resetFailedTiles; the
  // grid cache forgets failed grids (terrain-internals.ts), so retry them
  // when the network comes back and every RETRY_FAILED_MS (the library's
  // reset returns at once while stats.failed is 0).
  const retryFailed = () => tiles.resetFailedTiles()
  const retryTimer = setInterval(retryFailed, RETRY_FAILED_MS)
  if (typeof window !== 'undefined') window.addEventListener('online', retryFailed)

  const syncCounters = () => {
    const data = tiles.group.userData
    data.flatTiles = grids.flatTiles
    data.imageryFallbacks = overlay.fallbacks
    data.errorTarget = tiles.errorTarget
  }

  return {
    tiles,
    terrain,
    overlay,
    grids,
    budget,
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
