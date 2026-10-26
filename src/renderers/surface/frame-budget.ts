// A per-frame allowance for the main-thread end of a terrain tile
// (tides-zmw.9.2): wrapping a decoded grid in a texture, stitching its edges
// into the loaded neighbours and uploading it. Each step is a few ms; a fast
// descent finishes dozens of tiles at once, which in one frame was the
// 870 ms stall the spike measured. Work waits here and SurfaceTiles' frame
// loop lets `perFrame` of it through each frame. Not budgeted: stitching
// marks up to eight loaded neighbours dirty, and three re-uploads each (1 MB)
// at its next draw.

/** Grids finished per frame: two keep a burst's own uploads to a few ms a frame. */
export const GRIDS_PER_FRAME = 2

interface Waiter {
  resolve: () => void
  reject: (err: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class FrameBudget {
  private readonly queue: Waiter[] = []
  private disposed = false

  constructor(readonly perFrame = GRIDS_PER_FRAME) {}

  /** How many are waiting for a turn. */
  get pending(): number {
    return this.queue.length
  }

  /**
   * Resolves on a later tick, in arrival order, once a turn is free; rejects
   * with the signal's reason if it aborts first, or an AbortError once the
   * budget is disposed. Do the budgeted work synchronously on resolve.
   */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new DOMException('frame budget disposed', 'AbortError'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter)
          if (i >= 0) this.queue.splice(i, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  /** Lets the next `perFrame` waiters through. Call once per frame. */
  tick(): void {
    for (const waiter of this.queue.splice(0, this.perFrame)) {
      if (waiter.onAbort) waiter.signal!.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
  }

  /** Rejects everything waiting and every later wait. */
  dispose(): void {
    this.disposed = true
    for (const waiter of this.queue.splice(0)) {
      if (waiter.onAbort) waiter.signal!.removeEventListener('abort', waiter.onAbort)
      waiter.reject(new DOMException('frame budget disposed', 'AbortError'))
    }
  }
}
