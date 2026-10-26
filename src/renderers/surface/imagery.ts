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
// Inside a box, USGS 404s over open water or answers a blank tile; both fall
// back to EOX (by status, and by size: fetchFirstOk).
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

/** Whether a footprint in degrees overlaps any of the US boxes. */
export function boundsTouchUsgs(b: Omit<Box, 'name'>): boolean {
  return USGS_BOXES.some(
    (box) => b.south < box.north && b.north > box.south && b.west < box.east && b.east > box.west
  )
}

/** The URLs to try for a tile, best first: USGS then EOX in the US, else EOX. */
export function imageryUrlsFor(tile: ImageryTile): string[] {
  const eox = imageryUrl(EOX_URL, tile)
  return insideUsgsCoverage(tile) ? [imageryUrl(USGS_URL, tile), eox] : [eox]
}

/**
 * Below this many bytes, an ok answer from a source with another behind it
 * is a blank tile: USGS answers 200 with an all-black 872-byte JPEG over
 * much of the sea it has no imagery for (and 404 elsewhere), which drew
 * black squares off every US coast. Real 256 px tiles, sea included, run
 * from ~5.7 kB up (sampled 2026-10-25 off Big Sur, Puget Sound and Miami).
 */
export const BLANK_TILE_BYTES = 2048
/**
 * Above this fraction of pure-black pixels reaching the edge, a tile is
 * blank too: along the coasts USGS's tiles are part imagery, part nodata
 * black (9/200/82 off Big Sur is 64% black, 11/801/330 25%). Real imagery
 * has next to no pure black (0.02% in a shadowed 8/100/40).
 */
export const BLANK_BLACK_FRACTION = 0.02
/** The probe a tile is decoded to for the black count: every 8th pixel. */
const PROBE_SIZE = 32

const isBlack = (rgba: ArrayLike<number>, i: number) => rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2] <= 3

/**
 * The fraction of a width x height RGBA image that is pure black (nodata)
 * and connected to the image's edge. USGS's nodata comes in from the edge
 * (the sea beyond its coverage), while the pure black of a deep shadow
 * inside a canyon doesn't reach it and isn't counted.
 */
export function edgeBlackFraction(rgba: ArrayLike<number>, width: number, height: number): number {
  const n = width * height
  if (!n) return 0
  const seen = new Uint8Array(n)
  const stack: number[] = []
  const push = (i: number) => {
    if (!seen[i] && isBlack(rgba, i)) {
      seen[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  let count = 0
  while (stack.length) {
    const i = stack.pop()!
    count++
    const x = i % width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (i >= width) push(i - width)
    if (i < n - width) push(i + width)
  }
  return count / n
}

let probeContext: OffscreenCanvasRenderingContext2D | null | undefined

/**
 * Whether an image tile is blank: tiny (a uniform tile), undecodable, or
 * more than BLANK_BLACK_FRACTION nodata black reaching its edge, by a 32 px
 * probe through the browser's decoder. By size alone where there's no
 * decoder to probe with. A blank tile falls through to the next source.
 */
export async function isBlankTile(body: ArrayBuffer): Promise<boolean> {
  if (body.byteLength < BLANK_TILE_BYTES) return true
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return false
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([body]), {
      resizeWidth: PROBE_SIZE,
      resizeHeight: PROBE_SIZE,
      resizeQuality: 'pixelated',
    })
  } catch {
    return true
  }
  try {
    if (probeContext === undefined) {
      probeContext = new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE).getContext('2d', { willReadFrequently: true })
    }
    if (!probeContext) return false
    probeContext.clearRect(0, 0, PROBE_SIZE, PROBE_SIZE)
    probeContext.drawImage(bitmap, 0, 0, PROBE_SIZE, PROBE_SIZE)
    const { data } = probeContext.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE)
    return edgeBlackFraction(data, PROBE_SIZE, PROBE_SIZE) > BLANK_BLACK_FRACTION
  } catch {
    return false
  } finally {
    bitmap.close()
  }
}

/**
 * Fetches the first of `urls` that answers ok with a tile that isn't blank
 * (isBlankTile); the last answer (or error) stands if none does. A network
 * error falls through like a bad status, but an abort (the tile went out of
 * view) ends the chain. A skipped answer's body is cancelled, so its
 * connection isn't held open unread.
 */
export async function fetchFirstOk(
  urls: readonly string[],
  fetcher: (url: string) => Promise<Response>,
  isBlank: (body: ArrayBuffer) => Promise<boolean> = isBlankTile
): Promise<Response> {
  for (let i = 0; i < urls.length; i++) {
    const last = i === urls.length - 1
    try {
      const res = await fetcher(urls[i])
      if (last) return res
      if (!res.ok) {
        cancelBody(res)
        continue
      }
      const body = await res.arrayBuffer()
      if (!(await isBlank(body))) {
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
      }
    } catch (error) {
      if (last || (error as Error)?.name === 'AbortError') throw error
    }
  }
  throw new Error('fetchFirstOk: no URLs')
}

/** Drops a response's unread body; never throws. */
export function cancelBody(res: Response): void {
  res.body?.cancel().catch(() => {})
}

/**
 * What a tile shows when no source has imagery for it (both fail, or the
 * network does; tides-zmw.9.2): the day map's open-ocean colour, sRGB
 * (earth-day.jpg's grading, measured for scripts/fit-gibs-colour.mjs).
 * Without it a failed overlay fails its terrain tile too: a hole.
 */
export const FALLBACK_IMAGERY_RGB = [25, 75, 101] as const

/** FALLBACK_IMAGERY_RGB as a 1x1 RGB PNG (69 bytes; the overlay stretches it over the tile). */
const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOQ9E4FAAFKAMr0l52NAAAAAElFTkSuQmCC'

export function fallbackImageryPng(): Uint8Array<ArrayBuffer> {
  const bin = atob(FALLBACK_PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** A fresh 200 response carrying the fallback PNG. */
export function fallbackImageryResponse(): Response {
  return new Response(fallbackImageryPng(), { status: 200, headers: { 'Content-Type': 'image/png' } })
}
