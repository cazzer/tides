// USGS matched to EOX's colour locally (tides-zmw.9.11). How the two are
// colour-balanced changes region by region: one transform fitted offline for
// the whole US missed by ~50 sRGB levels in places (the Grand Canyon's rock:
// USGS 111,107,105 graded to 59,59,46 against EOX's 107,86,54) and turned
// USGS's navy shadows red. So each USGS tile is matched to EOX through a
// field of per-channel gains (sRGB; each takes USGS's mean to EOX's, so
// black stays black) on the corners of the level-MATCH_ZOOM tile grid
// (~20 km), each corner's from the four cells round it, read from both
// sources' level-MATCH_FETCH_ZOOM tiles (2 x 2 cells each) at runtime; across a tile the gain is bilinear
// between the corners round each pixel (a tile coarser than the field
// takes every field corner over it, so its edges agree with finer
// neighbours'). Neighbours share corners, so the field has no step at tile
// or cell edges, and it follows the balance the tiles see. (Level-9 cells,
// ~70 km, left 5-6 dE at the US box's edge at 32.8N.)
//
// USGS is drawn from level 9 down (imagery.ts USGS_MIN_ZOOM; above it, a
// natural-colour mosaic of another balance) and EOX above.
import { fetchWithRetry } from './fetch-retry'
import { EOX_URL, imageryUrl, USGS_URL, type ImageryTile } from './imagery'
export type { MatchParams }
import { imageryGrader, isNodata, type MatchParams } from './imagery-grade'
import { KeyedBackoff, sideFetch } from './side-fetch'

export const MATCH_ZOOM = 11
/** A corner's gain stays within these. */
export const MATCH_GAIN_MIN = 0.5
export const MATCH_GAIN_MAX = 2
/** A cell counts once this share of its USGS pixels is imagery (not nodata). */
export const MATCH_MIN_COVER = 0.25

/** Per-channel moments of an image's pixels (sRGB 0-255). */
export interface ChannelStats {
  n: number
  sum: number[]
  sumSq: number[]
}


/**
 * The moments of `usgs` and `eox` (same size, RGBA) over the pixels where
 * USGS has imagery (not its nodata black), every `stride`th each way, within
 * `region` ([x0, y0, w, h], pixels; the whole image by default).
 */
export function pairStats(
  usgs: ArrayLike<number>,
  eox: ArrayLike<number>,
  width: number,
  height: number,
  stride = 4,
  region: readonly [number, number, number, number] = [0, 0, width, height]
): { usgs: ChannelStats; eox: ChannelStats; cover: number } {
  const u: ChannelStats = { n: 0, sum: [0, 0, 0], sumSq: [0, 0, 0] }
  const e: ChannelStats = { n: 0, sum: [0, 0, 0], sumSq: [0, 0, 0] }
  let all = 0
  const [x0, y0, w, h] = region
  for (let y = y0; y < y0 + h; y += stride) {
    for (let x = x0; x < x0 + w; x += stride) {
      const i = (y * width + x) * 4
      all++
      if (isNodata(usgs, i)) continue
      u.n++
      e.n++
      for (let c = 0; c < 3; c++) {
        u.sum[c] += usgs[i + c]
        u.sumSq[c] += usgs[i + c] ** 2
        e.sum[c] += eox[i + c]
        e.sumSq[c] += eox[i + c] ** 2
      }
    }
  }
  return { usgs: u, eox: e, cover: all ? u.n / all : 0 }
}

export function pooled(list: readonly ChannelStats[]): ChannelStats {
  const out: ChannelStats = { n: 0, sum: [0, 0, 0], sumSq: [0, 0, 0] }
  for (const s of list) {
    out.n += s.n
    for (let c = 0; c < 3; c++) {
      out.sum[c] += s.sum[c]
      out.sumSq[c] += s.sumSq[c]
    }
  }
  return out
}

/** A corner's per-channel gains (sRGB): out = gain * in. */
export type CornerGain = number[]

/**
 * The gains taking `usgs`'s mean to `eox`'s, per channel (black stays black:
 * matching the spread too, with an offset, lifted USGS's deep shadows to
 * dark red in the canyon).
 */
export function matchStats(usgs: ChannelStats, eox: ChannelStats): CornerGain | null {
  if (usgs.n < 16 || eox.n < 16) return null
  return [0, 1, 2].map((c) => {
    const mu = usgs.sum[c] / usgs.n
    const me = eox.sum[c] / eox.n
    return Math.min(MATCH_GAIN_MAX, Math.max(MATCH_GAIN_MIN, mu > 1 ? me / mu : 1))
  })
}

/** A tile's cell at MATCH_ZOOM and its span of it (tiles at MATCH_ZOOM or deeper). */
export function matchCell(tile: ImageryTile): { x: number; y: number; rect: [number, number, number, number] } {
  const k = 2 ** Math.max(0, tile.z - MATCH_ZOOM)
  const u0 = (tile.x % k) / k
  const v0 = (tile.y % k) / k
  return { x: Math.floor(tile.x / k), y: Math.floor(tile.y / k), rect: [u0, v0, u0 + 1 / k, v0 + 1 / k] }
}

/** One cell's moments, both sources, or null where USGS has nothing there
 * (none, or too little imagery: lasting); a throw is a failure to retry. */
export type CellStats = { usgs: ChannelStats; eox: ChannelStats } | null
export type FetchCellStats = (x: number, y: number) => Promise<CellStats>

export interface MatchField {
  /** The params for a USGS tile: the field's gains over the tile, at the
   * field's resolution (a coarser tile takes every field corner over it). */
  params(tile: ImageryTile): Promise<MatchParams>
}

const IDENTITY: CornerGain = [1, 1, 1]

/**
 * The field: cells' moments fetched once each (a failed one backed off,
 * KeyedBackoff), corners' gains from the four cells round each. A corner
 * with no data takes the mean of its eight neighbours' that have (the same
 * for every tile that reads it), else gains of 1 (USGS as it comes).
 */
export function createMatchField(fetchCell: FetchCellStats, { keep = 512, now = () => Date.now() } = {}): MatchField {
  const n = 2 ** MATCH_ZOOM
  const cells = new Map<string, Promise<CellStats>>()
  const backoff = new KeyedBackoff()
  const wrap = (x: number) => ((x % n) + n) % n
  const cell = (x: number, y: number): Promise<CellStats> => {
    if (y < 0 || y >= n) return Promise.resolve(null)
    const key = `${wrap(x)}/${y}`
    let p = cells.get(key)
    if (!p) {
      if (!backoff.due(key, now())) return Promise.resolve(null)
      p = fetchCell(wrap(x), y).then(
        (stats) => (backoff.succeeded(key), stats),
        () => {
          // Retried once its backoff is over, by the next tile that asks.
          backoff.failed(key, now())
          cells.delete(key)
          return null
        }
      )
      cells.set(key, p)
      if (cells.size > keep) cells.delete(cells.keys().next().value!)
    }
    return p
  }
  const raw = async (i: number, j: number): Promise<CornerGain | null> => {
    const found = (await Promise.all([cell(i - 1, j - 1), cell(i, j - 1), cell(i - 1, j), cell(i, j)])).filter(
      (s): s is NonNullable<CellStats> => !!s
    )
    return found.length ? matchStats(pooled(found.map((s) => s.usgs)), pooled(found.map((s) => s.eox))) : null
  }
  const corner = async (i: number, j: number): Promise<CornerGain> => {
    const own = await raw(i, j)
    if (own) return own
    const round: Promise<CornerGain | null>[] = []
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) round.push(raw(i + di, j + dj))
    const known = (await Promise.all(round)).filter((g): g is CornerGain => !!g)
    if (!known.length) return IDENTITY
    return [0, 1, 2].map((c) => known.reduce((a, g) => a + g[c], 0) / known.length)
  }
  return {
    async params(tile) {
      const k = 2 ** Math.max(0, MATCH_ZOOM - tile.z)
      const fine = matchCell(tile)
      const [x0, y0, rect] = k > 1 ? [tile.x * k, tile.y * k, [0, 0, 1, 1] as MatchParams['rect']] : [fine.x, fine.y, fine.rect]
      const side = k + 1
      const grid: Promise<CornerGain>[] = []
      for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) grid.push(corner(x0 + i, y0 + j))
      return { n: side, gains: (await Promise.all(grid)).flat(), rect }
    },
  }
}

/** A tile's pixels; null where it lastingly has none (404); a throw for a failure to retry (429, 5xx, network). */
async function decodeTile(url: string): Promise<Uint8Array | null> {
  const res = await sideFetch(() => fetchWithRetry(() => fetch(url)))
  if (res.status === 404) {
    res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {})
    throw new Error(`USGS match ${url}: HTTP ${res.status}`)
  }
  const image = await imageryGrader().grade(await res.arrayBuffer(), 'none', 'rgba')
  return image.width === 256 && image.height === 256 ? new Uint8Array(image.buffer) : null
}

/** The level whose tiles the cells' moments are read from: each tile, of
 * both sources, gives 2 x 2 cells (128 px each way of it), so a view's
 * field takes a quarter of the fetches. Not level 9: EOX's level 9 is
 * darker than its finer levels in places (the canyon's red 107 against 120
 * at levels 10 to 13). */
export const MATCH_FETCH_ZOOM = MATCH_ZOOM - 1
const PER_BLOCK = 2 ** (MATCH_ZOOM - MATCH_FETCH_ZOOM)

/**
 * Cells' moments read from level-MATCH_FETCH_ZOOM tiles (PER_BLOCK each way) (`fetchPair`: both
 * sources' pixels, USGS first and EOX only where USGS has imagery, null
 * where USGS has none), each pair fetched once while any cell of it is
 * asked for; a failed pair throws for each of its cells (the field backs
 * them off) and is asked for again after.
 */
export function blockCells(fetchPair: (x: number, y: number) => Promise<{ usgs: Uint8Array; eox: Uint8Array } | null>, keep = 64): FetchCellStats {
  const blocks = new Map<string, Promise<CellStats[] | null>>()
  return async (x, y) => {
    const bx = Math.floor(x / PER_BLOCK)
    const by = Math.floor(y / PER_BLOCK)
    const key = `${bx}/${by}`
    let block = blocks.get(key)
    if (!block) {
      block = fetchPair(bx, by).then((pair) => {
        if (!pair) return null
        const side = 256 / PER_BLOCK
        const cells: CellStats[] = []
        for (let j = 0; j < PER_BLOCK; j++) {
          for (let i = 0; i < PER_BLOCK; i++) {
            const s = pairStats(pair.usgs, pair.eox, 256, 256, 2, [i * side, j * side, side, side])
            cells.push(s.cover >= MATCH_MIN_COVER ? { usgs: s.usgs, eox: s.eox } : null)
          }
        }
        return cells
      })
      block.catch(() => blocks.delete(key))
      blocks.set(key, block)
      if (blocks.size > keep) blocks.delete(blocks.keys().next().value!)
    }
    const cells = await block
    return cells ? cells[(y - by * PER_BLOCK) * PER_BLOCK + (x - bx * PER_BLOCK)] : null
  }
}

/** A level-MATCH_FETCH_ZOOM tile's pixels of both sources, decoded in the
 * grader's worker: USGS first, and EOX only where USGS has imagery. */
export async function fetchMatchPair(x: number, y: number): Promise<{ usgs: Uint8Array; eox: Uint8Array } | null> {
  const tile = { z: MATCH_FETCH_ZOOM, x, y }
  const usgs = await decodeTile(imageryUrl(USGS_URL, tile))
  if (!usgs || pairStats(usgs, usgs, 256, 256).cover < MATCH_MIN_COVER / (PER_BLOCK * PER_BLOCK)) return null
  const eox = await decodeTile(imageryUrl(EOX_URL, tile))
  return eox ? { usgs, eox } : null
}

let shared: MatchField | null = null

/** The page's field (every overlay shares the cells). */
export function matchField(): MatchField {
  shared ??= createMatchField(blockCells(fetchMatchPair))
  return shared
}
