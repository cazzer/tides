// The streamed surface's imagery (tides-zmw.9.1): one XYZ overlay over the
// EOX template whose fetch picks the source per tile (imagery.ts), so the
// terrain plugin, which takes a single overlay, drapes USGS in the US and
// EOX elsewhere. The swap is in fetch rather than in the URL template because
// the library's tile fetch (TiledImageSource.fetchItem) never checks the
// status: a USGS 404 over water would decode as a broken image instead of
// falling back. Everything still goes through super.fetch, so the library's
// per-host download queue and abort signals stay in charge.
//
// When every source fails (tides-zmw.9.2), the tile gets stand-in imagery,
// counted in `fallbacks`: the library fails a terrain tile whose overlay
// fails, so a missing image would otherwise leave a hole in the ground. The
// stand-in is the tile's patch of its nearest cached ancestor's image, scaled
// up (tides-zmw.9.31; the coarser tiles load first, so one is nearly always
// there), and only failing that a plain patch of the day map's ocean colour
// (imagery.ts), which over land drew hard-edged blue rectangles for as long
// as the tile stayed cached. A transient failure (network,
// 429, 5xx) is retried first (fetch-retry.ts), so one blip doesn't paint a
// land tile in the ocean colour for as long as it stays cached. An abort
// still ends the chain. Tiles in the US boxes that EOX answered for (USGS
// had nothing, or a blank) are remembered, so the credits line names EOX
// for them (servedByEox, credit-sources.ts).
//
// Every USGS tile is matched to EOX's colour as it arrives (tides-zmw.9.11;
// imagery-match.ts: a field of per-channel gains fitted at runtime on both
// sources' tiles, applied in a worker), so the two sources meet without a
// colour step: the library gets a BMP of the matched pixels in place of the
// JPEG. EOX's tiles pass as they come, as does USGS where matching fails
// (anything but an abort) or its field takes over MATCH_DEADLINE_MS. A tile
// whose field comes after the deadline (tides-zmw.9.26: 22 of 52 USGS tiles
// on a cold start at the canyon) is drawn as it came, then regraded in place
// when its match lands: the cached texture takes the matched image, the
// composed regions drawn from it are redrawn, and onLateMatch names the
// textures' sources so the tiles' maps of them upload again. Without that it
// stayed unmatched (blue and pale beside EOX) for as long as it stayed cached.
import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { CanvasTexture, Texture, type Source } from 'three'
import { fetchWithRetry, RETRY_DELAYS_MS } from './fetch-retry'
import { canGradeImagery, imageryGrader, type MatchParams } from './imagery-grade'
import { matchField } from './imagery-match'
import { withDeadline } from './side-fetch'
import {
  cancelBody,
  EOX_URL,
  fallbackImageryResponse,
  fetchFirstOk,
  IMAGERY_LEVELS,
  IMAGERY_TILE_SIZE,
  imageryUrlsFor,
  parseImageryUrl,
  USGS_MIN_ZOOM,
  type ImageryTile,
} from './imagery'

const tileKey = ({ z, x, y }: ImageryTile) => `${z}/${x}/${y}`

/** The library's tiling scheme, as far as the late match reads it. */
interface Tiling {
  readonly minLevel: number
  readonly maxLevel: number
  getTilesInRange(minX: number, minY: number, maxX: number, maxY: number, level: number, normalized: boolean): number[]
  getTileBounds(x: number, y: number, level: number, normalized: boolean, clamp: boolean): number[]
}

/** overlay.imageSource (the library's XYZImageSource, a DataCache keyed by
 * the URL's x, y, z; processBufferToTexture as protectOverlayBitmaps
 * patches it). */
interface ImageSourceInternals {
  readonly tiling: Tiling
  get(x: number, y: number, z: number): Texture | Promise<Texture> | null
  processBufferToTexture(buffer: ArrayBuffer): Promise<Texture>
}

/** overlay.regionImageSource (TiledRegionImageSource): the textures the
 * terrain tiles drape, keyed by range and level. An entry made by lock keeps
 * its args; its result is a Promise until fetchItem settles. */
interface RegionImageSourceInternals {
  readonly cache: Record<string, { args?: readonly number[]; result: unknown }>
  readonly tileComposer: {
    setTarget(target: CanvasTexture, range: readonly number[]): void
    draw(texture: Texture, span: readonly number[]): void
  }
}

/** An ancestor's image as the cache holds it: a decoded bitmap, or the
 * fallback's 1x1 ocean patch. */
type CachedImage = CanvasImageSource & { readonly width: number; readonly height: number }

/** Closes a bitmap for real (protectOverlayBitmaps makes its own close a no-op). */
function closeBitmap(image: unknown): void {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) ImageBitmap.prototype.close.call(image)
}

export class SurfaceImageryOverlay extends XYZTilesOverlay {
  /** Tiles drawn from stand-in imagery (an ancestor's, or the fallback
   * colour) because no source answered. */
  fallbacks = 0
  /** Of those, the tiles cut from an ancestor's image. */
  ancestorFallbacks = 0
  /** Waits before each retry of a transient failure (tests shorten them). */
  retryDelays: readonly number[] = RETRY_DELAYS_MS
  /** USGS-first tiles whose last answer came from EOX, as z/x/y. */
  private readonly eoxServed = new Set<string>()
  /** Matches a USGS tile's body to EOX's colour, returning an image file,
   * or null to draw it as it came (the field too slow); a null regrade
   * (nothing can decode a tile: no OffscreenCanvas) draws USGS as it comes.
   * Tests swap it. A null answer may still hand `late` the matched image
   * once the field comes. */
  regrade:
    | ((
        body: ArrayBuffer,
        tile: ImageryTile,
        signal?: AbortSignal | null,
        late?: (image: ArrayBuffer) => void
      ) => Promise<ArrayBuffer | null>)
    | null = canGradeImagery() ? regradeUsgs : null
  /** Cuts `cut` out of an ancestor's cached image into an image file, or
   * null where nothing can draw one (no OffscreenCanvas: the fallback colour
   * stands). Tests swap it. */
  cutAncestor: ((image: CachedImage, cut: AncestorCut) => Promise<ArrayBuffer>) | null = canGradeImagery()
    ? cutCachedImage
    : null
  /** Told the texture sources a late match redrew, so the tiles' maps that
   * share them (clones, which keep their own version) upload again. */
  onLateMatch: ((sources: ReadonlySet<Source>) => void) | null = null
  /** Cached tiles regraded in place by a match that missed the deadline. */
  lateMatches = 0

  constructor() {
    super({ url: EOX_URL, levels: IMAGERY_LEVELS, tileDimension: IMAGERY_TILE_SIZE })
  }

  override async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const tile = parseImageryUrl(url)
    const urls = tile ? imageryUrlsFor(tile) : [url]
    let asked = ''
    try {
      const res = await fetchWithRetry(
        () =>
          fetchFirstOk(urls, (u) => {
            asked = u
            return super.fetch(u, options)
          }),
        options.signal,
        this.retryDelays
      )
      if (res.ok) {
        const usgs = !!tile && urls.length > 1 && asked !== urls[urls.length - 1]
        if (tile && urls.length > 1) {
          if (usgs) this.eoxServed.delete(tileKey(tile))
          else this.eoxServed.add(tileKey(tile))
        }
        if (!usgs || !this.regrade) return res
        return await this.regraded(res, tile!, options.signal)
      }
      cancelBody(res)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }
    this.fallbacks++
    const cut = tile && this.cutAncestor ? await this.ancestorImagery(tile, options.signal) : null
    if (cut) this.ancestorFallbacks++
    return cut ?? fallbackImageryResponse()
  }

  /** The tile's patch of its nearest cached ancestor's image, or null when
   * none is cached or none can be cut. An ancestor drawn in the fallback
   * colour is passed over for the next, as is one still loading: this fetch
   * holds a slot of the library's download queue that the ancestor's may be
   * waiting for (waiting stalled the whole tree at its coarse levels). */
  private async ancestorImagery(tile: ImageryTile, signal?: AbortSignal | null): Promise<Response | null> {
    const source = (this as unknown as { imageSource: ImageSourceInternals }).imageSource
    for (let up = 1; up <= tile.z; up++) {
      const texture = source.get(tile.x >> up, tile.y >> up, tile.z - up)
      const image = texture instanceof Texture ? (texture.image as CachedImage | null) : null
      if (!image || image.width <= 1) continue
      try {
        const file = await this.cutAncestor!(image, ancestorCut(tile, up, image.width, image.height))
        signal?.throwIfAborted()
        return new Response(file, { status: 200, headers: { 'Content-Type': 'image/png' } })
      } catch (error) {
        // A closed bitmap (the ancestor dropped meanwhile) can't be drawn: try the next.
        if ((error as Error)?.name === 'AbortError') throw error
      }
    }
    return null
  }

  /** A USGS answer matched (regrade), or as it came if matching fails. */
  private async regraded(res: Response, tile: ImageryTile, signal?: AbortSignal | null): Promise<Response> {
    const body = await res.arrayBuffer()
    try {
      const image = await this.regrade!(body, tile, signal, (late) => void this.lateMatched(tile, late, signal))
      if (image) return new Response(image, { status: 200, headers: { 'Content-Type': 'image/bmp' } })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  /** Swaps a late match's image into the tile's cached texture, unless the
   * tile was dropped (its fetch's signal aborts on release) or replaced. The
   * texture's clones (the single-tile regions, the tiles' maps) share its
   * source, so they see the new image; composed regions are redrawn. */
  private async lateMatched(tile: ImageryTile, image: ArrayBuffer, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return
    const source = (this as unknown as { imageSource: ImageSourceInternals }).imageSource
    let texture = source.get(tile.x, tile.y, tile.z)
    if (texture instanceof Promise) {
      try {
        await texture
      } catch {
        return
      }
      texture = source.get(tile.x, tile.y, tile.z)
    }
    if (!(texture instanceof Texture)) return
    let decoded: Texture
    try {
      decoded = await source.processBufferToTexture(image)
    } catch {
      return
    }
    const old = texture.image as { width?: number; height?: number } | null
    const fresh = decoded.image as { width?: number; height?: number } | null
    if (
      signal?.aborted ||
      source.get(tile.x, tile.y, tile.z) !== texture ||
      fresh?.width !== old?.width ||
      fresh?.height !== old?.height
    ) {
      closeBitmap(decoded.image)
      return
    }
    texture.image = decoded.image
    texture.needsUpdate = true
    const sources = new Set<Source>([texture.source])
    this.recomposeRegions(tile, texture, sources)
    closeBitmap(old)
    this.lateMatches++
    this.onLateMatch?.(sources)
  }

  /** Redraws the tile into every composed region drawn from it (a region
   * still composing is redrawn when it's done, and reported then). */
  private recomposeRegions(tile: ImageryTile, texture: Texture, sources: Set<Source>): void {
    const regions = (this as unknown as { regionImageSource: RegionImageSourceInternals | null }).regionImageSource
    if (!regions) return
    const source = (this as unknown as { imageSource: ImageSourceInternals }).imageSource
    const { tiling } = source
    const span = tiling.getTileBounds(tile.x, tile.y, tile.z, true, false)
    const redraw = (target: CanvasTexture, range: readonly number[], into: Set<Source>) => {
      regions.tileComposer.setTarget(target, range)
      regions.tileComposer.draw(texture, span)
      target.needsUpdate = true
      into.add(target.source)
    }
    // The cache's own map: forEachItem would skip the entries still composing.
    for (const info of Object.values(regions.cache)) {
      const args = info.args
      if (!args || !composedFrom(tiling, args, tile)) continue
      const range = args.slice(0, 4)
      const result = info.result
      if (result instanceof CanvasTexture) redraw(result, range, sources)
      else if (result instanceof Promise) {
        result.then(
          (target: unknown) => {
            // The tile may have been dropped meanwhile (its image closed).
            if (!(target instanceof CanvasTexture) || source.get(tile.x, tile.y, tile.z) !== texture) return
            const late = new Set<Source>()
            redraw(target, range, late)
            this.onLateMatch?.(late)
          },
          () => {}
        )
      }
    }
  }

  /** Whether EOX drew this imagery tile though it lies in a US box (always
   * at levels coarser than USGS_MIN_ZOOM). */
  servedByEox(tile: ImageryTile): boolean {
    return tile.z < USGS_MIN_ZOOM || this.eoxServed.has(tileKey(tile))
  }
}

/**
 * Whether the region the library composes for `args` (a range in normalized
 * tiling coordinates, then a level) draws `tile`. A copy of the tiles
 * forEachTileInBounds visits (3d-tiles-renderer's
 * src/three/plugins/images/overlays/utils.js, not exported from the
 * package): the range pulled in by 1e-4 of its span, the level clamped to the
 * tiling's. Exported for the test that holds it to the library's.
 */
export function composedFrom(tiling: Tiling, args: readonly number[], tile: ImageryTile): boolean {
  let [minX, minY, maxX, maxY] = args
  const level = args[4]
  const epsX = (maxX - minX) * 1e-4
  const epsY = (maxY - minY) * 1e-4
  minX += epsX
  minY += epsY
  maxX -= epsX
  maxY -= epsY
  const clamped = Math.max(Math.min(level, tiling.maxLevel), tiling.minLevel)
  if (clamped !== tile.z) return false
  const [x0, y0, x1, y1] = tiling.getTilesInRange(minX, minY, maxX, maxY, clamped, true)
  return tile.x >= x0 && tile.x <= x1 && tile.y >= y0 && tile.y <= y1
}

/** Where a tile lies in an ancestor's cached image `up` levels above it:
 * the source rectangle in the cached bitmap's pixels, and the cut's size. */
export interface AncestorCut {
  readonly sx: number
  readonly sy: number
  readonly sw: number
  readonly sh: number
  readonly size: number
}

/** The ancestor's image is cached flipped (the library decodes with flipY),
 * so the tile's rows count up from the bitmap's bottom. The cut keeps the
 * ancestor's own pixels (a z16 tile's z15 parent gives 128 of them a side),
 * at least 2 a side so it's never taken for the 1x1 fallback patch. */
export function ancestorCut(tile: ImageryTile, up: number, width: number, height: number): AncestorCut {
  const n = 2 ** up
  const sw = width / n
  const sh = height / n
  const col = tile.x - ((tile.x >> up) << up)
  const row = tile.y - ((tile.y >> up) << up)
  return { sx: col * sw, sy: height - (row + 1) * sh, sw, sh, size: Math.max(2, Math.round(sw)) }
}

/** The overlay's cutAncestor: the cut drawn upright (the library flips what
 * it's given as it decodes) and smoothed, as a PNG. */
export async function cutCachedImage(image: CachedImage, { sx, sy, sw, sh, size }: AncestorCut): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(size, size)
  const ctx = canvas.getContext('2d')!
  ctx.translate(0, size)
  ctx.scale(1, -1)
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, size, size)
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

/** Resolves `promise`, or rejects with the signal's reason when it aborts
 * first (the field's cells are shared, so one tile's abort leaves them be). */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e))
    )
  })
}

/** How long a USGS tile waits on the match's field before it draws as it came
 * (its cells keep loading, for the tiles after it). */
export const MATCH_DEADLINE_MS = 2000

/** The overlay's regrade (exported for its tests): the field's match for
 * the tile, in the worker. Past MATCH_DEADLINE_MS it's null (drawn as it
 * came), and the matched image goes to `late` when the field comes, unless
 * the tile's fetch aborts first; the grader copies the body, so the library
 * still gets it intact. */
export async function regradeUsgs(
  body: ArrayBuffer,
  tile: ImageryTile,
  signal?: AbortSignal | null,
  late?: (image: ArrayBuffer) => void
): Promise<ArrayBuffer | null> {
  const pending = matchField().params(tile)
  const match: MatchParams | undefined = await unlessAborted(withDeadline(pending, MATCH_DEADLINE_MS), signal)
  if (!match) {
    if (late) {
      void unlessAborted(pending, signal)
        .then((m) => imageryGrader().grade(body, 'match', 'bmp', signal, m))
        .then(
          (image) => late(image.buffer),
          () => {}
        )
    }
    return null
  }
  const image = await imageryGrader().grade(body, 'match', 'bmp', signal, match)
  return image.buffer
}
