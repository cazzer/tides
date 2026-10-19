// Browser side of the real-weather cloud layer (tides-l3s): fetches the GIBS
// tiles and turns them into a cloud alphaMap for the shared controller. A day
// of the daily composite is the true- and false-colour tiles, plus the
// previous day's where they have gaps and along the antimeridian, with sunglint
// taken out (tides-a7w) and the seams between them feathered (tides-g29). A geostationary slot (tides-1zj) is
// each satellite's IR, and visible where it's day, over that day's composite.
// The maths is in ../real-clouds.ts and ../geo-clouds.ts, the state machine
// in ./realCloudController.ts.
import { useEffect, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import {
  blendDaily,
  COLS,
  composeCloudAlpha,
  dataMask,
  DAY_MS,
  fillDate,
  glintFloor,
  GEO_SLOT_MS,
  geoTimeKey,
  growNoData,
  iceWeight,
  isRetryable,
  OUT_H,
  OUT_W,
  ROWS,
  SNOW_EDGES,
  sourceKey,
  TILE,
  TILE_TIMEOUT_MS,
  tilesToFill,
  tileUrls,
  type GeoSource,
  type GibsSource,
} from '../real-clouds'
import {
  composeGeoClouds,
  daylitTiles,
  decodeIr,
  GEO_SATELLITES,
  GEO_STEP_BACK,
  geoTilesFor,
  geoTileUrl,
  probeTile,
  subsolarPoint,
  visibleGrey,
  type GeoSatellite,
  type Terrain,
} from '../geo-clouds'
import {
  createRealCloudController,
  type CloudSnapshot,
  type ImagerySource,
} from './realCloudController'
import earthSpecular from '../assets/earth-specular-2k.jpg'
import earthDay from '../assets/earth-day-2k.jpg'
import earthBump from '../assets/earth-bump-2k.jpg'

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

/** One retry for transient failures. Throws only when the build is aborted. */
async function fetchTile(url: string, signal: AbortSignal): Promise<ImageBitmap | TileFailure> {
  const result = await fetchTileOnce(url, signal)
  if (!(result instanceof ImageBitmap) && isRetryable(result)) {
    return fetchTileOnce(url, signal)
  }
  return result
}

/** fetchTile, or null when the tile can't be had, so its area falls back. */
async function loadTile(url: string, signal: AbortSignal): Promise<ImageBitmap | null> {
  const result = await fetchTile(url, signal)
  if (result instanceof ImageBitmap) return result
  console.warn(`[clouds] dropped GIBS tile (${result}): ${url}`)
  return null
}

/** Lets the frame loop run between the heavy steps of a build. */
const yieldToFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// Built once and kept, all 1 byte per output pixel (~3.3 MB each).
let iceMask: Promise<Uint8Array> | null = null
let landMask: Promise<Uint8Array> | null = null
let terrain: Promise<Terrain> | null = null
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

/** Nonzero on land, from the static specular map (water is bright), for the
 * glint removal and the geostationary clear-sky reference. */
function getLand(): Promise<Uint8Array> {
  return (
    landMask ??
    memo(
      async () => {
        const spec = pixelsOf(await fetchBitmap(earthSpecular))
        const land = new Uint8Array(OUT_W * OUT_H)
        for (let p = 0; p < land.length; p++) land[p] = spec[p * 4 + 1] < 128 ? 255 : 0
        return land
      },
      (p) => (landMask = p)
    )
  )
}

/** Elevation from the static bump map, and land, for the geostationary
 * clear-sky reference. */
function getTerrain(): Promise<Terrain> {
  return (
    terrain ??
    memo(
      async () => {
        const [bump, land] = await Promise.all([fetchBitmap(earthBump).then(pixelsOf), getLand()])
        const elevation = new Uint8Array(OUT_W * OUT_H)
        for (let p = 0; p < elevation.length; p++) elevation[p] = bump[p * 4]
        return { elevation, land }
      },
      (p) => (terrain = p)
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

/** The daily composite's alpha as OUT_W x OUT_H RGBA (alpha in every colour
 * channel). Null when every primary true-colour tile failed. Throws when
 * aborted. */
async function buildDailyAlpha(
  source: GibsSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<Uint8ClampedArray | null> {
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
    // The fill day's west-most column always: just east of 180° it continues
    // this day's west side, which this day's own east side doesn't (tides-g29).
    if (date !== null) for (let row = 0; row < ROWS; row++) wanted[row * COLS] = true
    const fillSettled =
      date !== null
        ? Promise.all([load(source.layer, date, wanted), load(source.snowLayer, date, wanted)])
        : null
    // Without the land mask there's no telling sea glint from cloud, so it
    // stays, and ice cloud over the sea can read as snow; the clouds are
    // still worth showing.
    const landLoad = getLand().catch((err: unknown) => {
      console.warn('[clouds] no land mask for the glint removal', err)
      return null
    })
    const [[staticAlpha, ice], land, falseResults, fillResults] = await Promise.all([
      masks,
      landLoad,
      falseSettled,
      fillSettled,
    ])
    signal.throwIfAborted()

    const colours = (tiles: (ImageBitmap | null)[]) => {
      ctx.clearRect(0, 0, OUT_W, OUT_H)
      mosaic(ctx, tiles)
      return ctx.getImageData(0, 0, OUT_W, OUT_H).data
    }
    const falseColour = colours(tileValues(falseResults))
    let fill: { gibs: Uint8ClampedArray; falseColour: Uint8ClampedArray; data: Uint8Array } | null =
      null
    if (fillResults) {
      const [fillTrue, fillFalse] = fillResults.map(tileValues)
      // Unfetched (and failed) tiles are no data, but not a gap to grow.
      const missing = fillTrue.map((t) => t === null)
      const gibs = colours(fillTrue)
      growNoData(gibs, OUT_W, OUT_H, missing)
      fill = { gibs, falseColour: colours(fillFalse), data: dataMask(gibs, missing) }
    }
    canvas.width = 0

    const primaryData = dataMask(image.data)
    const snowEdges = SNOW_EDGES[source.snowLayer]
    const dayMs = Date.parse(source.date)
    const glint = land ? glintFloor(image.data, land, dayMs) : null
    composeCloudAlpha(image.data, falseColour, snowEdges, staticAlpha, ice, image.data, glint, land)
    await yieldToFrame()
    signal.throwIfAborted()
    if (fill) {
      const fillGlint = land ? glintFloor(fill.gibs, land, dayMs - DAY_MS) : null
      composeCloudAlpha(fill.gibs, fill.falseColour, snowEdges, staticAlpha, ice, fill.gibs, fillGlint, land)
      await yieldToFrame()
      signal.throwIfAborted()
    }
    blendDaily(image.data, primaryData, fill?.gibs ?? null, fill?.data ?? null, staticAlpha, image.data)
    return image.data
  } finally {
    // For the paths that return or throw before mosaic; close() is idempotent.
    for (const results of await Promise.all(pending)) {
      for (const tile of tileValues(results)) tile?.close()
    }
  }
}

// Daily composites, shared by the builds that want them: every geostationary
// slot of a day sits over the same one, so it is fetched once. An unfinished
// one is aborted when the last build waiting on it is.
interface DailyEntry {
  promise: Promise<Uint8ClampedArray | null>
  abort: AbortController
  users: number
  settled: boolean
  lastUsed: number
}
const dailies = new Map<string, DailyEntry>()
const MAX_DAILIES = 2

function trimDailies() {
  const idle = [...dailies].filter(([, e]) => e.settled && e.users === 0)
  idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  const settled = [...dailies.values()].filter((e) => e.settled).length
  for (const [key] of idle.slice(0, Math.max(0, settled - MAX_DAILIES))) dailies.delete(key)
}

function acquireDaily(
  source: GibsSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<Uint8ClampedArray | null> {
  signal.throwIfAborted()
  const key = `${sourceKey(source)}|${staticUrl}`
  let entry = dailies.get(key)
  if (!entry) {
    const abort = new AbortController()
    const created: DailyEntry = {
      promise: buildDailyAlpha(source, staticUrl, abort.signal),
      abort,
      users: 0,
      settled: false,
      lastUsed: 0,
    }
    dailies.set(key, created)
    created.promise.then(
      (data) => {
        created.settled = true
        // A day without imagery is tried again next time, like a failed tile.
        if (!data && dailies.get(key) === created) dailies.delete(key)
        trimDailies()
      },
      () => {
        if (dailies.get(key) === created) dailies.delete(key)
      }
    )
    entry = created
  }
  const e = entry
  e.users++
  e.lastUsed = performance.now()
  return new Promise((resolve, reject) => {
    const release = () => {
      e.users--
      if (e.users === 0 && !e.settled) {
        e.abort.abort()
        if (dailies.get(key) === e) dailies.delete(key)
      }
      reject(signal.reason)
    }
    signal.addEventListener('abort', release, { once: true })
    e.promise
      .finally(() => {
        if (signal.aborted) return
        signal.removeEventListener('abort', release)
        e.users--
        e.lastUsed = performance.now()
        trimDailies()
      })
      .then(resolve, reject)
  })
}

/** What a geostationary texture was made of, for the attribution. */
export interface GeoTextureInfo {
  satellites: string[]
  /** The oldest slot used, when a satellite had to step back. */
  time: string
}

function textureOf(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  geo: GeoTextureInfo | null
): THREE.CanvasTexture {
  const { canvas, ctx } = canvas2d(OUT_W, OUT_H)
  ctx.putImageData(new ImageData(rgba, OUT_W, OUT_H), 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  // alphaMap is data, not colour.
  texture.colorSpace = THREE.NoColorSpace
  texture.userData.geo = geo
  return texture
}

async function buildDailyTexture(
  source: GibsSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.CanvasTexture | null> {
  const data = await acquireDaily(source, staticUrl, signal)
  signal.throwIfAborted()
  // A copy: the composite stays shared with geostationary builds.
  return data ? textureOf(new Uint8ClampedArray(data), null) : null
}

interface SatelliteTiles {
  sat: GeoSatellite
  time: string
  ir: (ImageBitmap | null)[]
  vis: (ImageBitmap | null)[]
}

/** One satellite's IR tiles (and visible where it's day) at the slot, or as
 * many slots before as it takes to find one GIBS has (it skips a few a day).
 * Null when none of them can be had. */
async function loadSatellite(
  sat: GeoSatellite,
  slotMs: number,
  signal: AbortSignal
): Promise<SatelliteTiles | null> {
  const wanted = geoTilesFor(sat.lon)
  const probe = probeTile(sat.lon)
  for (let back = 0; back <= GEO_STEP_BACK; back++) {
    const timeMs = slotMs - back * GEO_SLOT_MS
    const time = geoTimeKey(timeMs)
    const first = await fetchTile(geoTileUrl(sat.irLayer, time, probe), signal)
    if (!(first instanceof ImageBitmap)) {
      if (first === 404) continue
      console.warn(`[clouds] no ${sat.label} imagery at ${time} (${first})`)
      return null
    }
    const daylit = daylitTiles(wanted, subsolarPoint(timeMs))
    const all = (layer: string, want: readonly boolean[]) =>
      Promise.allSettled(
        want.map((w, i) => (w ? loadTile(geoTileUrl(layer, time, i), signal) : null))
      ).then(tileValues)
    const [ir, vis] = await Promise.all([
      all(sat.irLayer, wanted.map((w, i) => w && i !== probe)),
      all(sat.visLayer, daylit),
    ])
    ir[probe] = first
    return { sat, time, ir, vis }
  }
  console.warn(`[clouds] no ${sat.label} imagery from ${geoTimeKey(slotMs)} back ${GEO_STEP_BACK} slots`)
  return null
}

/** Null when there's neither geostationary nor daily imagery. Throws when
 * aborted. */
async function buildGeoTexture(
  source: GeoSource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.CanvasTexture | null> {
  const slotMs = Date.parse(source.time)
  const daily = acquireDaily(source.fallback, staticUrl, signal).catch((err: unknown) => {
    if (signal.aborted) throw err
    console.error('[clouds] building the daily composite failed', err)
    return null
  })
  // Awaited below; this only keeps an abort before then from leaving it
  // unhandled.
  daily.catch(() => {})
  const terrainLoad = getTerrain().catch((err: unknown) => {
    console.warn('[clouds] no terrain for the IR reference', err)
    return null
  })
  const satellites = await Promise.all(
    GEO_SATELLITES.map((sat) =>
      loadSatellite(sat, slotMs, signal).catch((err: unknown) => {
        if (signal.aborted) throw err
        console.warn(`[clouds] ${sat.label} failed`, err)
        return null
      })
    )
  )
  try {
    signal.throwIfAborted()
    const found = satellites.filter((s): s is SatelliteTiles => s !== null)
    if (!found.length) {
      const fallback = await daily
      signal.throwIfAborted()
      return fallback ? textureOf(new Uint8ClampedArray(fallback), null) : null
    }

    // One satellite at a time, so only one full-size mosaic is held at once.
    const temps: (Float32Array | null)[] = GEO_SATELLITES.map(() => null)
    const vis: (Uint8Array | null)[] = GEO_SATELLITES.map(() => null)
    const { canvas, ctx } = canvas2d(OUT_W, OUT_H)
    for (const s of found) {
      const index = GEO_SATELLITES.indexOf(s.sat)
      ctx.clearRect(0, 0, OUT_W, OUT_H)
      mosaic(ctx, s.ir)
      temps[index] = decodeIr(ctx.getImageData(0, 0, OUT_W, OUT_H).data, OUT_W, OUT_H)
      if (s.vis.some(Boolean)) {
        ctx.clearRect(0, 0, OUT_W, OUT_H)
        mosaic(ctx, s.vis)
        vis[index] = visibleGrey(ctx.getImageData(0, 0, OUT_W, OUT_H).data)
      }
      await yieldToFrame()
      signal.throwIfAborted()
    }
    canvas.width = 0

    const [fallback, land] = await Promise.all([daily, terrainLoad])
    signal.throwIfAborted()
    const out = new Uint8ClampedArray(OUT_W * OUT_H * 4)
    if (fallback) {
      out.set(fallback)
    } else {
      // No daily composite either: the static clouds show where no satellite
      // sees.
      const alpha = await getStaticAlpha(staticUrl)
      signal.throwIfAborted()
      for (let p = 0; p < alpha.length; p++) out[p * 4 + 1] = alpha[p]
    }
    composeGeoClouds({ temps, vis, timeMs: slotMs }, land, out, out)
    const times = found.map((s) => s.time).sort()
    return textureOf(out, { satellites: found.map((s) => s.sat.label), time: times[0] })
  } finally {
    for (const s of satellites) {
      for (const tile of [...(s?.ir ?? []), ...(s?.vis ?? [])]) tile?.close()
    }
  }
}

function buildCloudTexture(
  source: ImagerySource,
  staticUrl: string,
  signal: AbortSignal
): Promise<THREE.CanvasTexture | null> {
  return source.kind === 'geo'
    ? buildGeoTexture(source, staticUrl, signal)
    : buildDailyTexture(source, staticUrl, signal)
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
