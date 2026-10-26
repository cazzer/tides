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
// shuts them out).

/** Main-thread ms of budgeted work run per frame (a frame always runs at least one job). */
export const FRAME_BUDGET_MS = 4

/** How long a bake waits behind grids before one a frame goes through regardless, ms. */
export const BAKE_MAX_WAIT_MS = 500

/** A grid's end (its tile draws once it's done) or a horizon bake's copying (it only sharpens). */
export type BudgetLane = 'grid' | 'bake'

interface Job {
  work: () => unknown
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  /** When it queued (the clock's ms). */
  at: number
  signal?: AbortSignal
  onAbort?: () => void
}

/** The budget's running totals (for the counters and the harnesses). */
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
}

export class FrameBudget {
  private readonly lanes: Record<BudgetLane, Job[]> = { grid: [], bake: [] }
  private disposed = false
  readonly stats: FrameBudgetStats = { jobs: 0, ms: 0, maxTickMs: 0, maxJobMs: 0, agedBakes: 0 }

  constructor(
    readonly msPerFrame = FRAME_BUDGET_MS,
    private readonly clock: () => number = () => performance.now()
  ) {}

  /** How many are waiting for a turn. */
  get pending(): number {
    return this.lanes.grid.length + this.lanes.bake.length
  }

  /**
   * Runs `work` synchronously in a later tick, once its turn comes (grids
   * before bakes, each lane in arrival order), and resolves with what it
   * returns (rejects with what it throws). Rejects with the signal's reason
   * if it aborts first (the work never runs), or an AbortError once the
   * budget is disposed.
   */
  run<T>(work: () => T, signal?: AbortSignal, lane: BudgetLane = 'grid'): Promise<T> {
    if (this.disposed) return Promise.reject(new DOMException('frame budget disposed', 'AbortError'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const queue = this.lanes[lane]
      const job: Job = { work, resolve: resolve as (value: unknown) => void, reject, at: this.clock(), signal }
      if (signal) {
        job.onAbort = () => {
          const i = queue.indexOf(job)
          if (i >= 0) queue.splice(i, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      queue.push(job)
    })
  }

  /** Runs queued jobs until msPerFrame of them has run (at least one). Call once per frame. */
  tick(): void {
    const { grid, bake } = this.lanes
    const start = this.clock()
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
    const ms = this.clock() - start
    if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms
  }

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
    for (const job of [...this.lanes.grid.splice(0), ...this.lanes.bake.splice(0)]) {
      if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort)
      job.reject(new DOMException('frame budget disposed', 'AbortError'))
    }
  }
}
