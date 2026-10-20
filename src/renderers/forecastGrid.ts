// Browser side of the forecast cloud cover (tides-kzj.4.3): fetches the grid
// that ../forecast-clouds.ts asks for and validates, and keeps the response
// (and any failure backoff) in Cache Storage, shared by every tab, so neither
// a reload nor a second tab fetches again within FORECAST_TTL_MS. Tabs take
// turns through a Web Lock. Runs wherever the cloud builds do (the worker, or
// the main thread).
import {
  coverRequestBody,
  createCoverGridSource,
  OPEN_METEO_URL,
  type FetchBackoff,
} from '../forecast-clouds'

const FETCH_TIMEOUT_MS = 30_000
const STORE = 'tides-forecast-v1'
// The Cache API only stores GET requests, so the POST's response is kept
// under a fixed URL of its own.
const STORE_KEY = 'https://tides.invalid/open-meteo/cloud-cover-10deg'
const BACKOFF_KEY = 'https://tides.invalid/open-meteo/backoff'
const FETCHED_AT = 'x-fetched-at'
const LOCK = 'tides-forecast'

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

async function readBackoff(): Promise<FetchBackoff | null> {
  const res = await (await openStore())?.match(BACKOFF_KEY)
  if (!res) return null
  const json: unknown = await res.json()
  if (typeof json !== 'object' || json === null) return null
  const { failures, retryAt } = json as Record<string, unknown>
  return typeof failures === 'number' && typeof retryAt === 'number' ? { failures, retryAt } : null
}

async function writeBackoff(backoff: FetchBackoff | null): Promise<void> {
  const store = await openStore()
  if (!backoff) await store?.delete(BACKOFF_KEY)
  else await store?.put(BACKOFF_KEY, new Response(JSON.stringify(backoff)))
}

/** Web Locks where there are any (workers included); otherwise each tab on
 * its own. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  return locks ? (locks.request(LOCK, fn) as Promise<T>) : fn()
}

export const coverGrids = createCoverGridSource({
  fetchJson,
  readStored,
  writeStored,
  readBackoff,
  writeBackoff,
  exclusive,
  now: () => Date.now(),
})
