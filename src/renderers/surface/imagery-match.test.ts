// USGS matched to EOX locally (tides-zmw.9.11): the moments, the per-channel
// gain, the cells and their corners, and a field with no step between
// neighbouring tiles.
import { describe, expect, it, vi } from 'vitest'
import { matchPixels } from './imagery-grade'
import {
  blockCells,
  createMatchField,
  MATCH_FETCH_ZOOM,
  MATCH_GAIN_MAX,
  MATCH_ZOOM,
  matchCell,
  matchStats,
  pairStats,
  pooled,
  type CellStats,
  type ChannelStats,
} from './imagery-match'

/** An RGBA image of `n` pixels from a colour per pixel. */
const image = (colours: number[][]) => Uint8Array.from(colours.flatMap((c) => [...c, 255]))

const stats = (mean: number[], sd: number[], n = 100): ChannelStats => ({
  n,
  sum: mean.map((m) => m * n),
  sumSq: mean.map((m, c) => (m * m + sd[c] * sd[c]) * n),
})

describe('the local USGS match (tides-zmw.9.11)', () => {
  it('takes the moments where USGS has imagery, the same pixels of both', () => {
    const usgs = image([[0, 0, 0], [100, 50, 20], [120, 70, 40], [0, 0, 0]])
    const eox = image([[9, 9, 9], [80, 60, 30], [100, 80, 50], [9, 9, 9]])
    const s = pairStats(usgs, eox, 2, 2, 1)
    expect(s.cover).toBe(0.5)
    expect(s.usgs.n).toBe(2)
    expect(s.usgs.sum).toEqual([220, 120, 60])
    expect(s.eox.sum).toEqual([180, 140, 80])
    expect(pooled([s.usgs, s.usgs]).sum).toEqual([440, 240, 120])
  })

  it('takes USGS\'s mean to EOX\'s per channel by a bounded gain, black staying black', () => {
    const g = matchStats(stats([111, 107, 105], [20, 20, 20]), stats([107, 86, 54], [30, 25, 15]))!
    expect(g[0] * 111).toBeCloseTo(107, 9)
    expect(g[1] * 107).toBeCloseTo(86, 9)
    expect(g[2] * 105).toBeCloseTo(54, 9)
    expect(matchStats(stats([50, 50, 50], [1, 1, 1]), stats([150, 150, 150], [10, 10, 10]))![0]).toBe(MATCH_GAIN_MAX)
    expect(matchStats(stats([1, 1, 1], [1, 1, 1], 4), stats([1, 1, 1], [1, 1, 1]))).toBeNull()
  })

  it('finds a tile\'s cell and its span of it', () => {
    const z = MATCH_ZOOM
    expect(matchCell({ z, x: 386, y: 803 })).toEqual({ x: 386, y: 803, rect: [0, 0, 1, 1] })
    expect(matchCell({ z: z + 3, x: 386 * 8 + 5, y: 803 * 8 + 7 })).toEqual({ x: 386, y: 803, rect: [5 / 8, 7 / 8, 6 / 8, 1] })
  })

  // EOX's red over USGS's 100: 100 + 10 * (column + row) from (cx - 1, cy - 1).
  const [cx, cy] = [386, 803]
  const eoxRed = (x: number, y: number) => 100 + 10 * (x - cx + 1 + y - cy + 1)
  const cellAt = (x: number, y: number): CellStats => ({ usgs: stats([100, 100, 100], [10, 10, 10]), eox: stats([eoxRed(x, y), 100, 100], [10, 10, 10]) })

  it('pools each corner over the four cells round it and has no step at a cell edge', async () => {
    const fetchCell = vi.fn(async (x: number, y: number) => cellAt(x, y))
    const field = createMatchField(fetchCell)
    const z = MATCH_ZOOM + 3
    // Two tiles either side of the edge between cells cx and cx + 1.
    const west = await field.params({ z, x: cx * 8 + 7, y: cy * 8 + 3 })
    const east = await field.params({ z, x: (cx + 1) * 8, y: cy * 8 + 3 })
    expect([west.n, east.n]).toEqual([2, 2])
    // west's north-east and south-east corners are east's north-west and south-west.
    expect(west.gains.slice(3, 6)).toEqual(east.gains.slice(0, 3))
    expect(west.gains.slice(9, 12)).toEqual(east.gains.slice(6, 9))
    // The north-west corner of cell cx/cy pools cells cx-1..cx x cy-1..cy:
    // USGS's mean red goes to EOX's pooled mean, (100 + 110 + 110 + 120) / 4.
    expect(west.gains[0] * 100).toBeCloseTo(110, 9)
    // Each cell fetched once, however many tiles ask.
    const asked = fetchCell.mock.calls.length
    await field.params({ z: z + 1, x: cx * 16 + 2, y: cy * 16 + 2 })
    expect(fetchCell.mock.calls.length).toBe(asked)
    // Applied, the field moves a pixel at the shared edge the same from either side.
    const px = () => new Uint8Array([100, 100, 100, 255])
    const [a, b] = [px(), px()]
    matchPixels(a, 1, 1, { ...west, rect: [1, 0.5, 1, 0.5] })
    matchPixels(b, 1, 1, { ...east, rect: [0, 0.5, 0, 0.5] })
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('takes every field corner over a coarser tile, so its edges agree with finer neighbours', async () => {
    const field = createMatchField(async (x, y) => cellAt(x, y))
    // A tile two levels coarser covers 4 x 4 cells: a 5 x 5 grid of corners.
    const coarse = await field.params({ z: MATCH_ZOOM - 2, x: 96, y: 200 })
    expect(coarse.n).toBe(5)
    expect(coarse.rect).toEqual([0, 0, 1, 1])
    // Its grid corner (1, 0) is field corner (385, 800), the fine tile there's north-west.
    const fine = await field.params({ z: MATCH_ZOOM, x: 385, y: 800 })
    expect(coarse.gains.slice(3, 6)).toEqual(fine.gains.slice(0, 3))
  })

  it('fills a corner with no data from its own neighbours, the same for every tile, else leaves USGS be', async () => {
    // No data in the 2 x 2 cells round corner (cx + 1, cy + 1).
    const empty = (x: number, y: number) => (x === cx || x === cx + 1) && (y === cy || y === cy + 1)
    const field = createMatchField(async (x, y) => (empty(x, y) ? null : cellAt(x, y)))
    const a = await field.params({ z: MATCH_ZOOM, x: cx, y: cy })
    const b = await field.params({ z: MATCH_ZOOM, x: cx + 1, y: cy + 1 })
    // a's south-east corner is b's north-west: filled once, the same for both.
    expect(a.gains.slice(9, 12)).toEqual(b.gains.slice(0, 3))
    expect(a.gains[9]).toBeGreaterThan(1)
    const none = createMatchField(async () => null)
    expect((await none.params({ z: MATCH_ZOOM, x: cx, y: cy })).gains).toEqual(new Array(12).fill(1))
  })

  it('reads 2 x 2 cells from each pair of coarser tiles, fetched once, and asks again after a failure', async () => {
    expect(MATCH_ZOOM - MATCH_FETCH_ZOOM).toBe(1)
    // USGS's red is 10 times the 128 px block's column; EOX's twice USGS's;
    // the bottom-right block nodata.
    const usgs = new Uint8Array(256 * 256 * 4)
    const eox = new Uint8Array(256 * 256 * 4)
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4
        const nodata = x >= 128 && y >= 128
        usgs.set(nodata ? [0, 0, 0, 255] : [10 * (1 + (x >> 7)), 50, 50, 255], i)
        eox.set([20 * (1 + (x >> 7)), 50, 50, 255], i)
      }
    }
    let fail = false
    const fetchPair = vi.fn(async () => {
      if (fail) throw new Error('503')
      return { usgs, eox }
    })
    const cell = blockCells(fetchPair)
    const c = (await cell(2 * 7 + 1, 2 * 9))!
    expect(c.usgs.sum[0] / c.usgs.n).toBe(20)
    expect(c.eox.sum[0] / c.eox.n).toBe(40)
    expect(await cell(2 * 7 + 1, 2 * 9 + 1)).toBeNull()
    expect(fetchPair).toHaveBeenCalledTimes(1)
    expect(fetchPair).toHaveBeenLastCalledWith(7, 9)
    fail = true
    await expect(cell(0, 0)).rejects.toThrow('503')
    fail = false
    expect(await cell(0, 0)).not.toBeNull()
    expect(fetchPair).toHaveBeenCalledTimes(3)
  })

  it('backs a failed cell off, then asks for it again', async () => {
    let t = 0
    let fail = true
    const fetchCell = vi.fn(async (x: number, y: number) => {
      if (fail) throw new Error('503')
      return cellAt(x, y)
    })
    const field = createMatchField(fetchCell, { now: () => t })
    const tile = { z: MATCH_ZOOM, x: cx, y: cy }
    expect((await field.params(tile)).gains).toEqual(new Array(12).fill(1))
    const first = fetchCell.mock.calls.length
    fail = false
    t = 1000
    await field.params(tile)
    expect(fetchCell.mock.calls.length).toBe(first)
    t = 60_000
    expect((await field.params(tile)).gains[0]).toBeGreaterThan(1)
  })
})
