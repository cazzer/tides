// Terrarium elevation tiles decoded into the padded grids the terrain plugin
// meshes from (tides-zmw.9.2). The library decodes on the main thread
// (its GridCache draws each 512 px WebP onto a canvas and reads 262k pixels
// back), which stalled descents for up to 870 ms; here the same decode runs
// in a worker (terrarium-decode.worker.ts) and these functions are what both
// sides share.
//
// The grid's layout is the library's (3d-tiles-renderer 0.5.3's GridCache,
// pinned by terrain-internals.test.ts): metres as 32-bit floats, rows south
// to north (it decodes an image flipped on load), with a one-texel border
// that starts as a copy of the edge texels and is later overwritten from the
// neighbouring tiles so both sides of a seam sample the same heights.

/** A decoded grid: (width + 2) x (height + 2) metres, border included. */
export interface PaddedGrid {
  data: Float32Array<ArrayBuffer>
  /** The padded width and height (the source tile's plus 2). */
  width: number
  height: number
}

/** Metres from a Terrarium pixel (Mapterhorn, AWS Terrain Tiles). */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/**
 * Decodes a Terrarium tile's RGBA pixels, rows top (north) first as an image
 * or canvas gives them, into a padded grid: rows south first, the border a
 * copy of the edge texels.
 */
export function decodeTerrariumPadded(rgba: ArrayLike<number>, width: number, height: number): PaddedGrid {
  const pw = width + 2
  const ph = height + 2
  const data = new Float32Array(pw * ph)
  for (let y = 0; y < height; y++) {
    // grid row y + 1 holds image row height - 1 - y
    const src = 4 * (height - 1 - y) * width
    const dst = (y + 1) * pw + 1
    for (let x = 0; x < width; x++) {
      const i = src + 4 * x
      data[dst + x] = terrariumElevation(rgba[i], rgba[i + 1], rgba[i + 2])
    }
  }
  for (let y = 1; y < ph - 1; y++) {
    data[y * pw] = data[y * pw + 1]
    data[y * pw + pw - 1] = data[y * pw + pw - 2]
  }
  data.copyWithin(0, pw, 2 * pw)
  data.copyWithin((ph - 1) * pw, (ph - 2) * pw, (ph - 1) * pw)
  return { data, width: pw, height: ph }
}

/** A sea-level grid for a tile the source has no data for (open ocean). */
export function flatGrid(tileSize: number): PaddedGrid {
  const side = tileSize + 2
  return { data: new Float32Array(side * side), width: side, height: side }
}

/**
 * A tile's padded grid resampled from an ancestor's (tides-zmw.9.21: where
 * the source's coverage ends, a finer tile reads the coarser data rather
 * than sea level). `sub` is the tile's rectangle within the ancestor's,
 * normalized [u0, v0, u1, v1] (v north, as the grid's rows); each texel,
 * border included, takes the ancestor's bilinear read at its centre, the
 * library's sampleGrid (the GPU's linear read), so the tile draws the
 * ancestor's ground. Separable: each column's and row's taps once.
 */
export function resampleGrid(src: PaddedGrid, sub: readonly number[], tileSize: number): PaddedGrid {
  const side = tileSize + 2
  const { data: s, width: sw, height: sh } = src
  const taps = (lo: number, hi: number, inner: number, size: number) => {
    const i0 = new Int32Array(side)
    const i1 = new Int32Array(side)
    const t = new Float32Array(side)
    for (let i = 0; i < side; i++) {
      // texel i's centre, (i - 0.5) / tileSize across the tile, in the ancestor's padded texels
      const f = Math.min(Math.max((lo + ((i - 0.5) / tileSize) * (hi - lo)) * inner + 0.5, 0), size - 1)
      i0[i] = Math.floor(f)
      i1[i] = Math.min(i0[i] + 1, size - 1)
      t[i] = f - i0[i]
    }
    return { i0, i1, t }
  }
  const cols = taps(sub[0], sub[2], sw - 2, sw)
  const rows = taps(sub[1], sub[3], sh - 2, sh)
  const data = new Float32Array(side * side)
  for (let j = 0; j < side; j++) {
    const r0 = rows.i0[j] * sw
    const r1 = rows.i1[j] * sw
    const ty = rows.t[j]
    for (let i = 0; i < side; i++) {
      const x0 = cols.i0[i]
      const x1 = cols.i1[i]
      const tx = cols.t[i]
      const h0 = s[r0 + x0] * (1 - tx) + s[r0 + x1] * tx
      const h1 = s[r1 + x0] * (1 - tx) + s[r1 + x1] * tx
      data[j * side + i] = h0 * (1 - ty) + h1 * ty
    }
  }
  return { data, width: side, height: side }
}

/**
 * The highest of an ancestor grid's texels whose centres lie in the
 * normalized rectangle `sub` (the nearest one when none does): over a tile
 * the source left out, whether the ancestor holds any ground above the sea.
 */
export function gridMaxWithin(src: PaddedGrid, sub: readonly number[]): number {
  const { data, width, height } = src
  const span = (lo: number, hi: number, inner: number): [number, number] => {
    const clamp = (k: number) => Math.min(Math.max(k, 1), inner)
    let k0 = Math.ceil(lo * inner + 0.5)
    let k1 = Math.floor(hi * inner + 0.5)
    if (k0 > k1) k0 = k1 = Math.round(((lo + hi) / 2) * inner + 0.5)
    return [clamp(k0), clamp(k1)]
  }
  const [x0, x1] = span(sub[0], sub[2], width - 2)
  const [y0, y1] = span(sub[1], sub[3], height - 2)
  let top = -Infinity
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) top = Math.max(top, data[y * width + x])
  return top
}

/**
 * Decodes an encoded tile (WebP, PNG) into a padded grid with the browser's
 * image decoder and a 2D canvas: OffscreenCanvas in a worker or where the
 * page has one, else a DOM canvas. No colour management, as the library's
 * decode: the pixels are data.
 */
export async function decodeTerrariumImage(buffer: ArrayBuffer): Promise<PaddedGrid> {
  const bitmap = await createImageBitmap(new Blob([buffer]), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
  try {
    const { width, height } = bitmap
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height })
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null
    if (!ctx) throw new Error('terrarium decode: no 2D canvas')
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, width, height)
    return decodeTerrariumPadded(data, width, height)
  } finally {
    bitmap.close()
  }
}
