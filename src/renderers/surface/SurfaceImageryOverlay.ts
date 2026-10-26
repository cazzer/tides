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
// still ends the chain.
import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { fetchWithRetry, RETRY_DELAYS_MS } from './fetch-retry'
import {
  cancelBody,
  EOX_URL,
  fallbackImageryResponse,
  fetchFirstOk,
  IMAGERY_LEVELS,
  IMAGERY_TILE_SIZE,
  imageryUrlsFor,
  parseImageryUrl,
} from './imagery'

export class SurfaceImageryOverlay extends XYZTilesOverlay {
  /** Tiles drawn in the fallback colour because no source answered. */
  fallbacks = 0
  /** Waits before each retry of a transient failure (tests shorten them). */
  retryDelays: readonly number[] = RETRY_DELAYS_MS

  constructor() {
    super({ url: EOX_URL, levels: IMAGERY_LEVELS, tileDimension: IMAGERY_TILE_SIZE })
  }

  override async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const tile = parseImageryUrl(url)
    const urls = tile ? imageryUrlsFor(tile) : [url]
    try {
      const res = await fetchWithRetry(
        () => fetchFirstOk(urls, (u) => super.fetch(u, options)),
        options.signal,
        this.retryDelays
      )
      if (res.ok) return res
      cancelBody(res)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
    }
    this.fallbacks++
    return fallbackImageryResponse()
  }
}
