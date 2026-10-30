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
//
// tides-zmw.9.15: each grid also gets its horizon map for the tiles' cast
// shadows (terrarium.ts bakeTileHorizon, tile-shadow.ts). The grid is made
// (and drawn) first; its bake follows in a decode worker, from a copy of
// the grid and windows of the grids around it (the search reaches 12 km,
// past the grid's edge): its loaded same-level neighbours at their own
// texels, then its ancestors up the chain. Neighbours and ancestors still
// loading are waited for (HORIZON_CONTEXT_WAIT_MS); a grid baked without a
// neighbour that turns up later is baked again (HORIZON_REBAKE_DELAY_MS),
// so the two agree at their shared edge whatever the load order. Neighbours
// across the antimeridian are left out (their tile x wraps; the context is
// cut there and ancestors fill in). Open water (a flat sea-level grid) has
// no map, nor does anything when no worker bakes. The map is kept by the
// grid's texture source (gridHorizon()): the tiles' displacement maps are
// clones of the grid, and a clone shares its original's Source (not its
// userData), so the lookup finds the map from any of them, including a map
// that arrives after the tile was made (tile-shadow.ts reads it lazily).
// Freed with the grid.
import {
  ClampToEdgeWrapping,
  DataArrayTexture,
  DataTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Source,
  type Texture,
} from 'three'
import { GridCache } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js'
import type { TerrariumMeshPlugin, XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import type { TilesRenderer } from '3d-tiles-renderer/three'
import type { FrameBudget } from './frame-budget'
import { keepSourceOnClone, type GridEdges, type TexelRect } from './grid-upload'
import { eitherSignal, fetchWithRetry, RETRY_DELAYS_MS } from './fetch-retry'
import { cancelBody } from './imagery'
import {
  flatGrid,
  gridRangeWithin,
  horizonWindow,
  resampleGrid,
  TILE_HORIZON_LAYERS,
  TILE_HORIZON_MARGIN_TEXELS,
  TILE_HORIZON_RADIUS,
  TILE_HORIZON_REACH_METRES,
  tileHorizonSize,
  mercatorLatitude,
  type HorizonJob,
  type HorizonSource,
  type PaddedGrid,
} from './terrarium'
import type { BakedHorizon, TerrariumBake, TerrariumDecode } from './terrariumDecoder'

/** A grid that gets a horizon map (SurfaceGridCache.startHorizon). */
interface HorizonGrid {
  grid: DataTexture
  x: number
  y: number
  level: number
  first?: HorizonSource
  /** The neighbours' keys its latest bake went without. */
  without: string[]
  running: boolean
  /** Bake again when this one is done. */
  again: boolean
  timer?: ReturnType<typeof setTimeout>
  /** When the first neighbour of the pending rebake turned up (performance.now()). */
  since?: number
  /** Aborts on the grid's dispose. */
  gone: AbortController
}

/** The library version everything here was read from. */
export const PINNED_TILES_VERSION = '0.5.3'

/** plugin._source (an XYZImageSource) as the cache uses it. */
interface SourceInternals {
  getUrl(x: number, y: number, level: number): string
  /** Set by the plugin to route through tiles.downloadQueue. */
  fetchData(url: string, options: RequestInit): Promise<Response>
  fetchOptions: RequestInit
  /** Its tiling scheme: a tile's bounds, normalized (v north, as the grids' rows); a level's tile count; whether tile y runs south. */
  tiling: {
    getTileBounds(x: number, y: number, level: number, normalized: boolean): number[]
    getLevel(level: number): { tileCountX: number }
    flipY: boolean
  }
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

/**
 * A tile's elevation range as the terrain plugin measured it (its
 * HEIGHT_RANGE, a module-private Symbol('HEIGHT_RANGE') own property, set at
 * the end of _createTerrainMesh): the grid sampled at each surface vertex's
 * uv, so exactly the heights the GPU displaces the vertices by, in metres
 * before the height scale. Set in parseToMesh, so by processTileModel; a
 * child holds its parent's until its own mesh is made. Null when the tile
 * carries none (tides-zmw.9.33, flat-tiles.ts).
 */
export function tileHeightRange(tile: object): { min: number; max: number } | null {
  const symbol = Object.getOwnPropertySymbols(tile).find((s) => s.description === 'HEIGHT_RANGE')
  const range = symbol && (tile as Record<symbol, { min?: unknown; max?: unknown } | undefined>)[symbol]
  return range && typeof range.min === 'number' && typeof range.max === 'number' ? { min: range.min, max: range.max } : null
}

export interface SurfaceGridOptions {
  /** 'linear' needs OES_texture_float_linear; 'nearest' is core WebGL2. */
  filter: 'linear' | 'nearest'
  decode: TerrariumDecode
  /** Bakes grids' horizon maps in a worker (tides-zmw.9.15); without it, grids have none. */
  bake?: TerrariumBake
  /** Whether bake would run now (the decoder's bakes): false, and no horizon work is done at all. */
  canBake?: () => boolean
  /** Paces the main-thread end of each grid (texture, stitch, upload) and each bake's copying, grids first. */
  budget: Pick<FrameBudget, 'run'>
  /** Uploads a finished grid (and its horizon map) now (renderer.initTexture), not at first draw. */
  upload?: (texture: Texture) => void
  /**
   * Sends the borders stitched into loaded neighbours alone, into their GPU
   * copies, and keeps the tiles' clones from marking a grid for upload
   * (tides-zmw.9.27, grid-upload.ts). Without it, as the library: a
   * stitched neighbour, and every clone, marks the grid for a full re-upload.
   */
  edges?: GridEdges
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

/** Each grid's horizon map (tides-zmw.9.15), by the grid's texture source. */
const horizons = new WeakMap<Source, DataArrayTexture>()

/**
 * The horizon map of the grid `texture` is (or is a clone of: the tiles'
 * displacement maps), or null: none baked (open water, flat ground, no
 * worker), or not a grid.
 */
export function gridHorizon(texture: Texture | null | undefined): DataArrayTexture | null {
  return (texture?.source && horizons.get(texture.source)) || null
}

/**
 * Gives `grid` its horizon map, freed when the grid is disposed; a map it
 * had is freed now (tiles holding clones of it keep its GPU copy until they
 * look again: tile-shadow.ts).
 */
export function setGridHorizon(grid: Texture, horizon: DataArrayTexture): void {
  const old = horizons.get(grid.source)
  horizons.set(grid.source, horizon)
  if (old) {
    old.dispose()
    return
  }
  const gone = () => {
    grid.removeEventListener('dispose', gone)
    horizons.get(grid.source)?.dispose()
    horizons.delete(grid.source)
  }
  grid.addEventListener('dispose', gone)
}

/** Grids whose horizon bake is under way (charged as if baked: shareGridBytes runs once, when the tile loads). */
const baking = new WeakSet<Source>()

/** The bytes of the grid `texture`'s horizon map, baked or under way. */
export function gridHorizonBytes(texture: Texture | null | undefined): number {
  const horizon = gridHorizon(texture)?.image as { width?: number; height?: number; depth?: number } | undefined
  if (horizon?.width && horizon.height) return horizon.width * horizon.height * (horizon.depth ?? 1) * 4
  const image = texture?.image as { width?: number } | undefined
  return texture?.source && baking.has(texture.source) && image?.width ? horizonBytes(image.width - 2) : 0
}

/** The bytes of a horizon map for a source tile size (two RGBA8 layers). */
export function horizonBytes(tileSize: number): number {
  const side = tileHorizonSize(tileSize)
  return side * side * TILE_HORIZON_LAYERS * 4
}

/** A baked horizon map as the texture the tiles read (tile-shadow.ts). */
export function horizonTexture(bytes: Uint8Array<ArrayBuffer>, tileSize: number): DataArrayTexture {
  const side = tileHorizonSize(tileSize)
  const texture = new DataArrayTexture(bytes, side, side, TILE_HORIZON_LAYERS)
  texture.format = RGBAFormat
  texture.type = UnsignedByteType
  // Magnified wherever a tile draws (a quarter of the grid's texels): no mips.
  texture.generateMipmaps = false
  texture.minFilter = texture.magFilter = LinearFilter
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping
  texture.colorSpace = NoColorSpace
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

/** How long a bake waits for neighbours and ancestors still loading before it goes without them, ms (the grid itself never waits). */
export const HORIZON_CONTEXT_WAIT_MS = 1500
/** A same-level neighbour's window, in its texels past the shared edge (the band where an ancestor's 4x coarser texels would soften a ridge). */
export const HORIZON_NEIGHBOUR_MARGIN_TEXELS = 48
/**
 * A grid baked without a neighbour is baked again once its neighbours stop
 * turning up for this long (each arrival restarts it), ms ...
 */
export const HORIZON_REBAKE_DELAY_MS = 1000
/** ... but no later than this after the first of them, ms. */
export const HORIZON_REBAKE_MAX_DELAY_MS = 3000

/** What the horizon bakes cost (the headless checks read it). */
export interface HorizonStats {
  /** Maps baked, and bakes that found no horizon (left without one); rebakes count here too. */
  baked: number
  empty: number
  /** Bakes again for a neighbour that turned up after a grid's bake. */
  rebakes: number
  /** Worker time, ms: total and longest. */
  bakeMs: number
  bakeMaxMs: number
  /** Main thread: gathering the windows and the grid's copy, and the map's upload, longest, ms. */
  contextMaxMs: number
  uploadMaxMs: number
}

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
  readonly horizonStats: HorizonStats = { baked: 0, empty: 0, rebakes: 0, bakeMs: 0, bakeMaxMs: 0, contextMaxMs: 0, uploadMaxMs: 0 }
  /** The grids that get a horizon map, by key, while they live. */
  private readonly horizonGrids = new Map<string, HorizonGrid>()
  /** A neighbour's key → the grids whose latest bake went without it, baked again once it is made. */
  private readonly bakedWithout = new Map<string, Set<string>>()

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

  /** Whether a horizon bake would run now. */
  private bakes(): boolean {
    return !!this.options.bake && (this.options.canBake?.() ?? true)
  }

  /**
   * Starts the horizon of a grid just made (fetchItem's end): baked once
   * its context settles, without holding the grid up, and again whenever a
   * neighbour it went without is made. `first` leads its context (a capped
   * grid's data grid: kept, and copied for each bake).
   */
  private startHorizon(grid: DataTexture, x: number, y: number, level: number, first?: HorizonSource): void {
    if (!this.bakes()) return
    const k = key(x, y, level)
    const entry: HorizonGrid = { grid, x, y, level, first, without: [], running: false, again: false, gone: new AbortController() }
    this.horizonGrids.set(k, entry)
    baking.add(grid.source)
    const onDispose = () => {
      grid.removeEventListener('dispose', onDispose)
      entry.gone.abort(new DOMException('grid released', 'AbortError'))
      clearTimeout(entry.timer)
      this.setWithout(k, entry, [])
      if (this.horizonGrids.get(k) === entry) this.horizonGrids.delete(k)
      baking.delete(grid.source)
    }
    grid.addEventListener('dispose', onDispose)
    this.runBake(k, entry)
  }

  /** Bakes entry's map (once more after this one, if asked while it runs); a failure leaves the map it had. */
  private runBake(k: string, entry: HorizonGrid): void {
    if (entry.running) {
      entry.again = true
      return
    }
    if (entry.gone.signal.aborted || !this.bakes()) return
    entry.running = true
    const { signal, release } = eitherSignal(entry.gone.signal, this.lifetime.signal)
    const tileSize = (this.plugin as TerrainPluginInternals).tileDimension
    this.horizonJob(k, entry, signal)
      .then((job) => (job ? this.options.bake!(job.horizon, job.grid, signal) : null))
      .then((baked) => {
        if (!signal.aborted) this.attachHorizon(entry.grid, baked, tileSize)
      })
      .catch(() => {})
      .finally(() => {
        release()
        entry.running = false
        if (entry.again) {
          entry.again = false
          this.runBake(k, entry)
        }
      })
  }

  /** A grid was made: the grids baked without it are baked again, shortly. */
  private neighbourMade(x: number, y: number, level: number): void {
    const k = key(x, y, level)
    const waiting = this.bakedWithout.get(k)
    if (!waiting) return
    this.bakedWithout.delete(k)
    for (const g of waiting) {
      const entry = this.horizonGrids.get(g)
      if (!entry) continue
      entry.without = entry.without.filter((w) => w !== k)
      // debounced: neighbours come in waves
      const now = performance.now()
      entry.since ??= now
      clearTimeout(entry.timer)
      entry.timer = setTimeout(
        () => {
          entry.timer = entry.since = undefined
          if (entry.gone.signal.aborted) return
          this.horizonStats.rebakes++
          this.runBake(g, entry)
        },
        Math.max(0, Math.min(HORIZON_REBAKE_DELAY_MS, entry.since + HORIZON_REBAKE_MAX_DELAY_MS - now))
      )
    }
  }

  /** Records the neighbours entry's latest bake went without. */
  private setWithout(k: string, entry: HorizonGrid, without: string[]): void {
    for (const w of entry.without) {
      const set = this.bakedWithout.get(w)
      if (!set) continue
      set.delete(k)
      if (!set.size) this.bakedWithout.delete(w)
    }
    entry.without = without
    for (const w of without) {
      let set = this.bakedWithout.get(w)
      if (!set) this.bakedWithout.set(w, (set = new Set()))
      set.add(k)
    }
  }

  /** The grid (x, y, level) if it is made and holds ground to read, else null. */
  private readable(x: number, y: number, level: number): DataTexture | null {
    const entry = this.get(x, y, level) as DataTexture | Promise<DataTexture> | null
    if (!entry || entry instanceof Promise || isPlaceholder(entry)) return null
    const image = entry.image as unknown as PaddedGrid
    return image?.data && image.width >= 3 ? entry : null
  }

  /**
   * The grid's horizon job (terrarium.ts HorizonJob) and a copy of the grid:
   * its bounds, then windows of the grids around it, nearest detail first:
   * entry.first, its same-level neighbours (HORIZON_NEIGHBOUR_MARGIN_TEXELS
   * at their own texels; none across the antimeridian), and each ancestor
   * up the chain (every GRID_LEVEL_STEP levels) until one's margin covers
   * TILE_HORIZON_REACH_METRES. Grids still loading are waited for (up to
   * HORIZON_CONTEXT_WAIT_MS: the traversal loads parents and siblings
   * together); grids not asked for are not fetched for this. The windows
   * are read (and copied, paced by the budget) once that settles, from the
   * grids as they then stand.
   */
  private async horizonJob(k: string, entry: HorizonGrid, signal: AbortSignal): Promise<{ horizon: HorizonJob; grid: PaddedGrid } | null> {
    const source = (this.plugin as TerrainPluginInternals)._source
    if (!source) return null
    const { x, y, level } = entry
    const tileSize = (this.plugin as TerrainPluginInternals).tileDimension
    const [, south, , north] = source.tiling.getTileBounds(x, y, level, true)
    const pending: Promise<unknown>[] = []
    const watch = (at: number, ax: number, ay: number) => {
      const grid = this.get(ax, ay, at) as DataTexture | Promise<DataTexture> | null
      if (grid instanceof Promise) pending.push(grid.catch(() => {}))
      return grid
    }
    const neighbours: [number, number][] = []
    const across = 2 ** level
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < across && ny < across) {
          neighbours.push([nx, ny])
          watch(level, nx, ny)
        }
      }
    }
    // Ancestors' metres per texel, at the grid's middle.
    const metres = (at: number) =>
      (2 * Math.PI * TILE_HORIZON_RADIUS * Math.cos(mercatorLatitude((south + north) / 2)) * (north - south) * 2 ** (level - at)) / tileSize
    const ancestors: [number, number, number][] = []
    for (let up = GRID_LEVEL_STEP; up <= level; up += GRID_LEVEL_STEP) {
      const at = level - up
      const grid = watch(at, x >> up, y >> up)
      ancestors.push([x >> up, y >> up, at])
      // that far, once one is there to read
      if (grid && TILE_HORIZON_MARGIN_TEXELS * metres(at) >= TILE_HORIZON_REACH_METRES) break
    }
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await untilAborted(
        Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, HORIZON_CONTEXT_WAIT_MS)))]),
        signal
      ).finally(() => clearTimeout(timer))
    }
    // copied in the frame's budget, after the grids waiting (a bake only sharpens a tile already drawn)
    return this.options.budget.run(
      () => {
        signal.throwIfAborted()
        const t0 = performance.now()
        const context: HorizonSource[] = []
        if (entry.first) context.push({ ...entry.first, data: entry.first.data.slice() })
        const without: string[] = []
        for (const [nx, ny] of neighbours) {
          const grid = this.readable(nx, ny, level)
          if (!grid) {
            without.push(key(nx, ny, level))
            continue
          }
          const sub = this.subview(x, y, level, { x: nx, y: ny, level })
          context.push(horizonWindow(grid.image as unknown as PaddedGrid, sub, HORIZON_NEIGHBOUR_MARGIN_TEXELS))
        }
        for (const [ax, ay, at] of ancestors) {
          const grid = this.readable(ax, ay, at)
          if (grid) context.push(horizonWindow(grid.image as unknown as PaddedGrid, this.subview(x, y, level, { x: ax, y: ay, level: at })))
        }
        this.setWithout(k, entry, without)
        const image = entry.grid.image as unknown as PaddedGrid
        const grid = { data: image.data.slice(), width: image.width, height: image.height }
        const ms = performance.now() - t0
        if (ms > this.horizonStats.contextMaxMs) this.horizonStats.contextMaxMs = ms
        return { horizon: { tileSize, south, north, context }, grid }
      },
      signal,
      'bake'
    )
  }

  /** Records a bake's cost and makes its texture for `grid` (null: none). */
  private attachHorizon(grid: DataTexture, baked: BakedHorizon | null | undefined, tileSize: number): void {
    const stats = this.horizonStats
    if (!baked) return
    stats.bakeMs += baked.ms
    if (baked.ms > stats.bakeMaxMs) stats.bakeMaxMs = baked.ms
    if (!baked.horizon) {
      stats.empty++
      return
    }
    stats.baked++
    const texture = horizonTexture(baked.horizon, tileSize)
    texture.userData.maxCode = baked.max ?? 255
    setGridHorizon(grid, texture)
    const t0 = performance.now()
    this.options.upload?.(texture)
    const ms = performance.now() - t0
    if (ms > stats.uploadMaxMs) stats.uploadMaxMs = ms
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

  /** The tile's rectangle in another grid's (an ancestor's, or a neighbour's), normalized (the plugin's _getSubview). */
  private subview(x: number, y: number, level: number, above: { x: number; y: number; level: number }): number[] {
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
    const { budget } = this.options
    const { signal, release } = eitherSignal(itemSignal, this.lifetime.signal)
    let above: LockedGrid | null = null
    try {
      const source = await this.fetchGrid(x, y, level, signal)
      if ('from' in source) above = await this.dataAbove(x, y, level, source.from, source.fresh, signal)
      const locked = above
      // made in the frame's budget, ahead of the bakes; makeGrid releases the grid above once it runs
      return await budget.run(() => {
        signal.throwIfAborted()
        above = null
        return this.makeGrid(x, y, level, source, locked, itemSignal)
      }, signal)
    } catch (error) {
      if (above) this.release(above.x, above.y, above.level)
      throw error
    } finally {
      release()
    }
  }

  /**
   * The library's stitch (pinned by terrain-internals.test.ts against it),
   * with `edges`: each loaded neighbour's border is noted as the rect it
   * wrote, for edges.flush() to send alone, rather than marking the whole
   * neighbour for upload. The new grid is marked already (made just now).
   */
  override stitchNeighbors(grid: DataTexture, x: number, y: number, level: number): void {
    const { edges } = this.options
    if (!edges) return super.stitchNeighbors(grid, x, y, level)
    const { tiling } = (this.plugin as TerrainPluginInternals)._source!
    const { tileCountX } = tiling.getLevel(level)
    // grid rows run south to north, so the tile y step is flipped when the tiling's is
    const yDir = tiling.flipY ? -1 : 1
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        // the neighbour x wraps, so seams close across the antimeridian
        const neighbour = this.get((x + dx + tileCountX) % tileCountX, y + dy * yDir, level)
        if (!neighbour || neighbour instanceof Promise) continue
        fillBorder(grid, neighbour, dx, dy)
        edges.mark(neighbour, fillBorder(neighbour, grid, -dx, -dy))
      }
    }
  }

  /** fetchItem's main-thread end: the grid from what the source had, stitched, uploaded, its horizon begun. */
  private makeGrid(x: number, y: number, level: number, source: SourceGrid, above: LockedGrid | null, itemSignal: AbortSignal): DataTexture {
    const { filter, upload, edges } = this.options
    const tileDimension = (this.plugin as TerrainPluginInternals).tileDimension
    // A grid between the plugin's levels is only ever asked for by
    // dataAbove: never drawn, so never stitched or uploaded.
    const between = level % GRID_LEVEL_STEP !== 0
    let padded = 'padded' in source ? source.padded : null
    // what leads its horizon's context (a capped grid's data grid), and whether it gets one
    let first: HorizonSource | undefined
    let land = true
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
          // The data grid it was resampled from leads its horizon's
          // context, copied while it is locked: at an odd level (a coverage
          // end between the plugin's levels) the chain of even levels never
          // reaches it, and its relief would shade from coarser ground.
          if (padded && this.bakes()) first = horizonWindow(image, sub)
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
        land = false
      }
    }
    const grid = new DataTexture(padded.data, padded.width, padded.height, RedFormat, FloatType)
    grid.minFilter = grid.magFilter = filter === 'linear' ? LinearFilter : NearestFilter
    grid.needsUpdate = true
    if (!between) {
      if (edges) keepSourceOnClone(grid)
      this.stitchNeighbors(grid, x, y, level)
      upload?.(grid)
      // the neighbours' new borders, after the grid itself: one GPU write each
      edges?.flush()
      if (land) this.startHorizon(grid, x, y, level, first)
      this.neighbourMade(x, y, level)
    }
    // If the cache drops the item before taking this result, it never
    // disposes it; the abort is the only word of that. (A normal release
    // aborts too, then disposes: a second dispose is a no-op.)
    itemSignal.addEventListener('abort', () => grid.dispose(), { once: true })
    return grid
  }
}

/**
 * The library's fillBorder (GridCache.js, 0.5.3): copies the edge texels of
 * `src` into the border texels of `dst` facing the neighbour at tile offset
 * (dx, dy) (y north, as the rows): a column or row along the shared edge's
 * interior span, or a corner texel. Unlike the library's, leaves `dst`
 * unmarked, and returns the rect it wrote.
 */
export function fillBorder(dst: DataTexture, src: DataTexture, dx: number, dy: number): TexelRect {
  const { data, width, height } = dst.image as unknown as { data: Float32Array; width: number; height: number }
  const from = (src.image as unknown as { data: Float32Array }).data
  const w = width - 2
  const h = height - 2
  const minX = dx === -1 ? 0 : dx === 1 ? width - 1 : 1
  const maxX = dx === 0 ? width - 2 : minX
  const minY = dy === -1 ? 0 : dy === 1 ? height - 1 : 1
  const maxY = dy === 0 ? height - 2 : minY
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      data[y * width + x] = from[(y - dy * h) * width + (x - dx * w)]
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
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
        // The grid's horizon map (tides-zmw.9.15), which three's estimate
        // doesn't see (the tiles read it through a uniform), shared alike.
        bytes += gridHorizonBytes(map) / GRID_READERS
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

/**
 * Marks for upload every cached tile's map drawn from one of `sources`. The
 * terrain plugin drapes a clone of the overlay's texture, and a clone keeps
 * its own version: raising the overlay texture's leaves the clone's GPU copy
 * as it was (SurfaceImageryOverlay's late match, tides-zmw.9.26).
 */
export function refreshOverlayMaps(tiles: TilesRenderer, sources: ReadonlySet<Source>): void {
  forEachCachedModel(tiles, (scene) =>
    scene.traverse((object) => {
      const material = (object as Mesh).material
      if (!material || Array.isArray(material)) return
      const map = (material as MeshStandardMaterial).map
      if (map && sources.has(map.source)) map.needsUpdate = true
    })
  )
}
