// The imagery's colour match (tides-zmw.9.11): the local match's pixels, the
// BMP a matched tile travels as, the grading worker pool, and the overlay
// matching USGS (only).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageOverlay } from '3d-tiles-renderer/three/plugins'
import {
  createImageryGrader,
  encodeBmp,
  matchPixels,
  type GradeReply,
  type GradeRequest,
  type GradeWorker,
} from './imagery-grade'
import { EOX_URL, imageryUrl, USGS_URL } from './imagery'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'

describe('the match', () => {
  it('matches each pixel by gains bilinear between its grid corners, leaving nodata black', () => {
    // NW doubles red; the other corners leave all be.
    const id = [1, 1, 1]
    const w = 4
    const rgba = new Uint8Array(w * w * 4).fill(40)
    rgba.set([0, 0, 0, 255], 4 * 5)
    // The tile is the cell's north half (a 2 x 2 grid).
    matchPixels(rgba, w, w, { n: 2, gains: [[2, 1, 1], id, id, id].flat(), rect: [0, 0, 1, 0.5] })
    const at = (x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3))
    // Pixel (0, 0): u 1/8, v 1/16 of the cell: NW's weight (7/8)(15/16).
    expect(at(0, 0)).toEqual([Math.round(40 * (1 + (7 / 8) * (15 / 16))), 40, 40])
    expect(at(1, 1)).toEqual([0, 0, 0])
    expect(at(0, 3)[0]).toBeLessThan(at(0, 0)[0])
  })

  it('reads a finer grid across a coarser tile, each pixel between the corners round it', () => {
    // A 3 x 3 grid: only the centre corner halves green.
    const gains = Array.from({ length: 9 }, (_, k) => (k === 4 ? [1, 0.5, 1] : [1, 1, 1])).flat()
    const w = 8
    const rgba = new Uint8Array(w * w * 4).fill(100)
    matchPixels(rgba, w, w, { n: 3, gains, rect: [0, 0, 1, 1] })
    const g = (x: number, y: number) => rgba[(y * w + x) * 4 + 1]
    // Next to the centre (pixel 3/4 of 8: 7/16 of the way, 7/8 of a cell
    // from the edge corners) green is near halved; in a corner, near whole.
    expect(g(3, 3)).toBe(Math.round(100 * (1 - 0.5 * (7 / 8) * (7 / 8))))
    expect(g(0, 0)).toBe(Math.round(100 * (1 - 0.5 * (1 / 8) * (1 / 8))))
    expect(rgba[0]).toBe(100)
  })
})

describe('the BMP a regraded tile travels as', () => {
  it('is a bottom-up 24-bit BMP of the pixels', () => {
    const w = 3
    const h = 2
    const rgba = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) rgba.set([i * 10, i * 10 + 1, i * 10 + 2, 255], i * 4)
    const bmp = new DataView(encodeBmp(rgba, w, h))
    const stride = 12 // 3 * 3 padded to 4
    expect(String.fromCharCode(bmp.getUint8(0), bmp.getUint8(1))).toBe('BM')
    expect(bmp.getUint32(2, true)).toBe(54 + stride * h)
    expect(bmp.getUint32(10, true)).toBe(54)
    expect([bmp.getInt32(18, true), bmp.getInt32(22, true), bmp.getUint16(28, true)]).toEqual([w, h, 24])
    // Pixel (x, y) at row h - 1 - y, BGR.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = 54 + (h - 1 - y) * stride + x * 3
        const i = y * w + x
        expect([bmp.getUint8(o + 2), bmp.getUint8(o + 1), bmp.getUint8(o)]).toEqual([i * 10, i * 10 + 1, i * 10 + 2])
      }
    }
  })
})

class FakeWorker implements GradeWorker {
  posted: GradeRequest[] = []
  private message: ((event: { data: GradeReply }) => void)[] = []
  private error: ((event: unknown) => void)[] = []
  terminated = false
  postMessage(message: GradeRequest) {
    this.posted.push(message)
  }
  addEventListener(type: 'message' | 'error', listener: (event: never) => void) {
    if (type === 'message') this.message.push(listener as (event: { data: GradeReply }) => void)
    else this.error.push(listener as (event: unknown) => void)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: GradeReply) {
    this.message.forEach((l) => l({ data }))
  }
  fail() {
    this.error.forEach((l) => l(new Error('died')))
  }
}

describe('the grading worker pool', () => {
  it('posts a job and resolves with the reply', async () => {
    const worker = new FakeWorker()
    const grader = createImageryGrader({ createWorker: () => worker, inThread: vi.fn() })
    const done = grader.grade(new ArrayBuffer(8), 'match', 'bmp')
    expect(worker.posted).toMatchObject([{ type: 'grade', id: 1, grade: 'match', output: 'bmp' }])
    const buffer = new ArrayBuffer(4)
    worker.reply({ type: 'done', id: 1, buffer, width: 256, height: 256 })
    await expect(done).resolves.toEqual({ buffer, width: 256, height: 256 })
  })

  it('starts a second worker for a job while the first is busy, then shares them out', () => {
    const workers: FakeWorker[] = []
    const grader = createImageryGrader({ createWorker: () => (workers.push(new FakeWorker()), workers[workers.length - 1]), inThread: vi.fn() })
    for (let n = 0; n < 4; n++) void grader.grade(new ArrayBuffer(8), 'none', 'bmp')
    expect(workers).toHaveLength(2)
    expect(workers.map((w) => w.posted.length)).toEqual([2, 2])
  })

  it('cancels an aborted job in the worker and rejects with the reason', async () => {
    const worker = new FakeWorker()
    const grader = createImageryGrader({ createWorker: () => worker, inThread: vi.fn() })
    const controller = new AbortController()
    const done = grader.grade(new ArrayBuffer(8), 'none', 'rgba', controller.signal)
    controller.abort(new DOMException('gone', 'AbortError'))
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.posted[1]).toEqual({ type: 'cancel', id: 1 })
  })

  it('runs in the thread without a worker, and moves pending jobs there when it dies', async () => {
    const image = { buffer: new ArrayBuffer(1), width: 1, height: 1 }
    const inThread = vi.fn(async () => image)
    const noWorker = createImageryGrader({ createWorker: () => null, inThread })
    await expect(noWorker.grade(new ArrayBuffer(8), 'none', 'rgba')).resolves.toBe(image)

    const worker = new FakeWorker()
    const grader = createImageryGrader({ createWorker: () => worker, inThread })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const done = grader.grade(new ArrayBuffer(8), 'match', 'bmp')
    worker.fail()
    await expect(done).resolves.toBe(image)
    expect(worker.terminated).toBe(true)
    expect(inThread).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), 'match', 'bmp', null)
  })
})

describe('the overlay matches USGS tiles (tides-zmw.9.11)', () => {
  afterEach(() => vi.restoreAllMocks())
  const canyon = { z: 16, y: 25721, x: 12355 }
  const tile = (bytes: number) => new Response(new Uint8Array(bytes).fill(7), { status: 200 })

  it('hands the library the matched image for a USGS answer, and EOX\'s as it came', async () => {
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async (url: string) =>
      url.includes('nationalmap') && url.includes('/12/') ? new Response(null, { status: 404 }) : tile(8000)
    )
    const overlay = new SurfaceImageryOverlay()
    const graded = new Uint8Array([1, 2, 3]).buffer
    const regrade = vi.fn(async () => graded)
    overlay.regrade = regrade
    const res = await overlay.fetch(imageryUrl(EOX_URL, canyon), {})
    expect(regrade).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), canyon, undefined)
    expect(res.headers.get('Content-Type')).toBe('image/bmp')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
    // USGS had nothing (EOX answers), and EOX abroad: as they came.
    const eox = await overlay.fetch(imageryUrl(EOX_URL, { z: 12, y: 1607, x: 772 }), {})
    expect((await eox.arrayBuffer()).byteLength).toBe(8000)
    await overlay.fetch(imageryUrl(EOX_URL, { z: 12, y: 1400, x: 2140 }), {})
    expect(regrade).toHaveBeenCalledTimes(1)
  })

  it('takes EOX above USGS\'s orthoimagery levels, and credits it', async () => {
    const calls: string[] = []
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async (url: string) => (calls.push(url), tile(8000)))
    const overlay = new SurfaceImageryOverlay()
    overlay.regrade = vi.fn(async () => new ArrayBuffer(1))
    const z8 = { z: 8, y: 101, x: 48 }
    await overlay.fetch(imageryUrl(EOX_URL, z8), {})
    expect(calls).toEqual([imageryUrl(EOX_URL, z8)])
    expect(overlay.regrade).not.toHaveBeenCalled()
    expect(overlay.servedByEox(z8)).toBe(true)
  })

  it('draws a USGS tile as it came when the match gives nothing (its field too slow)', async () => {
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async () => tile(8000))
    const overlay = new SurfaceImageryOverlay()
    overlay.regrade = vi.fn(async () => null)
    const res = await overlay.fetch(imageryUrl(EOX_URL, canyon), {})
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(200)
    expect(Array.from(new Uint8Array(await res.arrayBuffer())).slice(0, 2)).toEqual([7, 7])
    expect(overlay.regrade).toHaveBeenCalledTimes(1)
  })

  it('draws a tile as it came when matching fails, and passes an abort on', async () => {
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async () => tile(8000))
    const overlay = new SurfaceImageryOverlay()
    overlay.regrade = vi.fn(async () => {
      throw new Error('no decoder')
    })
    const res = await overlay.fetch(imageryUrl(EOX_URL, canyon), {})
    expect((await res.arrayBuffer()).byteLength).toBe(8000)
    expect(overlay.fallbacks).toBe(0)

    overlay.regrade = vi.fn(async () => {
      throw new DOMException('gone', 'AbortError')
    })
    await expect(overlay.fetch(imageryUrl(EOX_URL, canyon), {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(imageryUrl(USGS_URL, canyon)).toContain('nationalmap')
  })
})
