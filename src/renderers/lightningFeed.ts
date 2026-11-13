// The lightning renderer's one feed (tides-ufyr.13), shared by every View:
// real GOES GLM flashes, listed here and downloaded and parsed in
// ./glm.worker.ts, and, for the times GLM has no file for, simulated ones
// (../lightning-sim-feed.ts, tides-ufyr.14) under the real-weather clouds.
// The renderer sees only a LightningFeed.
import type { Texture } from 'three'
import { createGlmFeed, glmCovers } from '../glm-feed'
import { glmListUrl, glmObjectUrl, parseGlmListing } from '../glm'
import type { LightningFeed } from '../lightning'
import { decodeLightningClimatology } from '../lightning-climatology'
import type { SimClouds, SimFrame } from '../lightning-sim'
import { createSimulatedFeed, mergeFeeds } from '../lightning-sim-feed'
import { pickBlend } from '../cloud-frames'
import { coverBytesOf, precipBytesOf } from './cloudBlend'
import { createGlmLoader, type GlmWorker } from './glmWorkerClient'
import { realClouds } from './realCloudTextures'
import { eitherSignal } from './surface/fetch-retry'

const FETCH_TIMEOUT_MS = 30_000

/**
 * The climatology asset (tides-ufyr.14.1), fetched on first need. Until it
 * exists the fetch 404s (Vite leaves a missing file's URL to resolve at
 * runtime, with a build warning) or gets the dev server's HTML, which
 * decodeLightningClimatology rejects for its length: either way the feed
 * backs off and simulates nothing. Dropping the file in at this path is all
 * it takes: Vite then bundles it.
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
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return decodeLightningClimatology(new Uint8Array(await res.arrayBuffer()))
  } finally {
    release()
  }
}

/** Each frame's texture as the simulation reads it, the same object while the texture lives. */
const simFrames = new WeakMap<Texture, SimFrame>()

function simFrame(texture: Texture | 'static'): SimFrame | null {
  if (texture === 'static') return null
  let frame = simFrames.get(texture)
  if (!frame) {
    frame = { cover: coverBytesOf(texture), precip: precipBytesOf(texture) }
    simFrames.set(texture, frame)
  }
  return frame
}

/** clouds()'s answer, reused (the feed copies what it keeps). */
const shown: SimClouds = { a: null, b: null, mix: 0 }

const simFeed = createSimulatedFeed({
  loadClimatology,
  clouds: (tMs) => {
    const pick = pickBlend(realClouds.getSnapshot().frames, tMs)
    if (!pick) return null
    shown.a = simFrame(pick.a)
    shown.b = simFrame(pick.b)
    shown.mix = pick.mix
    return shown
  },
  covers: glmCovers,
})

export const lightningFeed: LightningFeed = mergeFeeds(glmFeed, simFeed)
