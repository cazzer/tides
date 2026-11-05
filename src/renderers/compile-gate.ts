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

/**
 * [TUNE] The longest the first load holds a scene back from its mount, ms,
 * whatever it waits on (assets, compiles, the Sun's bake): then it shows.
 */
export const GATE_DEADLINE_MS = 20000

/**
 * Whether a shown scene is ready (CompileGate's onReady): drawn twice, with
 * nothing it waits for pending, or past the deadline whatever is.
 */
export function readyNow({ drawn, pending, late }: { drawn: number; pending: boolean; late: boolean }): boolean {
  return drawn >= 2 && (late || !pending)
}

/**
 * A gate's phase across an unmount (a suspend, or StrictMode's replay): a
 * round compiling is dropped and run again; a ready scene is unready
 * (`unready`) and readied again once drawn twice more.
 */
export function phaseAfterUnmount<P extends string>(phase: P | 'compiling' | 'compile' | 'ready' | 'shown'): {
  phase: P | 'compile' | 'shown'
  unready: boolean
} {
  if (phase === 'compiling') return { phase: 'compile', unready: false }
  if (phase === 'ready') return { phase: 'shown', unready: true }
  return { phase: phase as P | 'compile' | 'shown', unready: false }
}

/** What a compile round leads to. */
export interface RoundOutcome {
  next: 'compile' | 'warm' | 'reveal'
  /** Quiet rounds in a row so far. */
  quiet: number
}

/**
 * After a compile round: another round, unless `quietRounds` in a row have
 * found nothing new (`added`) with every asset in (`loaded`); then the warm.
 * A round that timed out shows the scene as it is.
 */
export function afterRound(
  { outcome, added, loaded, quiet }: { outcome: 'done' | 'timeout'; added: boolean; loaded: boolean; quiet: number },
  quietRounds: number
): RoundOutcome {
  if (outcome === 'timeout') return { next: 'reveal', quiet }
  const now = added || !loaded ? 0 : quiet + 1
  return { next: now >= quietRounds ? 'warm' : 'compile', quiet: now }
}

/**
 * Whether an object's materials are compiled ahead of their draw
 * (CompileGate): not when one waits for something that changes its program
 * on arrival (userData.compileLater, a moon's map that adds USE_PLANET_MAP,
 * tides-0oi.25). That one would build a program its draw never uses; its draw
 * compiles the one it needs.
 */
export function compilesAhead(materials: readonly { userData: Record<string, unknown> }[]): boolean {
  return !materials.some((material) => material.userData.compileLater === true)
}
