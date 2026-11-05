// The pure parts of the first load's shader warm-up (CompileGate.tsx,
// tides-0oi.6): its timeout, its per-frame budget, and when it may finish.

/**
 * [TUNE] How long the first load waits on shader compiles before showing
 * the scene anyway, ms: a driver that never reports a program ready, or a
 * loader that never goes idle, must not hold the loading screen up.
 */
export const COMPILE_TIMEOUT_MS = 10000

/**
 * [TUNE] The main thread's share of a frame given to first uses and
 * uploads while the loading screen is up, ms: on ANGLE-Metal a program
 * linked in the background still takes 2-9 ms at its first use.
 */
export const WARM_BUDGET_MS = 8

/** Whether `promise` settles within `ms`; a rejection passes through. */
export function withTimeout(promise: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  const done = promise.then(() => 'done' as const)
  return Promise.race([done, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Runs `queue`'s items through `fn` until `budgetMs` (by `now`) is spent,
 * always at least one, and returns the ones left.
 */
export function drainWithin<T>(queue: readonly T[], budgetMs: number, now: () => number, fn: (item: T) => void): T[] {
  const start = now()
  let i = 0
  while (i < queue.length) {
    fn(queue[i++])
    if (now() - start >= budgetMs) break
  }
  return queue.slice(i)
}

/** The loading manager's state, as drei's useProgress holds it. */
export interface LoadProgress {
  active: boolean
  loaded: number
  total: number
}

/** Whether every asset the loading manager was asked for has loaded. */
export function assetsLoaded({ active, loaded, total }: LoadProgress): boolean {
  return total > 0 && loaded >= total && !active
}

/** Whether every one of the `shown` views has reported ready. */
export function allShownReady(shown: readonly string[], ready: ReadonlySet<string>): boolean {
  return shown.length > 0 && shown.every((key) => ready.has(key))
}
