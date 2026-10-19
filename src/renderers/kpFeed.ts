// Browser side of the aurora's Kp feed (tides-qe5): fetches the files that
// ../aurora-kp.ts picks and parses. One feed is shared by every View.
import {
  CELESTRAK_ALL_URL,
  CELESTRAK_RECENT_URL,
  createKpFeed,
  parseCelestrakKp,
  parseSwpcKp,
  SWPC_KP_URL,
  type KpSeries,
  type KpSourceKind,
} from '../aurora-kp'

const FETCH_TIMEOUT_MS = 30_000

const URLS: Record<KpSourceKind, string> = {
  swpc: SWPC_KP_URL,
  'celestrak-recent': CELESTRAK_RECENT_URL,
  'celestrak-all': CELESTRAK_ALL_URL,
}

async function loadKp(kind: KpSourceKind): Promise<KpSeries> {
  const res = await fetch(URLS[kind], { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${URLS[kind]}`)
  return kind === 'swpc' ? parseSwpcKp(await res.json()) : parseCelestrakKp(await res.text())
}

export const kpFeed = createKpFeed({ load: loadKp })
