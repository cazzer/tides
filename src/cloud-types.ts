// What kind of cloud the real-weather clouds are (tides-tvr.4.1): Open-Meteo's
// low, mid and high cloud cover (../forecast-clouds.ts) as a small per-frame
// "type grid" the GPU blends alongside the frames (renderers/cloudBlend.ts).
// The satellites' map stays the where-cloud; this only says what it is.
//
// From above, a layer shows where the layers over it leave gaps. With the
// layers overlapping at random, high cloud covers H of the sky, mid shows
// through the rest, M (1 - H), and low through what's left, L (1 - M)(1 - H).
// Normalised, those are the shares of each kind in what a camera above sees:
// high is cirrus, mid alto, and low splits into cumulus where it is broken
// and stratus (stratocumulus included) where it is a deck. The grid's
// confidence fades to 0 where the model has next to no cloud, so a clear
// cell's leftover type never decides anything.
//
// The grid is TYPE_W x TYPE_H RGBA8, bottom row first like a CloudImage: R
// cirrus, G cumulus, B alto, A confidence, stratus the rest of RGB's share.
// Pure; the build is renderers/cloudPipeline.ts.
import { gridCovers, layersAt, sampleCoverSmooth, type CoverGrid, type CoverLayers } from './forecast-clouds'
import { DAY_MS, HOUR_MS, smoothstep } from './real-clouds'

/** The type grid: 2.5° texels, equirectangular like the cloud map. */
export const TYPE_W = 144
export const TYPE_H = 72
/** Visible cloud (0..1) at which the confidence starts and is full. */
export const TYPE_CONFIDENCE_EDGES = [0.02, 0.15] as const
/** Low cover from which it stops reading as broken cumulus and is a deck. */
export const CUMULUS_BROKEN_EDGES = [0.45, 0.85] as const
/** Local solar time of the daily composite's satellites' overpass (VIIRS on
 * Suomi NPP and MODIS on Terra cross the equator at about 13:30 and 10:30;
 * the afternoon one, as VIIRS is what the composite uses since 2015). */
export const OVERPASS_LOCAL_HOURS = 13.5

export interface CloudTypeShares {
  cirrus: number
  cumulus: number
  alto: number
  stratus: number
  /** 0..1: how far to trust the shares (0 where there is next to no cloud). */
  confidence: number
}

/** The shares of each kind in the cloud seen from above, from low, mid and
 * high cover (0..1); they sum to 1, or are all 0 where nothing shows. */
export function visibleShares(low: number, mid: number, high: number): CloudTypeShares {
  const vHigh = high
  const vMid = mid * (1 - high)
  const vLow = low * (1 - mid) * (1 - high)
  const total = vHigh + vMid + vLow
  const confidence = smoothstep(TYPE_CONFIDENCE_EDGES[0], TYPE_CONFIDENCE_EDGES[1], total)
  if (!(total > 0)) return { cirrus: 0, cumulus: 0, alto: 0, stratus: 0, confidence: 0 }
  const lowShare = vLow / total
  const broken = 1 - smoothstep(CUMULUS_BROKEN_EDGES[0], CUMULUS_BROKEN_EDGES[1], low)
  return {
    cirrus: vHigh / total,
    cumulus: lowShare * broken,
    alto: vMid / total,
    stratus: lowShare * (1 - broken),
    confidence,
  }
}

/** Centre of a type grid texel: column x from the west, row y from the
 * bottom (south), as the grid is stored. */
export const typeTexelLon = (x: number) => -180 + ((x + 0.5) / TYPE_W) * 360
export const typeTexelLat = (y: number) => -90 + ((y + 0.5) / TYPE_H) * 180

/**
 * The type grid for a frame, or null when the grid has no layers. timeOfLon
 * says when the frame shows each longitude (one time for a geostationary or
 * forecast frame, the overpass for a daily composite); columns whose time the
 * grid doesn't cover are untyped (all 0). The layers are resampled at the
 * texel centres with smoothstep-weighted bilinear, then turned into shares.
 */
export function typeGridImage(
  grid: CoverGrid,
  timeOfLon: (lonDeg: number) => number
): Uint8Array<ArrayBuffer> | null {
  if (!grid.layers) return null
  const out = new Uint8Array(TYPE_W * TYPE_H * 4)
  // Usually one time for every column.
  const atTime = new Map<number, CoverLayers | null>()
  for (let x = 0; x < TYPE_W; x++) {
    const lon = typeTexelLon(x)
    const t = timeOfLon(lon)
    let layers = atTime.get(t)
    if (layers === undefined) {
      layers = layersAt(grid, t)
      atTime.set(t, layers)
    }
    if (!layers) continue
    for (let y = 0; y < TYPE_H; y++) {
      const lat = typeTexelLat(y)
      const s = visibleShares(
        sampleCoverSmooth(layers.low, lat, lon),
        sampleCoverSmooth(layers.mid, lat, lon),
        sampleCoverSmooth(layers.high, lat, lon)
      )
      const i = (y * TYPE_W + x) * 4
      out[i] = Math.round(255 * s.cirrus)
      out[i + 1] = Math.round(255 * s.cumulus)
      out[i + 2] = Math.round(255 * s.alto)
      out[i + 3] = Math.round(255 * s.confidence)
    }
  }
  return out
}

/**
 * When a daily composite (dated dayMs, its UTC midnight) shows a longitude:
 * the satellite's afternoon overpass there, taken within that UTC day (west
 * of 157.5°W the overpass of the local day before, early in the UTC day), or
 * noon where the grid doesn't cover that.
 */
export function dailyTimeOfLon(grid: CoverGrid, dayMs: number): (lonDeg: number) => number {
  const noon = dayMs + DAY_MS / 2
  return (lonDeg) => {
    const hours = (((OVERPASS_LOCAL_HOURS - lonDeg / 15) % 24) + 24) % 24
    const t = dayMs + hours * HOUR_MS
    return gridCovers(grid, t) ? t : noon
  }
}
