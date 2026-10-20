// Browser side of the aurora's OVATION nowcast (tides-kzj.5.3): fetches,
// parses and fits the file ../aurora-ovation.ts describes. One feed is shared
// by every View.
import { createOvationFeed, fitOvation, OVATION_URL, parseOvation } from '../aurora-ovation'

const FETCH_TIMEOUT_MS = 30_000

export const ovationFeed = createOvationFeed({
  load: async () => {
    const res = await fetch(OVATION_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${OVATION_URL}`)
    return fitOvation(parseOvation(await res.json()))
  },
})
