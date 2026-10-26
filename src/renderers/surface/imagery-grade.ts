// The streamed imagery's colour match (tides-zmw.9.11): USGS's National Map
// tiles matched to EOX's Sentinel-2 colour as the overlay fetches them
// (SurfaceImageryOverlay.ts), by a field of per-channel gains fitted at
// runtime on both sources (imagery-match.ts), applied here in a worker
// (imagery-grade.worker.ts), so the two sources meet without a colour step
// at every height. EOX itself stays as it comes: near the ground the tiles
// show the imagery's own colour, and higher up they anchor to the globe's
// day map (tile-colour.ts). Nothing fitted offline is shipped.
//
/**
 * A width x height RGBA image as an uncompressed 24-bit BMP (bottom-up BGR
 * rows, each padded to 4 bytes): what the overlay hands the library in place
 * of a regraded tile's JPEG. The library decodes it as any image
 * (createImageBitmap, no colour conversion), losslessly and fast.
 */
export function encodeBmp(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): ArrayBuffer {
  const stride = (width * 3 + 3) & ~3
  const size = 54 + stride * height
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  bytes[0] = 0x42 // 'B'
  bytes[1] = 0x4d // 'M'
  view.setUint32(2, size, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, stride * height, true)
  view.setInt32(38, 2835, true)
  view.setInt32(42, 2835, true)
  for (let y = 0; y < height; y++) {
    let o = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      bytes[o++] = rgba[i + 2]
      bytes[o++] = rgba[i + 1]
      bytes[o++] = rgba[i]
    }
  }
  return buffer
}

/** USGS's nodata (pure black, where it has no imagery). */
export const isNodata = (rgba: ArrayLike<number>, i: number) => rgba[i] + rgba[i + 1] + rgba[i + 2] <= 3

/**
 * What the worker needs to match a tile: the field's per-channel gains on an
 * n x n grid of corners (row by row from the north-west, 3 each) and the
 * tile's span of that grid, [u0, v0, u1, v1] with the grid's corners at 0
 * and 1 (a tile inside one cell spans part of a 2 x 2 grid; a coarser one
 * the whole of a finer grid of the field's corners).
 */
export interface MatchParams {
  n: number
  gains: number[]
  rect: [number, number, number, number]
}

/** The match on RGBA bytes in place (alpha and nodata untouched): each
 * pixel's gains bilinear between the grid corners round it. */
export function matchPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, params: MatchParams): void {
  const { n, gains, rect } = params
  const cells = n - 1
  const gain = [0, 0, 0]
  for (let y = 0; y < height; y++) {
    const gy = Math.min(cells, Math.max(0, (rect[1] + ((y + 0.5) / height) * (rect[3] - rect[1])) * cells))
    const j = Math.min(cells - 1, Math.floor(gy))
    const fy = gy - j
    for (let x = 0; x < width; x++) {
      const i4 = (y * width + x) * 4
      if (isNodata(rgba, i4)) continue
      const gx = Math.min(cells, Math.max(0, (rect[0] + ((x + 0.5) / width) * (rect[2] - rect[0])) * cells))
      const i = Math.min(cells - 1, Math.floor(gx))
      const fx = gx - i
      const nw = (j * n + i) * 3
      const ne = nw + 3
      const sw = nw + n * 3
      const se = sw + 3
      for (let c = 0; c < 3; c++) {
        gain[c] =
          (1 - fy) * ((1 - fx) * gains[nw + c] + fx * gains[ne + c]) + fy * ((1 - fx) * gains[sw + c] + fx * gains[se + c])
        const out = gain[c] * rgba[i4 + c]
        rgba[i4 + c] = out >= 255 ? 255 : Math.round(out)
      }
    }
  }
}

/** Which job: 'match' applies the job's MatchParams (the local field);
 * 'none' only decodes (the coarse reference's tiles and the field's own). */
export type GradeName = 'match' | 'none'

/** What a grading job gives back: a BMP to stand in for the tile, or the
 * graded pixels themselves. */
export type GradeOutput = 'bmp' | 'rgba'

export type GradeRequest =
  | { type: 'grade'; id: number; buffer: ArrayBuffer; grade: GradeName; output: GradeOutput; match?: MatchParams | null }
  | { type: 'cancel'; id: number }

export type GradeReply =
  | { type: 'done'; id: number; buffer: ArrayBuffer; width: number; height: number }
  | { type: 'error'; id: number; message: string; name?: string }

export interface GradedImage {
  /** A BMP file, or width x height RGBA bytes. */
  buffer: ArrayBuffer
  width: number
  height: number
}

/**
 * Decodes an image file (a fetched tile), applies the match, and gives back a
 * BMP or the RGBA bytes: the worker's job, also run on the main thread where
 * no worker can. Throws where nothing here can decode (no OffscreenCanvas).
 */
export async function gradeImage(
  buffer: ArrayBuffer,
  grade: GradeName,
  output: GradeOutput,
  match?: MatchParams | null
): Promise<GradedImage> {
  const bitmap = await createImageBitmap(new Blob([buffer]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    const { width, height } = bitmap
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('imagery grade: no 2D context')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, width, height)
    if (grade === 'match' && match) matchPixels(data, width, height, match)
    if (output === 'bmp') return { buffer: encodeBmp(data, width, height), width, height }
    return { buffer: data.buffer as ArrayBuffer, width, height }
  } finally {
    bitmap.close()
  }
}

/** The part of Worker the grader uses. */
export interface GradeWorker {
  postMessage(message: GradeRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: GradeReply }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  terminate(): void
}

export interface ImageryGrader {
  grade(buffer: ArrayBuffer, grade: GradeName, output: GradeOutput, signal?: AbortSignal | null, match?: MatchParams | null): Promise<GradedImage>
  dispose(): void
}

/** Workers in the grader's pool: every imagery tile passes through one. */
export const GRADE_WORKERS = 2

/**
 * A small pool of workers for the grading jobs, started as jobs come
 * (the idlest takes the next); without one (no module workers or
 * OffscreenCanvas), or once one dies, jobs run in `inThread`.
 */
export function createImageryGrader({
  createWorker,
  inThread = gradeImage,
  size = GRADE_WORKERS,
}: {
  createWorker: () => GradeWorker | null
  inThread?: typeof gradeImage
  size?: number
}): ImageryGrader {
  interface Job {
    resolve: (image: GradedImage) => void
    reject: (error: unknown) => void
    buffer: ArrayBuffer
    grade: GradeName
    output: GradeOutput
    match: MatchParams | null
  }
  interface Slot {
    worker: GradeWorker
    jobs: Map<number, Job>
  }
  const slots: Slot[] = []
  let workersOk = true
  let nextId = 1

  const fallBack = (error: unknown) => {
    if (!workersOk) return
    console.warn('surface tiles: imagery grade worker failed; grading on the main thread', error)
    workersOk = false
    for (const slot of slots.splice(0)) {
      slot.worker.terminate()
      for (const job of slot.jobs.values()) inThread(job.buffer, job.grade, job.output, job.match).then(job.resolve, job.reject)
      slot.jobs.clear()
    }
  }

  const start = (): Slot | null => {
    let worker: GradeWorker | null = null
    try {
      worker = createWorker()
    } catch (error) {
      console.warn('surface tiles: no imagery grade worker; grading on the main thread', error)
    }
    if (!worker) return null
    const slot: Slot = { worker, jobs: new Map() }
    worker.addEventListener('message', ({ data }) => {
      const job = slot.jobs.get(data.id)
      if (!job) return
      slot.jobs.delete(data.id)
      if (data.type === 'done') job.resolve({ buffer: data.buffer, width: data.width, height: data.height })
      else job.reject(Object.assign(new Error(data.message), { name: data.name ?? 'Error' }))
    })
    worker.addEventListener('error', fallBack)
    return slot
  }

  const pick = (): Slot | null => {
    let best: Slot | null = null
    for (const slot of slots) if (!best || slot.jobs.size < best.jobs.size) best = slot
    if ((!best || best.jobs.size > 0) && slots.length < size) {
      const slot = start()
      if (slot) {
        slots.push(slot)
        return slot
      }
      if (!slots.length) workersOk = false
    }
    return best
  }

  return {
    grade(buffer, grade, output, signal, match = null) {
      signal?.throwIfAborted()
      const slot = workersOk ? pick() : null
      if (!slot) return inThread(buffer, grade, output, match)
      const id = nextId++
      return new Promise<GradedImage>((resolve, reject) => {
        const onAbort = () => {
          if (!slot.jobs.delete(id)) return
          slot.worker.postMessage({ type: 'cancel', id })
          reject(signal!.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const settle =
          <T,>(f: (v: T) => void) =>
          (v: T) => {
            signal?.removeEventListener('abort', onAbort)
            f(v)
          }
        slot.jobs.set(id, { resolve: settle(resolve), reject: settle(reject), buffer, grade, output, match })
        // Copied, not transferred: if the worker dies, the job reruns here.
        slot.worker.postMessage({ type: 'grade', id, buffer, grade, output, match })
      })
    },
    dispose() {
      workersOk = false
      for (const slot of slots.splice(0)) {
        slot.worker.terminate()
        for (const job of slot.jobs.values()) job.reject(new DOMException('imagery grader disposed', 'AbortError'))
        slot.jobs.clear()
      }
    },
  }
}

function canWorkerGrade(): boolean {
  try {
    return typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && new OffscreenCanvas(1, 1).getContext('2d') !== null
  } catch {
    return false
  }
}

/** Whether this page can decode a tile to grade it, in a worker or not. */
export function canGradeImagery(): boolean {
  try {
    return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && new OffscreenCanvas(1, 1).getContext('2d') !== null
  } catch {
    return false
  }
}

let shared: ImageryGrader | null = null

/** The page's grader (one pool for every overlay and the coarse reference). */
export function imageryGrader(): ImageryGrader {
  shared ??= createImageryGrader({
    createWorker: () =>
      canWorkerGrade()
        ? (new Worker(new URL('./imagery-grade.worker.ts', import.meta.url), { type: 'module', name: 'imagery-grade' }) as unknown as GradeWorker)
        : null,
  })
  return shared
}
