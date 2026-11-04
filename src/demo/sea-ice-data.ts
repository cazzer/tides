// The sea ice, fetched once on first use (tides-zec.19): the year of grids
// (sea-ice.ts) and the mask of where the globe's layer draws
// (scripts/build-sea-ice.py). The globe asks for it once the scene has drawn
// a frame and gone idle (tides-6ru.1), so its 850 KB never holds up the
// first paint. A failure warns and leaves the globe without ice, never a
// broken scene.
import { useEffect, useSyncExternalStore } from 'react'
import { gunzip } from '../earth-dem'
import { unpackSeaIce, type SeaIce, type SeaIceMask } from './sea-ice'
import seaIceUrl from '../assets/sea-ice-2025.bin?url'
import seaIceMaskUrl from '../assets/sea-ice-mask.png'

export interface SeaIceData {
  ice: SeaIce
  mask: SeaIceMask
}

async function loadIce(): Promise<SeaIce> {
  const response = await fetch(seaIceUrl)
  if (!response.ok) throw new Error(`${seaIceUrl}: ${response.status}`)
  return unpackSeaIce(await gunzip(new Uint8Array(await response.arrayBuffer())))
}

async function loadMask(): Promise<SeaIceMask> {
  const response = await fetch(seaIceMaskUrl)
  if (!response.ok) throw new Error(`${seaIceMaskUrl}: ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const { width, height } = bitmap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('No 2D canvas for the sea ice mask')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rgba = context.getImageData(0, 0, width, height).data
  const rg = new Uint8Array(width * height * 2)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 2) {
    rg[j] = rgba[i]
    rg[j + 1] = rgba[i + 1]
  }
  return { rg, width, height }
}

let pending: Promise<SeaIceData | null> | null = null
// Once loaded, for every hook at once: a view mounted later starts with the
// ice, not a frame without it.
let loaded: SeaIceData | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getLoaded = () => loaded

/** The sea ice, fetched on the first call; null if it failed to load. */
export function loadSeaIce(): Promise<SeaIceData | null> {
  pending ??= Promise.all([loadIce(), loadMask()]).then(
    ([ice, mask]) => {
      loaded = { ice, mask }
      listeners.forEach((listener) => listener())
      return loaded
    },
    (error: unknown) => {
      console.warn('Sea ice failed to load; the globe goes on without it.', error)
      return null
    }
  )
  return pending
}

// How long an idle moment is waited for after the frame, at most.
const IDLE_TIMEOUT_MS = 2000

/**
 * Runs `callback` after the next frame is drawn, in an idle moment then
 * (or after IDLE_TIMEOUT_MS of none): a timeout where the browser has no
 * idle callbacks (Safari). Returns the cancel.
 */
export function afterFrameWhenIdle(callback: () => void): () => void {
  let cancelIdle = () => {}
  const frame = requestAnimationFrame(() => {
    if (typeof requestIdleCallback === 'function') {
      const idle = requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS })
      cancelIdle = () => cancelIdleCallback(idle)
    } else {
      const timeout = setTimeout(callback, 0)
      cancelIdle = () => clearTimeout(timeout)
    }
  })
  return () => {
    cancelAnimationFrame(frame)
    cancelIdle()
  }
}

/** The sea ice if something has loaded it, without asking for it. */
export function useLoadedSeaIce(): SeaIceData | null {
  return useSyncExternalStore(subscribe, getLoaded, getLoaded)
}

/**
 * The sea ice once loaded while `enabled` (null until then, or if it
 * failed). `deferred` asks for it only after a frame and an idle moment
 * (afterFrameWhenIdle), so it never competes with the scene's first paint.
 */
export function useSeaIce(enabled = true, deferred = false): SeaIceData | null {
  const data = useLoadedSeaIce()
  useEffect(() => {
    if (!enabled || pending) return
    if (!deferred) {
      void loadSeaIce()
      return
    }
    return afterFrameWhenIdle(() => void loadSeaIce())
  }, [enabled, deferred])
  return enabled ? data : null
}
