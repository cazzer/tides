// The colour feature's own fetches (tides-zmw.9.11: the coarse reference's
// EOX tiles, tile-colour-ref.ts, and the USGS match's cells,
// imagery-match.ts) beside the tiles' own: a small limit on how many are in
// flight, so they never crowd the tiles' downloads, and a backoff for keys
// that failed (a 429, a 503, the network), so a dead tile isn't asked for
// on every request for the rest of the flight.

/** Side fetches in flight at once. */
export const SIDE_FETCH_CONCURRENCY = 4

/** A queue that runs at most `limit` jobs at once, in the order they came. */
export function createLimiter(limit: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  const next = () => {
    if (running >= limit) return
    const start = waiting.shift()
    if (start) start()
  }
  return <T,>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        running++
        job()
          .then(resolve, reject)
          .finally(() => {
            running--
            next()
          })
      })
      next()
    })
}

/** The page's limiter for the colour feature's side fetches. */
export const sideFetch = createLimiter(SIDE_FETCH_CONCURRENCY)

/** The first wait after a failure, and the longest (doubling between). */
export const SIDE_BACKOFF_FIRST_MS = 10_000
export const SIDE_BACKOFF_MAX_MS = 300_000

/**
 * When a failed key may be asked for again: SIDE_BACKOFF_FIRST_MS after its
 * first failure, twice as long after each next one, up to the max; a
 * success forgets it.
 */
export class KeyedBackoff {
  private entries = new Map<string, { n: number; nextAt: number }>()
  constructor(
    readonly firstMs = SIDE_BACKOFF_FIRST_MS,
    readonly maxMs = SIDE_BACKOFF_MAX_MS
  ) {}

  /** Whether `key` may be fetched at `now` (ms). */
  due(key: string, now: number): boolean {
    const entry = this.entries.get(key)
    return !entry || now >= entry.nextAt
  }

  /** When `key` may next be fetched (0: now). */
  nextAt(key: string): number {
    return this.entries.get(key)?.nextAt ?? 0
  }

  failed(key: string, now: number): void {
    const n = (this.entries.get(key)?.n ?? 0) + 1
    this.entries.set(key, { n, nextAt: now + Math.min(this.firstMs * 2 ** (n - 1), this.maxMs) })
  }

  succeeded(key: string): void {
    this.entries.delete(key)
  }
}

/** `promise`'s value, or `undefined` once `ms` have passed first. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
