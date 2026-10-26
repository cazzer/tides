// The coarse reference the tiles anchor to the day map with (tides-zmw.9.11,
// tile-colour.ts): EOX's imagery seen at about the day map's texel, fetched
// at runtime (nothing EOX-derived is shipped: CC BY-NC-SA), as it comes,
// as the tiles' own EOX imagery does. Bilinear on the global grid, as the
// globe's day map is filtered at its own texel.
//
// The tiles' own textures can't give it: they have no mips, and each is cut
// at its tile's edge, so a tile's own average would step at every edge. So
// each tile takes a small texture of EOX's level-COLOUR_REF_ZOOM pixels over
// its footprint and one pixel round it, laid on the global pixel grid
// (texel i is pixel x0 + i): sampled bilinearly at the same point, two
// neighbours read the same four pixels and agree to the bit at their shared
// edge. Level 5 is ~4.9 km a pixel times cos(lat) (the day map's texel is
// 3.7 km north-south, 3.7 cos(lat) east-west). A tile coarser than level 5
// (only ever seen far off, from high up) takes its own level's pixels, so the
// texture stays at most 258 px a side.
//
// The level-5 tiles are fetched once each (a few cover a flight's view; a
// 256 px JPEG, decoded to RGBA in the worker) and kept while any tile uses
// them, then COLOUR_REF_IDLE more, least recently used first.
import * as THREE from 'three'
import { fetchWithRetry } from './fetch-retry'
import { EOX_URL, imageryUrl } from './imagery'
import { imageryGrader, type GradedImage } from './imagery-grade'
import { KeyedBackoff, sideFetch } from './side-fetch'

/** The reference's imagery level. */
export const COLOUR_REF_ZOOM = 5
/** Unused level-5 tiles kept. */
export const COLOUR_REF_IDLE = 48
const TILE = 256

/** A tile's window of reference pixels: at `zoom`, columns x0 .. x0 + width
 * (wrapping round the globe), rows y0 .. y0 + height from the north (clamped
 * to the map's rows when read). */
export interface ColourRefWindow {
  zoom: number
  x0: number
  y0: number
  width: number
  height: number
}

/** Web Mercator x of a longitude, 0-1 from the antimeridian eastward. */
export const mercatorX = (lon: number) => lon / (2 * Math.PI) + 0.5
/** Web Mercator y of a latitude, 0-1 from the north (the GLSL's
 * colourMercatorY), clamped to the map's rows (85.05 degrees). */
export const mercatorY = (lat: number) =>
  Math.min(1, Math.max(0, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI)))

/**
 * The window for a tile whose footprint is `bounds` (radians) at terrain
 * `level`: its pixels at min(COLOUR_REF_ZOOM, level), and one more each side
 * (rows past the map's edge, toward the poles, read its edge row).
 */
export function colourRefWindow(
  bounds: { west: number; south: number; east: number; north: number },
  level: number
): ColourRefWindow {
  const zoom = Math.max(0, Math.min(COLOUR_REF_ZOOM, Math.floor(level)))
  const n = TILE * 2 ** zoom
  // A hair inside, so a footprint on the pixel grid takes no extra column.
  const eps = 1e-6
  const x0 = Math.floor(mercatorX(bounds.west) * n + eps) - 1
  const x1 = Math.min(x0 + n + 2, Math.ceil(mercatorX(bounds.east) * n - eps) + 1)
  const y0 = Math.floor(mercatorY(bounds.north) * n + eps) - 1
  const y1 = Math.ceil(mercatorY(bounds.south) * n - eps) + 1
  return { zoom, x0, y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) }
}

/** The shader's window uniform (tile-colour.ts): the window's corner and
 * its size's reciprocal, in Mercator 0-1. */
export function colourRefWindowUniform(window: ColourRefWindow, target = new THREE.Vector4()): THREE.Vector4 {
  const n = TILE * 2 ** window.zoom
  return target.set(window.x0 / n, window.y0 / n, n / window.width, n / window.height)
}

/** The tiles a window reads, as zoom/x/y keys. */
export function colourRefTiles(window: ColourRefWindow): { z: number; x: number; y: number }[] {
  const count = 2 ** window.zoom
  const n = TILE * count
  const cols = new Set<number>()
  const rows = new Set<number>()
  for (let px = window.x0; px < window.x0 + window.width; px++) cols.add(Math.floor((((px % n) + n) % n) / TILE))
  for (let py = window.y0; py < window.y0 + window.height; py++) rows.add(Math.floor(Math.min(n - 1, Math.max(0, py)) / TILE))
  const out: { z: number; x: number; y: number }[] = []
  for (const y of rows) for (const x of cols) out.push({ z: window.zoom, x, y })
  return out
}

/** The window's RGBA pixels from its tiles' (`pixels(z, x, y)`, 256x256 RGBA). */
export function assembleColourRef(window: ColourRefWindow, pixels: (z: number, x: number, y: number) => Uint8Array): Uint8Array<ArrayBuffer> {
  const n = TILE * 2 ** window.zoom
  const out = new Uint8Array(window.width * window.height * 4)
  for (let j = 0; j < window.height; j++) {
    const py = Math.min(n - 1, Math.max(0, window.y0 + j))
    const ty = Math.floor(py / TILE)
    const row = py % TILE
    // The source tile looked up once per run of its columns.
    let tile: Uint8Array | null = null
    let tileX = -1
    for (let i = 0; i < window.width; i++) {
      const px = (((window.x0 + i) % n) + n) % n
      const tx = Math.floor(px / TILE)
      if (tx !== tileX) {
        tile = pixels(window.zoom, tx, ty)
        tileX = tx
      }
      const from = (row * TILE + (px % TILE)) * 4
      const to = (j * window.width + i) * 4
      out[to] = tile![from]
      out[to + 1] = tile![from + 1]
      out[to + 2] = tile![from + 2]
      out[to + 3] = 255
    }
  }
  return out
}

/** A reference texture: sRGB bytes, read as linear light (the albedo's
 * space), bilinear, no mips. */
export function colourRefTexture(window: ColourRefWindow, rgba: Uint8Array<ArrayBuffer>): THREE.DataTexture {
  const texture = new THREE.DataTexture(rgba, window.width, window.height, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/** Fetches one reference tile: 256x256 RGBA bytes. */
export type ColourRefFetch = (z: number, x: number, y: number) => Promise<Uint8Array>

interface Entry {
  pixels: Uint8Array | null
  pending: Promise<Uint8Array> | null
  users: number
  used: number
}

export interface ColourRefStore {
  /**
   * The reference for `window`: `ready` gets its texture, at once if its
   * tiles are in hand, else once they arrive (a tile that fails is asked
   * for again once its backoff is over, and the request waits on). The
   * returned release drops the texture (disposed) and the tiles; after it,
   * ready is never called.
   */
  request(window: ColourRefWindow, ready: (texture: THREE.DataTexture) => void): () => void
  /** Tiles held (in use or idle). */
  readonly size: number
}

export function createColourRefStore(
  fetchTile: ColourRefFetch,
  { idle = COLOUR_REF_IDLE, now = () => Date.now() }: { idle?: number; now?: () => number } = {}
): ColourRefStore {
  const entries = new Map<string, Entry>()
  const backoff = new KeyedBackoff()
  let clock = 0
  const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`

  const trim = () => {
    const unused = [...entries].filter(([, e]) => e.users === 0 && !e.pending)
    if (unused.length <= idle) return
    unused.sort((a, b) => a[1].used - b[1].used)
    for (const [k] of unused.slice(0, unused.length - idle)) entries.delete(k)
  }

  // The entry, its fetch started if it has neither pixels nor one under way
  // and isn't backed off.
  const load = (z: number, x: number, y: number): Entry => {
    const k = key(z, x, y)
    let entry = entries.get(k)
    if (!entry) {
      entry = { pixels: null, pending: null, users: 0, used: 0 }
      entries.set(k, entry)
    }
    if (!entry.pixels && !entry.pending && backoff.due(k, now())) {
      const e = entry
      e.pending = fetchTile(z, x, y).then(
        (pixels) => {
          backoff.succeeded(k)
          e.pixels = pixels
          e.pending = null
          trim()
          return pixels
        },
        (error: unknown) => {
          backoff.failed(k, now())
          e.pending = null
          throw error
        }
      )
      // Each waiter handles its own rejection; this one only keeps it quiet.
      e.pending.catch(() => {})
    }
    entry.used = ++clock
    return entry
  }

  return {
    request(window, ready) {
      const tiles = colourRefTiles(window)
      const keys = tiles.map((t) => key(t.z, t.x, t.y))
      const held = tiles.map(({ z, x, y }) => {
        const entry = load(z, x, y)
        entry.users++
        return entry
      })
      let released = false
      let texture: THREE.DataTexture | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const build = () => {
        const byKey = new Map(keys.map((k, i) => [k, held[i].pixels!]))
        texture = colourRefTexture(window, assembleColourRef(window, (z, x, y) => byKey.get(key(z, x, y))!))
        ready(texture)
      }
      // Waits on the missing tiles; where one has failed (or is backed off),
      // tries again once its backoff is over.
      const attempt = () => {
        timer = null
        if (released) return
        tiles.forEach(({ z, x, y }) => load(z, x, y))
        if (held.every((e) => e.pixels)) return build()
        const waits = held.filter((e) => !e.pixels).map((e) => e.pending)
        if (waits.every((p): p is Promise<Uint8Array> => !!p)) Promise.all(waits).then(attempt, later)
        else later()
      }
      const later = () => {
        if (released || timer) return
        const at = Math.max(...keys.map((k) => backoff.nextAt(k)))
        timer = setTimeout(attempt, Math.max(at - now(), 250))
      }
      if (held.every((e) => e.pixels)) build()
      else attempt()
      return () => {
        if (released) return
        released = true
        if (timer) clearTimeout(timer)
        texture?.dispose()
        for (const entry of held) entry.users--
        trim()
      }
    },
    get size() {
      return entries.size
    },
  }
}

/** EOX's tile at z/x/y as 256x256 RGBA (decoded in the worker). */
export async function fetchColourRefTile(z: number, x: number, y: number): Promise<Uint8Array> {
  const url = imageryUrl(EOX_URL, { z, x, y })
  const res = await sideFetch(() => fetchWithRetry(() => fetch(url)))
  if (!res.ok) {
    res.body?.cancel().catch(() => {})
    throw new Error(`colour reference ${url}: HTTP ${res.status}`)
  }
  const image: GradedImage = await imageryGrader().grade(await res.arrayBuffer(), 'none', 'rgba')
  if (image.width !== TILE || image.height !== TILE) throw new Error(`colour reference ${url}: ${image.width}x${image.height}`)
  return new Uint8Array(image.buffer)
}

let shared: ColourRefStore | null = null

/** The page's store (every tileset shares the level-5 tiles). */
export function colourRefStore(): ColourRefStore {
  shared ??= createColourRefStore(fetchColourRefTile)
  return shared
}
