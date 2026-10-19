// Browser side of the real-weather cloud layer (tides-l3s): fetches the GIBS
// tiles and turns them into a cloud alphaMap for the shared controller. The
// maths is in ../real-clouds.ts, the state machine in ./realCloudController.ts.
import { useEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import {
  COLS,
  composeCloudAlpha,
  iceWeight,
  isRetryable,
  OUT_H,
  OUT_W,
  TILE,
  TILE_TIMEOUT_MS,
  tileUrls,
} from '../real-clouds'
import {
  createRealCloudController,
  type CloudSnapshot,
  type GibsSource,
} from './realCloudController'
import earthSpecular from '../assets/earth-specular-2k.jpg'
import earthDay from '../assets/earth-day-2k.jpg'

function canvas2d(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas unavailable')
  return { canvas, ctx }
}

/** Pixels of an image scaled to the output size. */
function pixelsOf(image: ImageBitmap): Uint8ClampedArray {
  try {
    const { canvas, ctx } = canvas2d(OUT_W, OUT_H)
    ctx.drawImage(image, 0, 0, OUT_W, OUT_H)
    const data = ctx.getImageData(0, 0, OUT_W, OUT_H).data
    canvas.width = 0
    return data
  } finally {
    image.close()
  }
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return createImageBitmap(await res.blob())
}

type TileFailure = number | 'timeout' | 'network'

/** AbortSignal.any where available (Safari before 17.4 lacks it). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

async function fetchTileOnce(
  url: string,
  signal: AbortSignal
): Promise<ImageBitmap | TileFailure> {
  try {
    const res = await fetch(url, {
      signal: anySignal([AbortSignal.timeout(TILE_TIMEOUT_MS), signal]),
    })
    if (!res.ok) return res.status
    return await createImageBitmap(await res.blob())
  } catch (err) {
    if (signal.aborted) throw err
    return err instanceof DOMException && err.name === 'TimeoutError'
      ? 'timeout'
      : 'network'
  }
}

/** One retry for transient failures; null when the tile can't be had, so its
 * area keeps the static clouds. Throws only when the build is aborted. */
async function loadTile(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  let result = await fetchTileOnce(url, signal)
  if (!(result instanceof ImageBitmap) && isRetryable(result)) {
    result = await fetchTileOnce(url, signal)
  }
  if (result instanceof ImageBitmap) return result
  console.warn(`[clouds] dropped GIBS tile (${result}): ${url}`)
  return null
}

// Built once and kept: both are 1 byte per output pixel (~3.3 MB each).
let iceMask: Promise<Uint8Array> | null = null
const staticAlphas = new Map<string, Promise<Uint8Array>>()

function memo<T>(make: () => Promise<T>, store: (p: Promise<T> | null) => void) {
  const promise = make()
  store(promise)
  // A failed load is retried by the next build rather than cached.
  promise.catch(() => store(null))
  return promise
}

function getIceMask(): Promise<Uint8Array> {
  return (
    iceMask ??
    memo(
      async () => {
        const [spec, day] = await Promise.all([
          fetchBitmap(earthSpecular).then(pixelsOf),
          fetchBitmap(earthDay).then(pixelsOf),
        ])
        const mask = new Uint8Array(OUT_W * OUT_H)
        for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
          mask[p] = 255 * iceWeight(spec[i + 1], day[i], day[i + 1], day[i + 2])
        }
        return mask
      },
      (p) => (iceMask = p)
    )
  )
}

/** The static texture's green channel, which the cloud material uses as alpha. */
function getStaticAlpha(url: string): Promise<Uint8Array> {
  return (
    staticAlphas.get(url) ??
    memo(
      async () => {
        const rgba = pixelsOf(await fetchBitmap(url))
        const alpha = new Uint8Array(OUT_W * OUT_H)
        for (let p = 0; p < alpha.length; p++) alpha[p] = rgba[p * 4 + 1]
        return alpha
      },
      (p) => (p ? staticAlphas.set(url, p) : staticAlphas.delete(url))
    )
  )
}

/** Null when every tile failed. Throws when aborted. */
async function buildCloudTexture(
  source: GibsSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.CanvasTexture | null> {
  // Lets a failed mask stop this build's tile downloads too.
  const local = new AbortController()
  const tileSignal = anySignal([signal, local.signal])
  const settled = Promise.allSettled(
    tileUrls(source.layer, source.date).map((url) => loadTile(url, tileSignal))
  )
  try {
    const [staticAlpha, ice] = await Promise.all([
      getStaticAlpha(staticUrl),
      getIceMask(),
    ]).catch((err: unknown) => {
      local.abort()
      throw err
    })
    const tiles = (await settled).map((r) => (r.status === 'fulfilled' ? r.value : null))
    signal.throwIfAborted()
    if (tiles.every((t) => t === null)) return null

    // Missing tiles stay transparent black, which composeCloudAlpha reads as no data.
    const { canvas, ctx } = canvas2d(OUT_W, OUT_H)
    tiles.forEach((tile, i) => {
      if (tile) ctx.drawImage(tile, (i % COLS) * TILE, Math.floor(i / COLS) * TILE)
    })
    const image = ctx.getImageData(0, 0, OUT_W, OUT_H)
    composeCloudAlpha(image.data, staticAlpha, ice, image.data)
    ctx.putImageData(image, 0, 0)

    const texture = new THREE.CanvasTexture(canvas)
    // alphaMap is data, not colour.
    texture.colorSpace = THREE.NoColorSpace
    return texture
  } finally {
    for (const r of await settled) {
      if (r.status === 'fulfilled') r.value?.close()
    }
  }
}

export type RealCloudSnapshot = CloudSnapshot<THREE.CanvasTexture>

export const realClouds = createRealCloudController<THREE.CanvasTexture>({
  build: buildCloudTexture,
  dispose: (texture) => texture.dispose(),
})

export function useRealCloudSnapshot(): RealCloudSnapshot {
  return useSyncExternalStore(realClouds.subscribe, realClouds.getSnapshot)
}

/** The shared snapshot; stops fetching when `active` turns false. */
export function useRealClouds(active: boolean): RealCloudSnapshot {
  useEffect(() => {
    if (!active) realClouds.deactivate()
  }, [active])
  return useRealCloudSnapshot()
}
