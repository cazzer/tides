// The seasons tour's sea ice, fetched once on first use (tides-zec.19): the
// year of grids (sea-ice.ts) and the mask of where the globe's layer draws
// (scripts/build-sea-ice.py). Nothing loads outside the tour. A failure
// warns and leaves the tour without ice, never a broken scene.
import { useEffect, useState } from 'react'
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

/** The tour's sea ice, fetched on the first call; null if it failed to load. */
export function loadSeaIce(): Promise<SeaIceData | null> {
  pending ??= Promise.all([loadIce(), loadMask()]).then(
    ([ice, mask]) => ({ ice, mask }),
    (error: unknown) => {
      console.warn('Sea ice failed to load; the seasons tour goes on without it.', error)
      return null
    }
  )
  return pending
}

/** The sea ice once loaded while `enabled` (null until then, or if it failed). */
export function useSeaIce(enabled = true): SeaIceData | null {
  const [data, setData] = useState<SeaIceData | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    loadSeaIce().then((loaded) => {
      if (alive) setData(loaded)
    })
    return () => {
      alive = false
    }
  }, [enabled])
  return enabled ? data : null
}
