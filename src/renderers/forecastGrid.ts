// Browser side of the forecast cloud cover (tides-kzj.4.3): fetches the grid
// that ../forecast-clouds.ts asks for and validates, and keeps the response in
// Cache Storage so a reload within FORECAST_TTL_MS doesn't fetch again. Runs
// wherever the cloud builds do (the worker, or the main thread).
import {
  coverRequestBody,
  createCoverGridSource,
  OPEN_METEO_URL,
} from '../forecast-clouds'

const FETCH_TIMEOUT_MS = 30_000
const STORE = 'tides-forecast-v1'
// The Cache API only stores GET requests, so the POST's response is kept
// under a fixed URL of its own.
const STORE_KEY = 'https://tides.invalid/open-meteo/cloud-cover-10deg'
const FETCHED_AT = 'x-fetched-at'

async function fetchJson(): Promise<unknown> {
  // Form-encoded, so no CORS preflight; the 648 coordinates are too long for
  // a URL.
  const res = await fetch(OPEN_METEO_URL, {
    method: 'POST',
    body: coverRequestBody(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  return res.json()
}

/** Null where Cache Storage isn't available (insecure origins, some private
 * modes); the grid then lives in memory only. */
async function openStore(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(STORE)
  } catch {
    return null
  }
}

async function readStored(): Promise<{ fetchedAt: number; body: unknown } | null> {
  const store = await openStore()
  const res = await store?.match(STORE_KEY)
  if (!res) return null
  return { fetchedAt: Number(res.headers.get(FETCHED_AT)), body: await res.json() }
}

async function writeStored(fetchedAt: number, body: unknown): Promise<void> {
  const store = await openStore()
  await store?.put(
    STORE_KEY,
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', [FETCHED_AT]: String(fetchedAt) },
    })
  )
}

export const coverGrids = createCoverGridSource({
  fetchJson,
  readStored,
  writeStored,
  now: () => Date.now(),
})
