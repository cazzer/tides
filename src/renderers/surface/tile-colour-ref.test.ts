// The tiles' coarse colour reference (tides-zmw.9.11): each tile's window on
// the global level-5 pixel grid, so neighbours agree at their shared edge;
// its assembly across tile and antimeridian edges; the store's fetches,
// sharing and release.
import { describe, expect, it, vi } from 'vitest'
import {
  assembleColourRef,
  COLOUR_REF_ZOOM,
  colourRefTiles,
  colourRefWindow,
  colourRefWindowUniform,
  createColourRefStore,
  mercatorX,
  mercatorY,
  type ColourRefWindow,
} from './tile-colour-ref'


/** A Web Mercator tile's footprint, radians. */
function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z
  const lat = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)))
  return { west: (x / n) * 2 * Math.PI - Math.PI, east: ((x + 1) / n) * 2 * Math.PI - Math.PI, north: lat(y), south: lat(y + 1) }
}

/** A made-up global level-5 field: pixel (px, py) -> RGB. */
const field = (px: number, py: number) => [(px * 7 + py * 3) % 256, (px * 5 + py * 11) % 256, (px + py * 2) % 256]
const made = new Map<string, Uint8Array>()
const tilePixels = (z: number, x: number, y: number) => {
  const key = `${z}/${x}/${y}`
  if (made.has(key)) return made.get(key)!
  const out = new Uint8Array(256 * 256 * 4)
  made.set(key, out)
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) out.set([...field(x * 256 + i, y * 256 + j), 255], (j * 256 + i) * 4)
  }
  return out
}

/** The shader's bilinear read of a window's texture at globe coordinate (u, mercator y). */
function sample(window: ColourRefWindow, rgba: Uint8Array, u: number, my: number): number[] {
  const w = colourRefWindowUniform(window)
  const fx = (((u - w.x) % 1) + 1) % 1
  const tx = fx * w.z * window.width - 0.5
  const ty = (my - w.y) * w.w * window.height - 0.5
  const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v))
  const x0 = Math.floor(tx)
  const y0 = Math.floor(ty)
  const at = (x: number, y: number, c: number) => rgba[(clamp(y, window.height) * window.width + clamp(x, window.width)) * 4 + c]
  return [0, 1, 2].map((c) => {
    const a = at(x0, y0, c) + (at(x0 + 1, y0, c) - at(x0, y0, c)) * (tx - x0)
    const b = at(x0, y0 + 1, c) + (at(x0 + 1, y0 + 1, c) - at(x0, y0 + 1, c)) * (tx - x0)
    return a + (b - a) * (ty - y0)
  })
}

describe('the colour reference window (tides-zmw.9.11)', () => {
  it('covers a tile\'s level-5 pixels and one more each side', () => {
    // A level-10 tile spans 8 level-5 pixels each way.
    const window = colourRefWindow(tileBounds(10, 197, 403), 10)
    expect(window.zoom).toBe(COLOUR_REF_ZOOM)
    expect(window.x0).toBe((197 * 256) / 32 - 1)
    expect(window.width).toBe(8 + 2)
    expect(window.height).toBe(8 + 2)
    // A coarser tile takes its own level's pixels: 256 and the border.
    const coarse = colourRefWindow(tileBounds(3, 1, 3), 3)
    expect([coarse.zoom, coarse.x0, coarse.y0, coarse.width, coarse.height]).toEqual([3, 255, 767, 258, 258])
  })

  it('keeps to the map\'s rows at the poles and a world\'s width at most', () => {
    const root = colourRefWindow({ west: -Math.PI, east: Math.PI, north: Math.PI / 2, south: -Math.PI / 2 }, 0)
    expect(root).toEqual({ zoom: 0, x0: -1, y0: -1, width: 258, height: 258 })
    expect(mercatorY(Math.PI / 2)).toBe(0)
    expect(mercatorY(-Math.PI / 2)).toBe(1)
    expect(mercatorX(0)).toBe(0.5)
    expect(mercatorY(0)).toBeCloseTo(0.5, 12)
  })

  it('agrees to the bit with its neighbour along their shared edge', () => {
    // Two level-11 tiles side by side and one below, over the canyon.
    const [a, b, c] = [tileBounds(11, 394, 806), tileBounds(11, 395, 806), tileBounds(11, 394, 807)]
    const win = (t: typeof a) => colourRefWindow(t, 11)
    const tex = (w: ColourRefWindow) => assembleColourRef(w, tilePixels)
    const [wa, wb, wc] = [win(a), win(b), win(c)]
    const [ta, tb, tc] = [tex(wa), tex(wb), tex(wc)]
    for (let k = 0; k <= 10; k++) {
      // Along a's east edge (b's west).
      const my = mercatorY(a.north + ((a.south - a.north) * k) / 10)
      const u = mercatorX(a.east)
      expect(sample(wa, ta, u, my)).toEqual(sample(wb, tb, u, my))
      // Along a's south edge (c's north).
      const u2 = mercatorX(a.west + ((a.east - a.west) * k) / 10)
      const my2 = mercatorY(a.south)
      expect(sample(wa, ta, u2, my2)).toEqual(sample(wc, tc, u2, my2))
    }
    // And reads the global field: a pixel's centre gives the pixel.
    const px = wa.x0 + 3
    const py = wa.y0 + 4
    const n = 256 * 32
    expect(sample(wa, ta, (px + 0.5) / n, (py + 0.5) / n)).toEqual(field(px, py))
  })

  it('wraps round the antimeridian and reads the edge row past the map', () => {
    // The level-5 tile at the antimeridian's east side, top row.
    const window = colourRefWindow(tileBounds(5, 0, 0), 5)
    expect(window.x0).toBe(-1)
    expect(colourRefTiles(window).map(({ x, y }) => `${x}/${y}`).sort()).toEqual(['0/0', '0/1', '1/0', '1/1', '31/0', '31/1'])
    const rgba = assembleColourRef(window, tilePixels)
    const n = 256 * 32
    // Column 0 is the world's last pixel; row 0 (above the map) repeats row 0.
    expect(Array.from(rgba.subarray(0, 3))).toEqual(field(n - 1, 0))
    expect(Array.from(rgba.subarray(window.width * 4 + 4, window.width * 4 + 7))).toEqual(field(0, 0))
  })
})

describe('the colour reference store', () => {
  const window = colourRefWindow(tileBounds(10, 197, 403), 10)

  it('fetches each level-5 tile once, shares it, and builds a texture per request', async () => {
    const fetchTile = vi.fn(async (z: number, x: number, y: number) => tilePixels(z, x, y))
    const store = createColourRefStore(fetchTile)
    const ready = vi.fn()
    const releaseA = store.request(window, ready)
    const releaseB = store.request(window, ready)
    expect(fetchTile).toHaveBeenCalledTimes(colourRefTiles(window).length)
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
    const [texA] = ready.mock.calls[0]
    expect(texA.image.width).toBe(window.width)
    // In hand now: a third request is ready at once.
    const now = vi.fn()
    const releaseC = store.request(window, now)
    expect(now).toHaveBeenCalledTimes(1)
    expect(fetchTile).toHaveBeenCalledTimes(colourRefTiles(window).length)
    const disposed = vi.fn()
    texA.addEventListener('dispose', disposed)
    releaseA()
    expect(disposed).toHaveBeenCalledTimes(1)
    releaseB()
    releaseC()
    expect(store.size).toBe(colourRefTiles(window).length)
  })

  it('waits out a failed tile\'s backoff, asks again, and hands the texture over then', async () => {
    vi.useFakeTimers()
    try {
      let t = 0
      let fail = true
      const fetchTile = vi.fn(async (z: number, x: number, y: number) => {
        if (fail) throw new Error('503')
        return tilePixels(z, x, y)
      })
      const store = createColourRefStore(fetchTile, { now: () => t })
      const ready = vi.fn()
      store.request(window, ready)
      await vi.advanceTimersByTimeAsync(0)
      expect(ready).not.toHaveBeenCalled()
      const first = fetchTile.mock.calls.length
      // Within the backoff nothing is asked for; past it, the request asks
      // again by itself and gets its texture.
      fail = false
      t = 5_000
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetchTile.mock.calls.length).toBe(first)
      t = 10_000
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetchTile.mock.calls.length).toBeGreaterThan(first)
      await vi.advanceTimersByTimeAsync(0)
      expect(ready).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never calls back after release, refetches a failed tile, and keeps only so many idle', async () => {
    let fail = true
    let t = 0
    const fetchTile = vi.fn(async (z: number, x: number, y: number) => {
      if (fail) throw new Error('offline')
      return tilePixels(z, x, y)
    })
    const store = createColourRefStore(fetchTile, { idle: 0, now: () => t })
    const ready = vi.fn()
    const release = store.request(window, ready)
    await new Promise((r) => setTimeout(r, 0))
    expect(ready).not.toHaveBeenCalled()
    release()
    fail = false
    t = 20_000
    const again = vi.fn()
    const releaseAgain = store.request(window, again)
    await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1))
    const late = vi.fn()
    store.request(window, late)()
    expect(late).toHaveBeenCalledTimes(1) // in hand: called before the release
    releaseAgain()
    // With none kept idle, the released tiles go.
    expect(store.size).toBe(0)
  })
})
