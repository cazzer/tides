// Browser side of the live wave directions (tides-nh8.4): fetches the grid
// that ../forecast-waves.ts asks for and validates, and keeps the response
// (and any failure backoff) in Cache Storage, shared by every tab, so neither
// a reload nor a second tab fetches again within LIVE_WAVES_TTL_MS. Tabs take
// turns through a Web Lock. As ./forecastGrid.ts does the clouds' cover.
import { createWaveGridSource, MARINE_URL, waveRequestBodies, type WaveBackoff } from '../forecast-waves'

const FETCH_TIMEOUT_MS = 30_000
const STORE = 'tides-forecast-v1'
// The Cache API only stores GET requests, so the POST's response is kept
// under a fixed URL of its own.
const STORE_KEY = 'https://tides.invalid/open-meteo/marine-current-7.5deg'
const BACKOFF_KEY = 'https://tides.invalid/open-meteo/marine-backoff'
const FETCHED_AT = 'x-fetched-at'
const LOCK = 'tides-live-waves'

/** Every request's answer, in turn, concatenated. */
async function fetchJson(): Promise<unknown> {
  const all: unknown[] = []
  for (const body of waveRequestBodies()) {
    // Form-encoded, so no CORS preflight; the coordinates are too long for a URL.
    const res = await fetch(MARINE_URL, { method: 'POST', body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Open-Meteo Marine HTTP ${res.status}`)
    const json: unknown = await res.json()
    all.push(...(Array.isArray(json) ? json : [json]))
  }
  return all
}

/** Null where Cache Storage isn't available; the grid then lives in memory. */
async function openStore(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(STORE)
  } catch {
    return null
  }
}

async function readStored(): Promise<{ fetchedAt: number; body: unknown } | null> {
  const res = await (await openStore())?.match(STORE_KEY)
  if (!res) return null
  return { fetchedAt: Number(res.headers.get(FETCHED_AT)), body: await res.json() }
}

async function writeStored(fetchedAt: number, body: unknown): Promise<void> {
  await (await openStore())?.put(
    STORE_KEY,
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json', [FETCHED_AT]: String(fetchedAt) },
    })
  )
}

async function readBackoff(): Promise<WaveBackoff | null> {
  const res = await (await openStore())?.match(BACKOFF_KEY)
  if (!res) return null
  const json: unknown = await res.json()
  if (typeof json !== 'object' || json === null) return null
  const { failures, retryAt } = json as Record<string, unknown>
  return typeof failures === 'number' && typeof retryAt === 'number' ? { failures, retryAt } : null
}

async function writeBackoff(backoff: WaveBackoff | null): Promise<void> {
  const store = await openStore()
  if (!backoff) await store?.delete(BACKOFF_KEY)
  else await store?.put(BACKOFF_KEY, new Response(JSON.stringify(backoff)))
}

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  return locks ? (locks.request(LOCK, fn) as Promise<T>) : fn()
}

export const liveWaveGrids = createWaveGridSource({
  fetchJson,
  readStored,
  writeStored,
  readBackoff,
  writeBackoff,
  exclusive,
  now: () => Date.now(),
})
