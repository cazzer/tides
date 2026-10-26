// A per-frame allowance for the main-thread end of a terrain tile
// (tides-zmw.9.2): wrapping a decoded grid in a texture, stitching its edges
// into the loaded neighbours and uploading it, and (tides-zmw.9.15) copying
// the windows a horizon bake reads. Each step is a few ms; a fast descent
// finishes dozens of tiles at once, which in one frame was the 870 ms stall
// the spike measured. Work queues here and SurfaceTiles' frame loop runs it,
// in the frame, until `msPerFrame` of it has run. Not budgeted: stitching
// marks up to eight loaded neighbours dirty, and three re-uploads each (1 MB)
// at its next draw.
//
// tides-zmw.9.25: by time, not count. Two grids a frame, first come first
// served with the bakes (which outnumber the grids two to one), held grids
// back 70-130 ms at 11-15 fps while the frame had time to spare. A grid's
// tile can't draw until the grid is made, and a bake only sharpens a tile
// already drawn, so grids go first and bakes take the time left (or one a
// frame once one has waited BAKE_MAX_WAIT_MS, so a long run of grids never
// shuts them out). Last and least, tile uploads (tile-upload.ts): only
// with time left after both, at most UPLOAD_BYTES_PER_FRAME a frame, never
// forced (a tile's first draw uploads whatever is still waiting here),
// and none while any of the last UPLOAD_FRAME_WINDOW frames took longer
// than UPLOAD_MAX_FRAME_MS: a GPU that far behind makes each upload wait
// for it (20-130 ms each under a loaded GPU), where the draw's own upload
// costs no more. (The longest of a few frames, not the last one: a GPU-bound
// 30 fps frame jitters either side of any single cut-off.)

/** Main-thread ms of budgeted work run per frame (a frame always runs at least one grid or bake). */
export const FRAME_BUDGET_MS = 4

/** How long a bake waits behind grids before one a frame goes through regardless, ms. */
export const BAKE_MAX_WAIT_MS = 500

/** Bytes of tile uploads a frame lets through (two elevation grids' worth). */
export const UPLOAD_BYTES_PER_FRAME = 2 * 1024 * 1024

/** The longest recent frame (ms between ticks) uploads still run after: slower, and the GPU is the bottleneck (below a steady 30 fps's 33 ms). */
export const UPLOAD_MAX_FRAME_MS = 26

/** How many recent frames UPLOAD_MAX_FRAME_MS is judged over (the longest of them). */
export const UPLOAD_FRAME_WINDOW = 4

/** Tile uploads kept waiting; past this the oldest is dropped (its tile's draw uploads it). */
export const UPLOAD_MAX_PENDING = 64

/**
 * A grid's end (its tile draws once it's done), a horizon bake's copying
 * (it only sharpens) or a tile's upload ahead of its first draw.
 */
export type BudgetLane = 'grid' | 'bake' | 'upload'

interface Job {
  work: () => unknown
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  /** When it queued (the clock's ms). */
  at: number
  signal?: AbortSignal
  onAbort?: () => void
  /** An upload's bytes, asked just before it would run. */
  size?: () => number
}

/** The budget's running totals since it was made (for the counters and the harnesses; never reset). */
export interface FrameBudgetStats {
  /** Jobs run. */
  jobs: number
  /** Ms of work run, all told. */
  ms: number
  /** The most one tick ran, ms. */
  maxTickMs: number
  /** The longest single job, ms. */
  maxJobMs: number
  /** Bakes let through ahead of grids for having waited BAKE_MAX_WAIT_MS. */
  agedBakes: number
  /** Bytes the upload lane's jobs were sized at when they ran. */
  uploadBytes: number
  /** Upload jobs dropped for UPLOAD_MAX_PENDING. */
  droppedUploads: number
  /** Ticks with uploads waiting that ran none for a recent frame longer than UPLOAD_MAX_FRAME_MS. */
  slowFrames: number
}

export class FrameBudget {
  private readonly lanes: Record<BudgetLane, Job[]> = { grid: [], bake: [], upload: [] }
  private disposed = false
  /** The clock at the last tick (none yet: NaN). */
  private lastTick = NaN
  /** The last UPLOAD_FRAME_WINDOW frames' lengths, ms. */
  private readonly frames: number[] = []
  readonly stats: FrameBudgetStats = { jobs: 0, ms: 0, maxTickMs: 0, maxJobMs: 0, agedBakes: 0, uploadBytes: 0, droppedUploads: 0, slowFrames: 0 }

  constructor(
    readonly msPerFrame = FRAME_BUDGET_MS,
    private readonly clock: () => number = () => performance.now()
  ) {}

  /** How many are waiting for a turn. */
  get pending(): number {
    return this.lanes.grid.length + this.lanes.bake.length + this.lanes.upload.length
  }

  /**
   * Runs `work` synchronously in a later tick, once its turn comes (grids,
   * then bakes, then uploads, each lane in arrival order), and resolves
   * with what it returns (rejects with what it throws). Rejects with the
   * signal's reason if it aborts first (the work never runs), or an
   * AbortError once the budget is disposed or (uploads) it is dropped for
   * UPLOAD_MAX_PENDING. An upload's `size` (bytes, 0 for none) is asked
   * just before its turn, against the frame's UPLOAD_BYTES_PER_FRAME.
   */
  run<T>(work: () => T, signal?: AbortSignal, lane: BudgetLane = 'grid', size?: () => number): Promise<T> {
    if (this.disposed) return Promise.reject(new DOMException('frame budget disposed', 'AbortError'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const queue = this.lanes[lane]
      const job: Job = { work, resolve: resolve as (value: unknown) => void, reject, at: this.clock(), signal, size }
      if (signal) {
        job.onAbort = () => {
          const i = queue.indexOf(job)
          if (i >= 0) queue.splice(i, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      queue.push(job)
      if (lane === 'upload' && queue.length > UPLOAD_MAX_PENDING) {
        const dropped = queue.shift()!
        if (dropped.onAbort) dropped.signal!.removeEventListener('abort', dropped.onAbort)
        this.stats.droppedUploads++
        dropped.reject(new DOMException('frame budget: upload dropped', 'AbortError'))
      }
    })
  }

  /**
   * Runs queued grids and bakes until msPerFrame of them has run (at least
   * one), then uploads while time is left, up to UPLOAD_BYTES_PER_FRAME,
   * unless a recent frame took longer than UPLOAD_MAX_FRAME_MS. Call once per frame.
   */
  tick(): void {
    const { grid, bake, upload } = this.lanes
    const start = this.clock()
    if (Number.isFinite(this.lastTick)) {
      this.frames.push(start - this.lastTick)
      if (this.frames.length > UPLOAD_FRAME_WINDOW) this.frames.shift()
    }
    this.lastTick = start
    const slow = this.frames.some((ms) => ms > UPLOAD_MAX_FRAME_MS)
    let ran = 0
    // a bake that has waited long enough goes first, one a frame
    if (grid.length && bake.length && start - bake[0].at >= BAKE_MAX_WAIT_MS) {
      this.stats.agedBakes++
      this.runJob(bake.shift()!)
      ran++
    }
    while (grid.length || bake.length) {
      if (ran && this.clock() - start >= this.msPerFrame) break
      this.runJob((grid.length ? grid : bake).shift()!)
      ran++
    }
    let bytes = 0
    if (slow && upload.length) this.stats.slowFrames++
    while (!slow && upload.length && this.clock() - start < this.msPerFrame) {
      const size = upload[0].size?.() ?? 0
      // the first upload of a frame goes whatever its size; the rest only within the bytes
      if (bytes > 0 && bytes + size > UPLOAD_BYTES_PER_FRAME) break
      this.runJob(upload.shift()!)
      bytes += size
    }
    this.stats.uploadBytes += bytes
    const ms = this.clock() - start
    if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms
  }

  /** Runs `job`, settling its promise. */
  private runJob(job: Job): void {
    if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort)
    const t0 = this.clock()
    try {
      job.resolve(job.work())
    } catch (error) {
      job.reject(error)
    }
    const ms = this.clock() - t0
    this.stats.jobs++
    this.stats.ms += ms
    if (ms > this.stats.maxJobMs) this.stats.maxJobMs = ms
  }

  /** Rejects everything waiting and every later run. */
  dispose(): void {
    this.disposed = true
    for (const job of [...this.lanes.grid.splice(0), ...this.lanes.bake.splice(0), ...this.lanes.upload.splice(0)]) {
      if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort)
      job.reject(new DOMException('frame budget disposed', 'AbortError'))
    }
  }
}
