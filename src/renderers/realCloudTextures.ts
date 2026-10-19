// Browser side of the real-weather cloud layer (tides-l3s): fetches the GIBS
// true- and false-colour tiles, plus the previous day's where they have gaps,
// and turns them into a cloud alphaMap for the shared controller. The maths is
// in ../real-clouds.ts, the state machine in ./realCloudController.ts.
import { useEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import {
  COLS,
  composeCloudAlpha,
  fillDate,
  fillNoData,
  growNoData,
  iceWeight,
  isRetryable,
  OUT_H,
  OUT_W,
  SNOW_EDGES,
  TILE,
  TILE_TIMEOUT_MS,
  tilesToFill,
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

function tileValues(results: PromiseSettledResult<ImageBitmap | null>[]) {
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null))
}

/** Draws the tiles, then closes them to free their memory early. */
function mosaic(ctx: CanvasRenderingContext2D, tiles: (ImageBitmap | null)[]) {
  tiles.forEach((tile, i) => {
    if (!tile) return
    ctx.drawImage(tile, (i % COLS) * TILE, Math.floor(i / COLS) * TILE)
    tile.close()
  })
}

/** Null when every primary true-colour tile failed. Throws when aborted. */
async function buildCloudTexture(
  source: GibsSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.CanvasTexture | null> {
  // Lets a failed mask stop this build's tile downloads too.
  const local = new AbortController()
  const tileSignal = anySignal([signal, local.signal])
  const pending: Promise<PromiseSettledResult<ImageBitmap | null>[]>[] = []
  /** Unwanted tiles resolve null without fetching. */
  const load = (layer: string, date: string, wanted?: readonly boolean[]) => {
    const settled = Promise.allSettled(
      tileUrls(layer, date).map((url, i) =>
        wanted && !wanted[i] ? null : loadTile(url, tileSignal)
      )
    )
    pending.push(settled)
    return settled
  }
  const trueSettled = load(source.layer, source.date)
  const falseSettled = load(source.snowLayer, source.date)
  const masks = Promise.all([getStaticAlpha(staticUrl), getIceMask()]).catch(
    (err: unknown) => {
      local.abort()
      throw err
    }
  )
  // Awaited below; this only keeps an abort before then from leaving it
  // unhandled.
  masks.catch(() => {})
  try {
    const trueTiles = tileValues(await trueSettled)
    signal.throwIfAborted()
    const failed = trueTiles.map((t) => t === null)
    if (failed.every(Boolean)) {
      // A failed mask aborts the tiles, so report it rather than the tiles.
      await masks
      return null
    }

    // Missing tiles stay transparent black: no data in true colour, no snow in
    // false colour.
    const { canvas, ctx } = canvas2d(OUT_W, OUT_H)
    mosaic(ctx, trueTiles)
    const image = ctx.getImageData(0, 0, OUT_W, OUT_H)
    const wanted = tilesToFill(image.data, failed)
    // After counting, so a complete day's stray no-data pixels don't add up to
    // a gap.
    growNoData(image.data, OUT_W, OUT_H, failed)
    const date = fillDate(source)
    const fillSettled =
      date !== null && wanted.some(Boolean)
        ? Promise.all([load(source.layer, date, wanted), load(source.snowLayer, date, wanted)])
        : null
    const [[staticAlpha, ice], falseResults, fillResults] = await Promise.all([
      masks,
      falseSettled,
      fillSettled,
    ])
    signal.throwIfAborted()

    ctx.clearRect(0, 0, OUT_W, OUT_H)
    mosaic(ctx, tileValues(falseResults))
    const falseColour = ctx.getImageData(0, 0, OUT_W, OUT_H).data
    if (fillResults) {
      const [fillTrue, fillFalse] = fillResults.map(tileValues)
      fillTrue.forEach((tile, i) => {
        if (!tile) return
        const x = (i % COLS) * TILE
        const y = Math.floor(i / COLS) * TILE
        const h = Math.min(TILE, OUT_H - y)
        const region = (bitmap: ImageBitmap | null) => {
          ctx.clearRect(x, y, TILE, h)
          if (bitmap) {
            ctx.drawImage(bitmap, x, y)
            bitmap.close()
          }
          return ctx.getImageData(x, y, TILE, h).data
        }
        const fillFalseColour = region(fillFalse[i])
        const fillTrueColour = region(tile)
        growNoData(fillTrueColour, TILE, h)
        fillNoData(image.data, falseColour, fillTrueColour, fillFalseColour, x, y, TILE, h)
      })
    }

    composeCloudAlpha(
      image.data,
      falseColour,
      SNOW_EDGES[source.snowLayer],
      staticAlpha,
      ice,
      image.data
    )
    ctx.putImageData(image, 0, 0)

    const texture = new THREE.CanvasTexture(canvas)
    // alphaMap is data, not colour.
    texture.colorSpace = THREE.NoColorSpace
    return texture
  } finally {
    // For the paths that return or throw before mosaic; close() is idempotent.
    for (const results of await Promise.all(pending)) {
      for (const tile of tileValues(results)) tile?.close()
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
