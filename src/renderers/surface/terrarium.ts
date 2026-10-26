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
