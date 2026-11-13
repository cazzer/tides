// The lightning renderer's one feed (tides-ufyr.13), shared by every View:
// real GOES GLM flashes, listed here and downloaded and parsed in
// ./glm.worker.ts. The seam simulated lightning (tides-ufyr.14) plugs into:
// the renderer sees only a LightningFeed.
import { createGlmFeed } from '../glm-feed'
import { glmListUrl, glmObjectUrl, parseGlmListing } from '../glm'
import type { LightningFeed } from '../lightning'
import { createGlmLoader, type GlmWorker } from './glmWorkerClient'
import { eitherSignal } from './surface/fetch-retry'

const FETCH_TIMEOUT_MS = 30_000

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

export const lightningFeed: LightningFeed = createGlmFeed({
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
