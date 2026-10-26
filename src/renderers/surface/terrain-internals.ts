// Every 3d-tiles-renderer internal the streamed surface relies on
// (tides-zmw.9.2), in one place, each pinned to 0.5.3 by
// terrain-internals.test.ts so a library bump fails a test instead of
// quietly breaking the ground. Recheck all of it on any bump.
//
// The terrain plugin keeps its elevation grids in a GridCache
// (plugin._gridCache: lock / get / release, keyed x, y, level), whose
// fetchItem asks plugin._source for the tile and draws the decoded image
// onto a canvas on the main thread. That fetch never checks the HTTP status
// (Mapterhorn 404s open ocean, so the whole tile failed and left a hole of
// up to ~2500 km), decodes in one long task per tile, and makes every grid a
// linear-filtered 32-bit float texture (which needs OES_texture_float_linear:
// no iOS). SurfaceGridCache replaces it, keeping the library's neighbour
// stitching and disposal and changing only how a grid is made.
import {
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three'
import { GridCache } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js'
import type { TerrariumMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import type { TilesRenderer } from '3d-tiles-renderer/three'
import type { FrameBudget } from './frame-budget'
import { eitherSignal, fetchWithRetry, RETRY_DELAYS_MS } from './fetch-retry'
import { cancelBody } from './imagery'
import { flatGrid, gridRangeWithin, resampleGrid, type PaddedGrid } from './terrarium'
import type { TerrariumDecode } from './terrariumDecoder'

/** The library version everything here was read from. */
export const PINNED_TILES_VERSION = '0.5.3'

/** plugin._source (an XYZImageSource) as the cache uses it. */
interface SourceInternals {
  getUrl(x: number, y: number, level: number): string
  /** Set by the plugin to route through tiles.downloadQueue. */
  fetchData(url: string, options: RequestInit): Promise<Response>
  fetchOptions: RequestInit
  /** Its tiling scheme: a tile's bounds, normalized (v north, as the grids' rows). */
  tiling: { getTileBounds(x: number, y: number, level: number, normalized: boolean): number[] }
}

/** The terrain plugin's fields the cache reads. */
export interface TerrainPluginInternals {
  name: string
  _gridCache: unknown
  _source: SourceInternals | null
  tileDimension: number
}

/** Statuses meaning "no data here": Mapterhorn answers 404 over open ocean, and past its coverage. */
const EMPTY_STATUSES = new Set([204, 404, 410])

/**
 * The tree levels sharing each fetched grid level (the plugin's
 * EXTRA_LEVELS, pinned): grids exist only at every second level, so a
 * grid's nearest ancestor grid is two levels up.
 */
export const GRID_LEVEL_STEP = 2

export interface SurfaceGridOptions {
  /** 'linear' needs OES_texture_float_linear; 'nearest' is core WebGL2. */
  filter: 'linear' | 'nearest'
  decode: TerrariumDecode
  /** Paces the main-thread end of each grid (texture, stitch, upload). */
  budget: Pick<FrameBudget, 'wait'>
  /** Uploads a finished grid now (renderer.initTexture), not at first draw. */
  upload?: (texture: DataTexture) => void
  /** Overrides RETRY_DELAYS_MS (tests). */
  retryDelays?: readonly number[]
}

const key = (x: number, y: number, level: number) => `${level}/${x}/${y}`

/**
 * Waits for `promise` until `signal` aborts (then rejects with its reason;
 * the promise runs on).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** A grid locked from the cache (release it), with where it sits. */
interface LockedGrid {
  grid: DataTexture
  x: number
  y: number
  level: number
}

/**
 * What the source has for a grid: its decoded data, or none. `fresh`: the
 * grid itself answered "no data" just now; else an ancestor did, and `from`
 * is what that answer was recorded as (a data level, or OCEAN).
 */
type SourceGrid = { padded: PaddedGrid } | { from: number; fresh: boolean }

/** No ancestor grid holds ground here: open water. */
const OCEAN = -1

/** The stand-in a between-levels "no data" leaves in the cache (fetchItem): never data. */
const isPlaceholder = (grid: DataTexture) => (grid.image as { width: number }).width < 3

/**
 * Data grids kept locked after a coverage end read them, the latest this
 * many, where no tile may hold them: those at levels between the plugin's
 * (odd levels: Israel's data, the Dead Sea's, ends at z13), which the grids
 * under that coverage end all read, and those a between-levels "no data"
 * read, which the grid under it reads next.
 */
export const HELD_BETWEEN_GRIDS = 8

export class SurfaceGridCache extends GridCache {
  /** Grids made flat because the source had no data for them (open water). */
  flatTiles = 0
  /**
   * Grids resampled from an ancestor's because the source's coverage ends
   * above them (tides-zmw.9.21): Mapterhorn has nothing finer than z12 over
   * the Himalaya, and answers 404 under it, as over the sea.
   */
  cappedTiles = 0
  /**
   * The tiles the source answered "no data" for under an ancestor grid with
   * ground, as level/x/y: the level of that ancestor (the data level).
   */
  readonly coverageEnd = new Map<string, number>()
  /** The levels coverageEnd holds keys at. */
  private readonly coverageLevels = new Set<number>()
  /** Tiles the source answered "no data" for over open water, as level/x/y. */
  private readonly empty = new Set<string>()
  /** The data grids held (HELD_BETWEEN_GRIDS), oldest first. */
  private readonly held: LockedGrid[] = []
  private readonly options: SurfaceGridOptions
  private readonly lifetime = new AbortController()

  constructor(plugin: TerrainPluginInternals, options: SurfaceGridOptions) {
    super(plugin)
    this.options = options
  }

  /**
   * Whether an ancestor answered "no data", and what it was recorded as:
   * open water (OCEAN), or a coverage end, as the level of the data grid
   * above it, which this grid then reads too; undefined when none did.
   * Mapterhorn's pyramid has data at a level wherever any deeper level does
   * (checked 2026-10-25: the children of the ocean tile 4/6/5 to z7 all 404,
   * while the z4-z10 ancestors of Pico, Tristan da Cunha, St Helena,
   * Ascension and Bouvet all answer), so the whole subtree under a "no data"
   * answer is the same and needn't be asked for. Accepted risk: a CDN 404 on
   * a land tile (a bad deploy, say) draws that tile's whole subtree from its
   * parent's coarser grid for the session (sea level only where that holds
   * none above it).
   */
  private noDataAbove(x: number, y: number, level: number): number | undefined {
    for (let up = 1; up <= level; up++) {
      const k = key(x >> up, y >> up, level - up)
      if (this.empty.has(k)) return OCEAN
      const from = this.coverageEnd.get(k)
      if (from !== undefined) return from
    }
    return undefined
  }

  /**
   * The data level the grid (x, y, level) reads, where it or an ancestor is
   * past the source's coverage (a coverage end); -1 otherwise: data of its
   * own, open water, or not answered yet. The view error's cap reads it
   * (surface-coverage.ts).
   */
  coverageLevel(x: number, y: number, level: number): number {
    // Only the levels holding coverage ends (one or two): it runs per tile traversed.
    for (const at of this.coverageLevels) {
      if (at > level) continue
      const from = this.coverageEnd.get(key(x >> (level - at), y >> (level - at), at))
      if (from !== undefined) return from
    }
    return OCEAN
  }

  /** The tile's response, through the plugin's queue-routed fetch, retried while transient. */
  private fetchResponse(x: number, y: number, level: number, signal: AbortSignal): Promise<Response> {
    const source = (this.plugin as TerrainPluginInternals)._source!
    const url = source.getUrl(x, y, level)
    return fetchWithRetry(
      () => source.fetchData(url, { ...source.fetchOptions, signal }),
      signal,
      this.options.retryDelays ?? RETRY_DELAYS_MS
    )
  }

  private async fetchGrid(x: number, y: number, level: number, signal: AbortSignal): Promise<SourceGrid> {
    const above = this.noDataAbove(x, y, level)
    if (above !== undefined) return { from: above, fresh: false }
    const res = await this.fetchResponse(x, y, level, signal)
    if (EMPTY_STATUSES.has(res.status)) {
      cancelBody(res)
      return { from: OCEAN, fresh: true }
    }
    if (!res.ok) {
      cancelBody(res)
      throw new Error(`surface tiles: terrain tile ${key(x, y, level)} answered ${res.status}`)
    }
    return { padded: await this.options.decode(await res.arrayBuffer(), signal) }
  }

  /**
   * Locks the grid (x, y, level), waiting until it is made or `signal`
   * aborts; what it holds then is the caller's to release. On an abort the
   * lock is let go once the grid settles; a grid that failed holds none
   * (lock() forgot it).
   */
  private async lockGrid(x: number, y: number, level: number, signal: AbortSignal): Promise<LockedGrid> {
    const k = `${x}_${y}_${level}` // DataCache's key
    const result = this.lock(x, y, level)
    const settled = result instanceof Promise ? result : Promise.resolve(result)
    try {
      return { grid: await untilAborted(settled, signal), x, y, level }
    } catch (error) {
      settled.then(
        () => this.release(x, y, level),
        () => {
          if ((this.cache[k] as { result?: unknown } | undefined)?.result === result) this.release(x, y, level)
        }
      )
      throw error
    }
  }

  /** What a "no data" answer for the grid was recorded as: OCEAN, a data level, or undefined (none recorded). */
  private answered(x: number, y: number, level: number): number | undefined {
    const k = key(x, y, level)
    return this.empty.has(k) ? OCEAN : this.coverageEnd.get(k)
  }

  /**
   * The grid a tile the source has no data for reads from: the data grid
   * above it, locked, or null over open water. A fresh "no data" answer
   * asks the tile a level up, which at an odd level is not one of the
   * plugin's grids (the source's coverage can end there: Israel's at z13),
   * and its own "no data" asks its parent's grid (cached, as a rule: the
   * traversal loads a parent before its children). The answer is recorded
   * as a coverage end under data or as open water once read (fetchItem).
   */
  private async dataAbove(x: number, y: number, level: number, from: number, fresh: boolean, signal: AbortSignal): Promise<LockedGrid | null> {
    const lockAt = (at: number) => (at === OCEAN ? null : this.lockGrid(x >> (level - at), y >> (level - at), at, signal))
    if (!fresh) return lockAt(from)
    if (level === 0) return null
    // Answered above while this grid was being fetched (a sibling's "no
    // data", at any level up): read what that was recorded as. Checked in
    // the same turn as the lock below, which would otherwise make the tile
    // a level up from that answer without recording it, a placeholder.
    const late = this.noDataAbove(x, y, level)
    if (late !== undefined) return lockAt(late)
    const up = level - 1
    const known = this.answered(x >> 1, y >> 1, up)
    if (known !== undefined) return lockAt(known)
    const above = await this.lockGrid(x >> 1, y >> 1, up, signal)
    const answer = this.answered(above.x, above.y, up)
    if (answer === undefined && !isPlaceholder(above.grid)) return above
    this.release(above.x, above.y, up)
    if (answer !== undefined) return lockAt(answer)
    // A placeholder all the same (never data): what the answer above it says.
    return lockAt(this.noDataAbove(x, y, level) ?? OCEAN)
  }

  /** Keeps a data grid locked a while (HELD_BETWEEN_GRIDS), the least recently read let go first. */
  private hold(grid: LockedGrid): void {
    const at = this.held.findIndex((h) => h.x === grid.x && h.y === grid.y && h.level === grid.level)
    if (at >= 0) {
      this.held.push(...this.held.splice(at, 1))
      return
    }
    this.lock(grid.x, grid.y, grid.level)
    this.held.push(grid)
    if (this.held.length > HELD_BETWEEN_GRIDS) {
      const old = this.held.shift()!
      this.release(old.x, old.y, old.level)
    }
  }

  /** The tile's rectangle in an ancestor's, normalized (the plugin's _getSubview). */
  private subview(x: number, y: number, level: number, above: LockedGrid): number[] {
    const { tiling } = (this.plugin as TerrainPluginInternals)._source!
    const [a0, b0, a1, b1] = tiling.getTileBounds(above.x, above.y, above.level, true)
    const [u0, v0, u1, v1] = tiling.getTileBounds(x, y, level, true)
    const iw = 1 / (a1 - a0)
    const ih = 1 / (b1 - b0)
    return [(u0 - a0) * iw, (v0 - b0) * ih, (u1 - a0) * iw, (v1 - b0) * ih]
  }

  /**
   * Stops every fetch, retry and decode in flight (createSurfaceTiles'
   * dispose): the plugin releases its grids as tiles go, but a load still
   * downloading would otherwise run on, retries and all, after the surface
   * is gone.
   */
  shutDown(): void {
    this.lifetime.abort(new DOMException('surface tiles disposed', 'AbortError'))
    for (const grid of this.held.splice(0)) this.release(grid.x, grid.y, grid.level)
  }

  /**
   * As the library's, but forgets a grid that failed for any reason but an
   * abort (5xx after the retries, 403, a corrupt image). The plugin rethrows
   * such a failure before it records the grid, so nothing ever releases it:
   * the rejected promise would stay cached and fail every tile reading that
   * grid, up to five, for the rest of the session, retries included.
   */
  override lock(x: number, y: number, level: number): DataTexture | Promise<DataTexture> {
    const k = `${x}_${y}_${level}` // DataCache's key
    const fresh = !(k in this.cache)
    const result = super.lock(x, y, level)
    if (fresh && result instanceof Promise) {
      result.catch((error) => {
        if ((error as Error)?.name === 'AbortError' || this.cache[k] === undefined) return
        if ((this.cache[k] as { result: unknown }).result !== result) return
        delete this.cache[k]
        this.count--
      })
    }
    return result
  }

  override async fetchItem([x, y, level]: [number, number, number], itemSignal: AbortSignal): Promise<DataTexture> {
    const { filter, budget, upload } = this.options
    const tileDimension = (this.plugin as TerrainPluginInternals).tileDimension
    const { signal, release } = eitherSignal(itemSignal, this.lifetime.signal)
    let source: SourceGrid
    let above: LockedGrid | null = null
    try {
      source = await this.fetchGrid(x, y, level, signal)
      if ('from' in source) above = await this.dataAbove(x, y, level, source.from, source.fresh, signal)
      await budget.wait(signal)
      signal.throwIfAborted()
    } catch (error) {
      if (above) this.release(above.x, above.y, above.level)
      throw error
    } finally {
      release()
    }
    // A grid between the plugin's levels is only ever asked for by
    // dataAbove: never drawn, so never stitched or uploaded.
    const between = level % GRID_LEVEL_STEP !== 0
    let padded = 'padded' in source ? source.padded : null
    if (!('padded' in source)) {
      // No data here (tides-zmw.9.21): past the source's coverage, the data
      // grid above resampled, so the tile draws (and its region bounds, and
      // the ship's floor reads) the coarser ground, not a sea-level slab the
      // library would cull, hiding its parent too. Mapterhorn's sea is
      // exactly 0 m (no bathymetry), so where the data above holds nothing
      // but 0 there it is open water: sea level, full size (stitching
      // assumes every grid is the same size). Land below the sea (the Dead
      // Sea, the Caspian) resamples like any other.
      let sea = true
      if (above) {
        try {
          const image = above.grid.image as unknown as PaddedGrid
          const sub = this.subview(x, y, level, above)
          const [min, max] = gridRangeWithin(image, sub)
          sea = min === 0 && max === 0
          if (!sea && !between) padded = resampleGrid(image, sub, tileDimension)
          if (!sea && (between || above.level % GRID_LEVEL_STEP !== 0)) this.hold(above)
        } finally {
          this.release(above.x, above.y, above.level)
        }
      }
      if (source.fresh) {
        if (sea) {
          this.empty.add(key(x, y, level))
        } else {
          this.coverageEnd.set(key(x, y, level), above!.level)
          this.coverageLevels.add(level)
        }
      }
      if (between) {
        // the answer is recorded; a placeholder for the cache, never read
        padded = { data: new Float32Array(1), width: 1, height: 1 }
      } else if (padded) {
        this.cappedTiles++
      } else {
        padded = flatGrid(tileDimension)
        this.flatTiles++
      }
    }
    const grid = new DataTexture(padded.data, padded.width, padded.height, RedFormat, FloatType)
    grid.minFilter = grid.magFilter = filter === 'linear' ? LinearFilter : NearestFilter
    grid.needsUpdate = true
    if (!between) {
      this.stitchNeighbors(grid, x, y, level)
      upload?.(grid)
    }
    // If the cache drops the item before taking this result, it never
    // disposes it; the abort is the only word of that. (A normal release
    // aborts too, then disposes: a second dispose is a no-op.)
    itemSignal.addEventListener('abort', () => grid.dispose(), { once: true })
    return grid
  }
}

/**
 * Replaces the plugin's grid cache. Call before registering the plugin:
 * nothing may have been locked from the old one.
 */
export function installSurfaceGridCache(plugin: TerrariumMeshPlugin, options: SurfaceGridOptions): SurfaceGridCache {
  const internals = plugin as unknown as TerrainPluginInternals
  const current = internals._gridCache as { lock?: unknown } | null
  if (internals.name !== 'TERRARIUM_MESH_PLUGIN' || typeof current?.lock !== 'function') {
    throw new Error('surface tiles: not a 0.5.3 TerrariumMeshPlugin')
  }
  const cache = new SurfaceGridCache(internals, options)
  internals._gridCache = cache
  return cache
}

interface TilesetJson {
  asset?: { version?: string }
}

/**
 * The plugin's synthetic tileset says asset.version '1.1', which the
 * renderer reads only to warn that 1.1 has limited support, once per
 * instance (each ship-mode entry). Pass it on as '1.0' instead.
 */
export function quietTilesetVersion(tiles: TilesRenderer): void {
  const t = tiles as unknown as { preprocessTileset(json: TilesetJson, url: string, parent?: unknown): void }
  const original = t.preprocessTileset
  t.preprocessTileset = function (json, url, parent) {
    const quiet = json?.asset?.version === '1.1' ? { ...json, asset: { ...json.asset, version: '1.0' } } : json
    return original.call(this, quiet, url, parent)
  }
}

/** TilesRendererBase's loading states (core/renderer/constants.js). */
const TILE_UNLOADED = 0
const TILE_FAILED = -1

/** The renderer's fields retryFailedTiles reads and writes. */
interface FailedTileInternals {
  rootLoadingState: number
  stats: { failed: number }
  lruCache: {
    /** Every tile the cache holds: queued, loading, loaded or failed. */
    itemList: readonly { internal?: { loadingState?: number } }[]
    /** Evicts the tile: its dispose runs and its state goes back to UNLOADED. */
    remove(tile: unknown): boolean
  }
}

/** The longest a failed tile waits between retries. */
export const RETRY_BACKOFF_MAX_MS = 300_000
/** A retry this much early is on time (the timer's ticks drift). */
const RETRY_SLACK_MS = 1000

/**
 * When each failed tile may next be retried: the first retry at once, the
 * next firstMs later, then twice as long each time, up to maxMs. A tile
 * that fails for good (a 403, a corrupt image) is otherwise asked for every
 * tick for the rest of the session, three requests a time for a 5xx
 * (fetchWithRetry), with the library's two console errors each.
 */
export class FailedTileBackoff {
  private entries = new WeakMap<object, { n: number; nextAt: number }>()
  readonly firstMs: number
  readonly maxMs: number

  constructor(firstMs: number, maxMs = RETRY_BACKOFF_MAX_MS) {
    this.firstMs = firstMs
    this.maxMs = maxMs
  }

  /** Whether the tile may be retried at now (ms). */
  due(tile: object, now: number): boolean {
    const entry = this.entries.get(tile)
    return !entry || now + RETRY_SLACK_MS >= entry.nextAt
  }

  /** Records a retry at now: the next one waits twice as long as the last. */
  retried(tile: object, now: number): void {
    const entry = this.entries.get(tile)
    // Long past due, it loaded since and has failed afresh: start over.
    const n = entry && now - entry.nextAt <= this.maxMs ? entry.n + 1 : 1
    this.entries.set(tile, { n, nextAt: now + Math.min(this.firstMs * 2 ** (n - 1), this.maxMs) })
  }

  /** Forgets every tile's schedule (the network is back). */
  clear(): void {
    this.entries = new WeakMap()
  }
}

/**
 * Has every tile that failed to load (tides-zmw.9.20), and is due a retry
 * by backoff (all of them without one), load again on the renderer's next
 * update, and returns how many it reset. Not the library's
 * resetFailedTiles: that walks the whole tree reading each tile's .internal,
 * which the terrain plugin's lazily expanded children lack until a traversal
 * preprocesses them (so it throws), and it leaves a reset tile in the LRU
 * cache, whose add then refuses it, so the tile is never requested again.
 * A failed tile stays in the cache (marked loaded) until evicted, and an
 * eviction puts it back to UNLOADED: so evict each failed one, as the cache
 * itself would, and the next traversal requests it afresh (its grid too:
 * SurfaceGridCache forgot the failed one). stats.failed is left at the
 * tiles still failing (the library zeroes it; an evicted failed tile never
 * decrements it).
 */
export function retryFailedTiles(tiles: TilesRenderer, backoff?: FailedTileBackoff, now = Date.now()): number {
  const t = tiles as unknown as FailedTileInternals
  if (t.rootLoadingState === TILE_FAILED) t.rootLoadingState = TILE_UNLOADED
  if (t.stats.failed === 0) return 0
  const failed = t.lruCache.itemList.filter((tile) => tile?.internal?.loadingState === TILE_FAILED)
  let reset = 0
  for (const tile of failed) {
    if (backoff && !backoff.due(tile, now)) continue
    backoff?.retried(tile, now)
    t.lruCache.remove(tile)
    reset++
  }
  t.stats.failed = failed.length - reset
  return reset
}

/**
 * Retries failed tiles every intervalMs, each on its own backoff, and all
 * of them at once when the network comes back ('online' on target, which
 * clears the backoff). Counts the tiles reset in group.userData.retriedTiles.
 * A throw here would be a page error each tick, so it's said once and
 * dropped. Returns the stop.
 */
export function startFailedTileRetry(
  tiles: TilesRenderer,
  intervalMs: number,
  target: EventTarget | null = typeof window !== 'undefined' ? window : null
): () => void {
  const backoff = new FailedTileBackoff(intervalMs)
  let retried = 0
  let warned = false
  const retry = () => {
    try {
      const reset = retryFailedTiles(tiles, backoff)
      if (reset > 0) tiles.group.userData.retriedTiles = retried += reset
    } catch (error) {
      if (!warned) console.warn('surface tiles: retrying failed tiles threw (said once)', error)
      warned = true
    }
  }
  const online = () => {
    backoff.clear()
    retry()
  }
  const timer = setInterval(retry, intervalMs)
  target?.addEventListener('online', online)
  return () => {
    clearInterval(timer)
    target?.removeEventListener('online', online)
  }
}

/** overlay.imageSource (an XYZImageSource) as protectOverlayBitmaps patches it. */
interface TiledImageSourceInternals {
  processBufferToTexture(buffer: ArrayBuffer): Promise<Texture>
  disposeItem(texture: Texture | null): void
}

const noClose = () => {}

/**
 * The library's TilesRenderer closes the ImageBitmap of every texture on a
 * tile's materials when it drops the tile, and when a parse finishes after
 * its load was aborted. The terrain plugin's overlay map is a clone sharing
 * the overlay cache's bitmap, and that bitmap can outlive the tile: the
 * terrain tree runs a level past the imagery's deepest (16), so a z16 tile
 * drapes the cached z16 image itself while its z17 children compose theirs
 * from it. Dropping the z16 tile would close the image the cache still
 * holds for the children (a z17 tile loading next fails to draw from it; a
 * clone of it uploads 0x0, black). Make each overlay bitmap closable only by
 * the cache that made it: its own close is a no-op, and the cache's dispose
 * closes it for real.
 */
export function protectOverlayBitmaps(overlay: XYZTilesOverlay): void {
  const source = (overlay as unknown as { imageSource: TiledImageSourceInternals }).imageSource
  const process = source.processBufferToTexture.bind(source)
  const dispose = source.disposeItem.bind(source)
  source.processBufferToTexture = async (buffer) => {
    const texture = await process(buffer)
    const bitmap = texture.image
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) {
      Object.defineProperty(bitmap, 'close', { value: noClose, configurable: true })
    }
    return texture
  }
  source.disposeItem = (texture) => {
    dispose(texture)
    const bitmap = texture?.image
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) ImageBitmap.prototype.close.call(bitmap)
  }
}

/**
 * The tile bytes the cache counts are three's estimate of each tile's scene,
 * which counts the elevation grid whole for every tile that reads it: up to
 * five, the tile at the grid's level and its four children (the plugin
 * fetches every other level), ~2 in the cache on average (1.6-2.2 tiles per
 * grid at headless canyon poses). A grid (1 MB) is most of a tile's bytes,
 * so the cache counted ~2x what the tiles hold and refused tiles at a 3 km
 * 1080p pose. Charge each tile half its grid instead, through the
 * renderer's (undocumented) calculateBytesUsed plugin hook, whose results it
 * sums over the plugins and itself.
 */
export const GRID_READERS = 2

export function shareGridBytes(tiles: TilesRenderer): void {
  const plugin = {
    name: 'SURFACE_GRID_BYTES',
    calculateBytesUsed(_tile: unknown, scene: Object3D | null) {
      let bytes = 0
      scene?.traverse((object) => {
        const map = ((object as Mesh).material as MeshStandardMaterial | undefined)?.displacementMap
        const image = map?.image as { width?: number; height?: number } | undefined
        if (image?.width && image.height) bytes -= image.width * image.height * 4 * (1 - 1 / GRID_READERS)
      })
      return bytes
    },
  }
  tiles.registerPlugin(plugin as unknown as Parameters<TilesRenderer['registerPlugin']>[0])
}

/**
 * Calls `callback(scene, tile)` for every tile with a loaded scene, as
 * TilesRenderer.forEachLoadedModel does, from the renderer's LRU cache's
 * item list (lruCache.itemList, every tile it holds or is loading) instead
 * of a walk of the whole tile tree: ~300 cached tiles against ~15,000 tree
 * nodes at a canyon pose, 0.2 ms a call (headless, tides-zmw.9.8), which the
 * ship's floor pays every frame.
 */
export function forEachCachedModel(tiles: TilesRenderer, callback: (scene: Object3D, tile: unknown) => void): void {
  const items = (tiles.lruCache as unknown as { itemList: readonly { engineData?: { scene?: Object3D | null } }[] }).itemList
  for (const tile of items) {
    const scene = tile.engineData?.scene
    if (scene) callback(scene, tile)
  }
}
