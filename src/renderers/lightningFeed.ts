// The lightning renderer's one feed (tides-ufyr.13), shared by every View:
// real GOES GLM flashes, listed here and downloaded and parsed in
// ./glm.worker.ts, and, for the times GLM has no file for, simulated ones
// (../lightning-sim-feed.ts, tides-ufyr.14) under the real-weather clouds.
// The renderer sees only a LightningFeed.
import type { Texture } from 'three'
import { createGlmFeed, glmCovers } from '../glm-feed'
import { glmListUrl, glmObjectUrl, parseGlmListing } from '../glm'
import type { LightningFeed } from '../lightning'
import { ClimatologyUnusable, decodeLightningClimatology } from '../lightning-climatology'
import type { SimFrame } from '../lightning-sim'
import { createSimulatedFeed, mergeFeeds } from '../lightning-sim-feed'
import { pickBlend } from '../cloud-frames'
import { coverBytesOf, precipBytesOf } from './cloudBlend'
import { createGlmLoader, type GlmWorker } from './glmWorkerClient'
import { realClouds } from './realCloudTextures'
import { eitherSignal } from './surface/fetch-retry'

const FETCH_TIMEOUT_MS = 30_000

/**
 * The climatology asset (tides-ufyr.14.1, scripts/build-lightning-climatology.py),
 * bundled by Vite and fetched on first need. A missing file (404) or bytes of
 * the wrong length (decodeLightningClimatology rejects them) make the feed
 * warn once and simulate nothing; a network error or timeout backs off.
 */
const CLIMATOLOGY_URL = new URL('../assets/earth-lightning.bin', import.meta.url)

const loadBatch = createGlmLoader({
  createWorker: () =>
    typeof Worker === 'function'
      ? (new Worker(new URL('./glm.worker.ts', import.meta.url), {
          type: 'module',
          name: 'glm',
        }) as unknown as GlmWorker)
      : null,
  inThread: async (request, signal) => (await import('./glmFile')).loadGlmBatch(request, signal),
})

const glmFeed = createGlmFeed({
  list: async (sat, hourMs, startAfter, signal) => {
    const url = glmListUrl(sat, hourMs, startAfter)
    const { signal: either, release } = eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS))
    try {
      const res = await fetch(url, { signal: either })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return parseGlmListing(await res.text())
    } finally {
      release()
    }
  },
  load: (sat, key, windowStartMs, signal) => loadBatch({ url: glmObjectUrl(sat, key), key, windowStartMs }, signal),
})

async function loadClimatology(signal: AbortSignal) {
  const url = CLIMATOLOGY_URL.href
  const { signal: either, release } = eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS))
  try {
    const res = await fetch(url, { signal: either })
    if (res.status === 404) throw new ClimatologyUnusable(`HTTP 404 for ${url}`)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return decodeLightningClimatology(new Uint8Array(await res.arrayBuffer()))
  } finally {
    release()
  }
}

/** Each frame's texture as the simulation reads it, with an id of its own,
 * while the texture lives. */
const simFrames = new WeakMap<Texture, SimFrame>()
let lastFrameId = 0

function simFrame(texture: Texture | 'static'): SimFrame | null {
  if (texture === 'static') return null
  let frame = simFrames.get(texture)
  if (!frame) {
    frame = { id: ++lastFrameId, cover: coverBytesOf(texture), precip: precipBytesOf(texture) }
    simFrames.set(texture, frame)
  }
  return frame
}

const simFeed = createSimulatedFeed({
  loadClimatology,
  clouds: (tMs, out) => {
    const pick = pickBlend(realClouds.getSnapshot().frames, tMs)
    if (!pick) return false
    out.a = simFrame(pick.a)
    out.b = simFrame(pick.b)
    out.mix = pick.mix
    return true
  },
  covers: glmCovers,
})

export const lightningFeed: LightningFeed = mergeFeeds(glmFeed, simFeed)
