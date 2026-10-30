// Which cover grid a geostationary or daily build types its frame from
// (tides-tvr.4.1), apart from the build so it can be tested without one. The
// build asks for whatever grid is to hand (peek: memory or storage, never the
// network) alongside its tiles and types the frame from it once they're done.
// A frame built with no grid to hand stays untyped for good (it's cached by
// key), while later frames come typed once the background fetch lands:
// typed and untyped neighbours are blended side by side, which the look
// (tides-tvr.4.2) has to take in its stride. Forecast frames already wait for
// the grid for their cover, and type from that (./cloudPipeline.ts).
import { COVER_PAST_DAYS, FORECAST_STALE_MAX_MS, type CoverGrid } from '../forecast-clouds'
import { DAY_MS, utcDay } from '../real-clouds'

/** A ceiling on the wait for the grid once the tiles are done. peek only
 * reads storage, which is quick; this is for storage that hangs. */
export const TYPE_GRID_WAIT_MS = 1_000

export interface TypeGridDeps {
  peek: (fromMs: number, toMs: number) => Promise<CoverGrid | null>
  now: () => number
}

/**
 * The grid for a frame showing fromMs..toMs, or null: never rejects, and
 * doesn't look for frames older than any grid still served can reach (one
 * fetched FORECAST_STALE_MAX_MS ago starts COVER_PAST_DAYS before its day).
 */
export function typeGridLoad(deps: TypeGridDeps, fromMs: number, toMs: number): Promise<CoverGrid | null> {
  if (fromMs < utcDay(deps.now() - FORECAST_STALE_MAX_MS) - COVER_PAST_DAYS * DAY_MS) {
    return Promise.resolve(null)
  }
  return deps.peek(fromMs, toMs).catch((err: unknown) => {
    console.warn('[clouds] no cloud cover grid for the cloud types', err)
    return null
  })
}

/** The grid from a typeGridLoad, waiting at most TYPE_GRID_WAIT_MS (then
 * null), for the type and precipitation grids (../cloud-types.ts,
 * ../cloud-precip.ts) to come from one wait. Rejects with the signal's reason
 * when aborted. */
export async function gridWithin(load: Promise<CoverGrid | null>, signal: AbortSignal): Promise<CoverGrid | null> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TYPE_GRID_WAIT_MS)
  })
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([load, late, aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort!)
  }
}
