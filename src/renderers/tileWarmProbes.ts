// The streamed tiles' flight programs as warm-up probes (tides-tvr.7.7,
// surface/tileProbe.ts), for EarthRenderer to list with the ground's. The
// probes need the tiles' composer and the library's tile material, which
// live in the lazy surface chunk: it is imported the first time the
// warm-ups ask (at idle, after Earth has drawn), and the probes are built
// then, on the flight state's link, again whenever the link changes.
import { useEffect, useRef } from 'react'
import type { WarmProbe } from '../ship/ship-warmup'
import type { GlobeLink } from './surface/surface-link'

type TileProbeModule = typeof import('./surface/tileProbe')

/**
 * The tiles' probes on `link` (null: none), as a function for the warm-ups
 * to call. Empty until the chunk has loaded; `onLoaded` runs when it has,
 * for the owner to have itself looked at again.
 */
export function useTileWarmProbes(link: GlobeLink | null, onLoaded: () => void): () => WarmProbe[] {
  const probeModule = useRef<TileProbeModule | null>(null)
  const loading = useRef(false)
  const made = useRef<{ link: GlobeLink; probes: ReturnType<TileProbeModule['createTileProbes']> } | null>(null)
  const loaded = useRef(onLoaded)
  useEffect(() => {
    loaded.current = onLoaded
  })
  // Made on demand, so a replayed effect (StrictMode) only frees them.
  useEffect(
    () => () => {
      made.current?.probes.dispose()
      made.current = null
    },
    [link]
  )
  return () => {
    if (!link) return []
    if (!probeModule.current) {
      if (!loading.current) {
        loading.current = true
        import('./surface/tileProbe').then(
          (loadedModule) => {
            probeModule.current = loadedModule
            loaded.current()
          },
          (error: unknown) => console.warn('tile warm-up: the surface chunk failed to load; the tiles link at first draw', error)
        )
      }
      return []
    }
    if (made.current?.link !== link) {
      made.current?.probes.dispose()
      made.current = { link, probes: probeModule.current.createTileProbes(link) }
    }
    return made.current.probes.probes
  }
}
