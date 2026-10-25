// The streamed surface's imagery (tides-zmw.9.1): one XYZ overlay over the
// EOX template whose fetch picks the source per tile (imagery.ts), so the
// terrain plugin, which takes a single overlay, drapes USGS in the US and
// EOX elsewhere. The swap is in fetch rather than in the URL template because
// the library's tile fetch (TiledImageSource.fetchItem) never checks the
// status: a USGS 404 over water would decode as a broken image instead of
// falling back. Everything still goes through super.fetch, so the library's
// per-host download queue and abort signals stay in charge.
import { XYZTilesOverlay } from '3d-tiles-renderer/three/plugins'
import { EOX_URL, fetchFirstOk, IMAGERY_LEVELS, IMAGERY_TILE_SIZE, imageryUrlsFor, parseImageryUrl } from './imagery'

export class SurfaceImageryOverlay extends XYZTilesOverlay {
  constructor() {
    super({ url: EOX_URL, levels: IMAGERY_LEVELS, tileDimension: IMAGERY_TILE_SIZE })
  }

  override fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const tile = parseImageryUrl(url)
    const urls = tile ? imageryUrlsFor(tile) : [url]
    return fetchFirstOk(urls, (u) => super.fetch(u, options))
  }
}
