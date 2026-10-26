// The streamed surface's imagery (tides-zmw.9.1): one XYZ overlay over the
// EOX template whose fetch picks the source per tile (imagery.ts), so the
// terrain plugin, which takes a single overlay, drapes USGS in the US and
// EOX elsewhere. The swap is in fetch rather than in the URL template because
// the library's tile fetch (TiledImageSource.fetchItem) never checks the
// status: a USGS 404 over water would decode as a broken image instead of
// falling back. Everything still goes through super.fetch, so the library's
// per-host download queue and abort signals stay in charge.
//
// When every source fails (tides-zmw.9.2), the tile gets a plain patch of
// the day map's ocean colour instead (imagery.ts), counted in `fallbacks`:
// the library fails a terrain tile whose overlay fails, so a missing image
// would otherwise leave a hole in the ground. A transient failure (network,
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
// (anything but an abort) or its field takes over MATCH_DEADLINE_MS.
import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
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

export class SurfaceImageryOverlay extends XYZTilesOverlay {
  /** Tiles drawn in the fallback colour because no source answered. */
  fallbacks = 0
  /** Waits before each retry of a transient failure (tests shorten them). */
  retryDelays: readonly number[] = RETRY_DELAYS_MS
  /** USGS-first tiles whose last answer came from EOX, as z/x/y. */
  private readonly eoxServed = new Set<string>()
  /** Matches a USGS tile's body to EOX's colour, returning an image file,
   * or null to draw it as it came (the field too slow); a null regrade
   * (nothing can decode a tile: no OffscreenCanvas) draws USGS as it comes.
   * Tests swap it. */
  regrade:
    | ((body: ArrayBuffer, tile: ImageryTile, signal?: AbortSignal | null) => Promise<ArrayBuffer | null>)
    | null = canGradeImagery() ? regradeUsgs : null

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
    return fallbackImageryResponse()
  }

  /** A USGS answer matched (regrade), or as it came if matching fails. */
  private async regraded(res: Response, tile: ImageryTile, signal?: AbortSignal | null): Promise<Response> {
    const body = await res.arrayBuffer()
    try {
      const image = await this.regrade!(body, tile, signal)
      if (image) return new Response(image, { status: 200, headers: { 'Content-Type': 'image/bmp' } })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  /** Whether EOX drew this imagery tile though it lies in a US box (always
   * at levels coarser than USGS_MIN_ZOOM). */
  servedByEox(tile: ImageryTile): boolean {
    return tile.z < USGS_MIN_ZOOM || this.eoxServed.has(tileKey(tile))
  }
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

/** The overlay's regrade: the field's match for the tile, in the worker
 * (null, drawn as it came, past MATCH_DEADLINE_MS). */
async function regradeUsgs(body: ArrayBuffer, tile: ImageryTile, signal?: AbortSignal | null): Promise<ArrayBuffer | null> {
  const match: MatchParams | undefined = await unlessAborted(withDeadline(matchField().params(tile), MATCH_DEADLINE_MS), signal)
  if (!match) return null
  const image = await imageryGrader().grade(body, 'match', 'bmp', signal, match)
  return image.buffer
}
