// Which imagery the streamed surface (tides-zmw.9.1) drapes over a terrain
// tile: USGS's National Map orthoimagery (sub-metre, public domain) where a
// tile lies wholly inside the US, EOX's Sentinel-2 cloudless mosaic (10 m,
// worldwide) everywhere else and wherever USGS has nothing. Both serve Web
// Mercator XYZ tiles at z/y/x, so one overlay asks for the EOX URL and its
// fetch swaps the source per tile (SurfaceImageryOverlay.ts).
//
// The US boxes are conservative on purpose: USGS answers 200 with a blank
// tile over parts of Canada and Mexico, which a status check can't catch, so
// a tile has to sit wholly inside one box (a straddling tile takes EOX).
// Inside a box, USGS 404s over open water; those fall back to EOX by status.
// No zoom threshold: the first tiles to fit a box are at z5 (interior Alaska
// and the Southeast), where USGS's low levels are a natural-colour mosaic with the sea filled in.

/** EOX Sentinel-2 cloudless 2020 (CC BY-NC-SA 4.0; credited by tides-zmw.9.9). */
export const EOX_URL =
  'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'
/** USGS National Map imagery (public domain). */
export const USGS_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
/**
 * The overlay's zoom levels (0-16). EOX stores z0-14 and serves z15-16
 * upsampled from them, so the deepest levels sharpen only under USGS; the
 * terrain tree reaches the overlay's deepest level so its texels show.
 */
export const IMAGERY_LEVELS = 17
export const IMAGERY_TILE_SIZE = 256

export interface ImageryTile {
  z: number
  x: number
  y: number
}

interface Box {
  name: string
  south: number
  north: number
  west: number
  east: number
}

/** Degrees. Each keeps clear of Canada, Mexico, Cuba and the Bahamas. */
export const USGS_BOXES: readonly Box[] = [
  // North of Tijuana (32.5N) and the Mexicali border (32.7N), south of
  // Victoria (48.4N) and the 49th parallel.
  { name: 'CONUS west', south: 32.8, north: 48.2, west: -124.2, east: -95.3 },
  // North of the Gulf coast's Mexican shore, south of Lake Erie's Canadian
  // islands (41.7N); Maine and the Great Lakes' north shores take EOX.
  { name: 'CONUS east', south: 29, north: 41.6, west: -95.3, east: -70 },
  { name: 'Florida', south: 24.5, north: 31, west: -87.6, east: -80 },
  { name: 'Hawaii', south: 18.9, north: 22.3, west: -160.3, east: -154.8 },
  // West of the Yukon border (141W) and east of the Diomedes.
  { name: 'Alaska', south: 54.5, north: 71.4, west: -168, east: -141 },
]

/** The z/y/x a z/y/x tile URL (either source's) asks for, or null. */
export function parseImageryUrl(url: string): ImageryTile | null {
  const match = /\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?(?:\?.*)?$/.exec(url)
  if (!match) return null
  return { z: Number(match[1]), y: Number(match[2]), x: Number(match[3]) }
}

export function imageryUrl(template: string, { z, x, y }: ImageryTile): string {
  return template.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x))
}

const RAD_TO_DEG = 180 / Math.PI

/** A Web Mercator tile's footprint in degrees (y counts down from the north). */
export function tileBounds({ z, x, y }: ImageryTile): Omit<Box, 'name'> {
  const n = 2 ** z
  const lat = (row: number) => RAD_TO_DEG * Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)))
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) }
}
export function insideUsgsCoverage(tile: ImageryTile): boolean {
  return boundsInsideUsgs(tileBounds(tile))
}

/** Whether a footprint in degrees lies wholly inside one of the US boxes. */
export function boundsInsideUsgs(b: Omit<Box, 'name'>): boolean {
  return USGS_BOXES.some(
    (box) => b.south >= box.south && b.north <= box.north && b.west >= box.west && b.east <= box.east
  )
}

/** The URLs to try for a tile, best first: USGS then EOX in the US, else EOX. */
export function imageryUrlsFor(tile: ImageryTile): string[] {
  const eox = imageryUrl(EOX_URL, tile)
  return insideUsgsCoverage(tile) ? [imageryUrl(USGS_URL, tile), eox] : [eox]
}

/**
 * Fetches the first of `urls` that answers ok; the last answer (or error)
 * stands if none does. A network error falls through like a bad status, but
 * an abort (the tile went out of view) ends the chain.
 */
export async function fetchFirstOk(
  urls: readonly string[],
  fetcher: (url: string) => Promise<Response>
): Promise<Response> {
  for (let i = 0; i < urls.length; i++) {
    const last = i === urls.length - 1
    try {
      const res = await fetcher(urls[i])
      if (res.ok || last) return res
    } catch (error) {
      if (last || (error as Error)?.name === 'AbortError') throw error
    }
  }
  throw new Error('fetchFirstOk: no URLs')
}
