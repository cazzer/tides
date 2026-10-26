// Retrying a tile download through a transient failure (tides-zmw.9.2): a
// network error, 429 or 5xx. Without it one dropped request for a z4 terrain
// tile failed ~2500 km of ground for the rest of the flight (seen once in a
// headless descent), and one imagery blip painted a land tile in the ocean
// fallback colour for as long as it stayed cached.

/** Waits before each retry, ms. */
export const RETRY_DELAYS_MS = [1000, 4000]

export const isTransientStatus = (status: number) => status === 429 || status >= 500

/** Resolves after `ms`, or rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const isAbort = (error: unknown) => (error as Error)?.name === 'AbortError'

/**
 * Calls `attempt` until it answers a non-transient status or the retries run
 * out (the last answer or error stands). A transient answer's body is
 * cancelled; an abort ends it at once.
 */
export async function fetchWithRetry(
  attempt: () => Promise<Response>,
  signal?: AbortSignal | null,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<Response> {
  for (let i = 0; ; i++) {
    const last = i >= delays.length
    try {
      const res = await attempt()
      if (last || !isTransientStatus(res.status)) return res
      res.body?.cancel().catch(() => {})
    } catch (error) {
      if (last || signal?.aborted || isAbort(error)) throw error
    }
    await sleep(delays[i], signal)
  }
}

/**
 * A signal that aborts when either does, and a release that drops the
 * listeners a fallback (no AbortSignal.any: Safari before 17.4) leaves on
 * the long-lived one.
 */
export function eitherSignal(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release: () => void } {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return { signal: any.call(AbortSignal, [a, b]), release: () => {} }
  const controller = new AbortController()
  const fromA = () => controller.abort(a.reason)
  const fromB = () => controller.abort(b.reason)
  const release = () => {
    a.removeEventListener('abort', fromA)
    b.removeEventListener('abort', fromB)
  }
  if (a.aborted) fromA()
  else if (b.aborted) fromB()
  else {
    a.addEventListener('abort', fromA, { once: true })
    b.addEventListener('abort', fromB, { once: true })
  }
  return { signal: controller.signal, release }
}
