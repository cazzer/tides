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
import { DataTexture, FloatType, LinearFilter, NearestFilter, RedFormat, type Texture } from 'three'
import { GridCache } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js'
import type { TerrariumMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import type { TilesRenderer } from '3d-tiles-renderer/three'
import type { FrameBudget } from './frame-budget'
import { cancelBody } from './imagery'
import { flatGrid, type PaddedGrid } from './terrarium'
import type { TerrariumDecode } from './terrariumDecoder'

/** The library version everything here was read from. */
export const PINNED_TILES_VERSION = '0.5.3'

/** plugin._source (an XYZImageSource) as the cache uses it. */
interface SourceInternals {
  getUrl(x: number, y: number, level: number): string
  /** Set by the plugin to route through tiles.downloadQueue. */
  fetchData(url: string, options: RequestInit): Promise<Response>
  fetchOptions: RequestInit
}

/** The terrain plugin's fields the cache reads. */
export interface TerrainPluginInternals {
  name: string
  _gridCache: unknown
  _source: SourceInternals | null
  tileDimension: number
}

/** Statuses meaning "no data here": Mapterhorn answers 404 over open ocean. */
const EMPTY_STATUSES = new Set([204, 404, 410])

/**
 * Waits between retries of a transient failure (a network error, 429 or
 * 5xx): without them, one dropped request for a z4 tile failed ~2500 km of
 * ground for the rest of the flight (seen once in a headless descent).
 */
export const RETRY_DELAYS_MS = [1000, 4000]
const transient = (status: number) => status === 429 || status >= 500

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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

export class SurfaceGridCache extends GridCache {
  /** Grids made flat because the source had no data for them. */
  flatTiles = 0
  /** Tiles the source answered "no data" for, as level/x/y. */
  private readonly empty = new Set<string>()
  private readonly options: SurfaceGridOptions

  constructor(plugin: TerrainPluginInternals, options: SurfaceGridOptions) {
    super(plugin)
    this.options = options
  }

  /**
   * Whether an ancestor answered "no data": Mapterhorn's pyramid has data at
   * a level wherever any deeper level does (checked 2026-10-25: the children
   * of the ocean tile 4/6/5 to z7 all 404, while the z4-z10 ancestors of
   * Pico, Tristan da Cunha, St Helena, Ascension and Bouvet all answer), so
   * the whole subtree is open water and needn't be asked for.
   */
  private underEmpty(x: number, y: number, level: number): boolean {
    for (let up = 1; up <= level; up++) {
      if (this.empty.has(key(x >> up, y >> up, level - up))) return true
    }
    return false
  }

  /** The tile's response, through the plugin's queue-routed fetch, retried while transient. */
  private async fetchResponse(x: number, y: number, level: number, signal: AbortSignal): Promise<Response> {
    const source = (this.plugin as TerrainPluginInternals)._source!
    const url = source.getUrl(x, y, level)
    const delays = this.options.retryDelays ?? RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= delays.length
      try {
        const res = await source.fetchData(url, { ...source.fetchOptions, signal })
        if (last || !transient(res.status)) return res
        cancelBody(res)
      } catch (error) {
        if (last || signal.aborted || (error as Error)?.name === 'AbortError') throw error
      }
      await sleep(delays[attempt], signal)
    }
  }

  private async fetchGrid(x: number, y: number, level: number, signal: AbortSignal): Promise<PaddedGrid | null> {
    if (this.underEmpty(x, y, level)) return null
    const res = await this.fetchResponse(x, y, level, signal)
    if (EMPTY_STATUSES.has(res.status)) {
      cancelBody(res)
      this.empty.add(key(x, y, level))
      return null
    }
    if (!res.ok) {
      cancelBody(res)
      throw new Error(`surface tiles: terrain tile ${key(x, y, level)} answered ${res.status}`)
    }
    return this.options.decode(await res.arrayBuffer(), signal)
  }

  override async fetchItem([x, y, level]: [number, number, number], signal: AbortSignal): Promise<DataTexture> {
    const { filter, budget, upload } = this.options
    let padded = await this.fetchGrid(x, y, level, signal)
    if (!padded) {
      // sea level, full size: stitching assumes every grid is the same size
      padded = flatGrid((this.plugin as TerrainPluginInternals).tileDimension)
      this.flatTiles++
    }
    await budget.wait(signal)
    const grid = new DataTexture(padded.data, padded.width, padded.height, RedFormat, FloatType)
    grid.minFilter = grid.magFilter = filter === 'linear' ? LinearFilter : NearestFilter
    grid.needsUpdate = true
    this.stitchNeighbors(grid, x, y, level)
    upload?.(grid)
    // If the cache drops the item before taking this result, it never
    // disposes it; the abort is the only word of that. (A normal release
    // aborts too, then disposes: a second dispose is a no-op.)
    signal.addEventListener('abort', () => grid.dispose(), { once: true })
    return grid
  }
}

/**
 * Replaces the plugin's grid cache. Call before registering the plugin:
 * nothing may have been locked from the old one.
 */
export function installSurfaceGridCache(plugin: TerrariumMeshPlugin, options: SurfaceGridOptions): SurfaceGridCache {
  const internals = plugin as unknown as TerrainPluginInternals
  if (internals.name !== 'TERRARIUM_MESH_PLUGIN' || !(internals._gridCache instanceof Object)) {
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
