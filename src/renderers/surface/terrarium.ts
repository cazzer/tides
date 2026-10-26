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
 * The lowest and highest of an ancestor grid's texels whose centres lie in
 * the normalized rectangle `sub` (the nearest one when none does): over a
 * tile the source left out, whether the ancestor holds anything but the sea
 * (Mapterhorn's is exactly 0 m) there.
 */
export function gridRangeWithin(src: PaddedGrid, sub: readonly number[]): [number, number] {
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
  let min = Infinity
  let max = -Infinity
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = data[y * width + x]
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return [min, max]
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

// ---------------------------------------------------------------------------
// Per-grid horizon maps (tides-zmw.9.15): how high the ground stands around
// each point of a grid, in eight compass directions, for the tiles' cast
// shadows (tile-shadow.ts). Baked in a decode worker after the grid is
// made, at a quarter of its resolution, at true scale: each value is the
// steepest rise's tangent (metres per metre) over the curved Earth,
// max (Δh / d - d / 2R), so the shader takes it to the page's relief s
// by multiplying. That scales the Earth's curvature drop with the relief
// (s (Δh / d - d / 2R), where s Δh / d - d / 2R is exact): the drop is
// ~1e-3 at the 12 km reach (0.05°), so at 12x a ridge 12 km out shades as
// if ~0.6° lower than it would; nearer, less. The globe's map does the
// same (earth-horizon.ts).
//
// Reach. A grid spans 0.5 km (z16) to hundreds of km, but a shadow's length
// doesn't depend on which grid draws it: a search that stopped at the
// grid's edge would cut shadows at every seam, and at a different length
// on each level of detail. So every grid searches the same distance in
// metres (TILE_HORIZON_REACH_METRES), on geometric steps from
// TILE_HORIZON_FIRST_TEXELS of its own texels; past its own inner texels a
// step reads the context, the first window that holds the point: its
// same-level neighbours' grids at their own texels (a band past each shared
// edge, so two grids read the same ground there and agree at the seam),
// then its ancestors' (each a window around the grid, coarser and wider up
// the chain). Grids that weren't loaded when it was baked are missing, and
// its reach is shorter (terrain-internals.ts bakes it again when a
// neighbour turns up).
//
// Layout: two layers of RGBA8, TILE_HORIZON_DIVISOR times smaller than the
// padded grid each way and spanning the same uv square (texel a's centre at
// uv (a + 0.5) / size), layer 0 holding N, NE, E, SE and layer 1 S, SW, W,
// NW, as the globe's (../earthHorizonTexture.ts); rows south first, as the
// grid's. Each byte codes the tangent t as t / (t + 1/GAIN) in 255 steps,
// rounded down (flat ground reads 0): fine near flat (1/255 is 0.028° at
// 1x), still near vertical at the top, and the shader decodes it with one
// division (no tan, no atan: tile-shadow.ts).
// ---------------------------------------------------------------------------

/** Directions: 360° · d / 8 clockwise from north. */
export const TILE_HORIZON_DIRECTIONS = 8
/** Grid texels per horizon texel, each way. */
export const TILE_HORIZON_DIVISOR = 4
/** The code's gain: byte = floor(255 · t / (t + 1 / GAIN)). */
export const TILE_HORIZON_GAIN = 8
/** How far every grid's search looks, metres. */
export const TILE_HORIZON_REACH_METRES = 12000
/** The nearest step, at least this many of the grid's own texels (half a horizon texel; nearer is the slope's own shading). */
export const TILE_HORIZON_FIRST_TEXELS = 2
/** Each step this much longer than the last (worst miss ~1.4° against a 0.05-texel march, mean 0.1°: the test). */
export const TILE_HORIZON_STEP_RATIO = 1.45
/** The tiles' sphere (surface-frame.ts SURFACE_ELLIPSOID_RADIUS, mirrored to keep three out of the worker). */
export const TILE_HORIZON_RADIUS = 6371000
/** An ancestor window's margin around the grid, in the ancestor's texels. */
export const TILE_HORIZON_MARGIN_TEXELS = 64
/** Layers of the texture (four directions each). */
export const TILE_HORIZON_LAYERS = 2

/**
 * Heights a bake reads, in grid coordinates g (texels from the grid's
 * south-west corner, the padded grid's texel i at g = i - 0.5): read
 * bilinearly at array coordinates g / scale + offset, within [min, max].
 */
export interface HorizonSource {
  data: Float32Array<ArrayBuffer>
  width: number
  height: number
  /** Grid texels per source texel (4^k for the k-th ancestor grid up). */
  scale: number
  offsetX: number
  offsetY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** What a bake needs besides the grid: where it is, and its context. */
export interface HorizonJob {
  /** The grid's source tile size (the padded grid's minus 2). */
  tileSize: number
  /** Its south and north edges, normalized Mercator v (the tiling's getTileBounds). */
  south: number
  north: number
  /** Windows of the grids around it (horizonWindow()): a point reads the first that holds it (neighbours, then ancestors finest first). */
  context: HorizonSource[]
}

/** The horizon map's side for a source tile size. */
export function tileHorizonSize(tileSize: number): number {
  return Math.max(1, Math.round(tileSize / TILE_HORIZON_DIVISOR))
}

/** The byte for a tangent (true scale, metres per metre). */
export function tileHorizonCode(tangent: number): number {
  if (!(tangent > 0)) return 0
  const g = TILE_HORIZON_GAIN * tangent
  return Math.min(255, Math.floor((255 * g) / (g + 1)))
}

/** The highest code the shader decodes (the next is vertical). */
export const TILE_HORIZON_CODE_MAX = 0.998

/** The tangent a code in [0, 1] (a byte over 255, as the texture reads it) stands for: the shader's decode. */
export function tileHorizonTangent01(c: number): number {
  const k = Math.min(c, TILE_HORIZON_CODE_MAX)
  return k / (1 - k) / TILE_HORIZON_GAIN
}

/** The tangent a byte stands for. */
export function tileHorizonTangent(code: number): number {
  return tileHorizonTangent01(code / 255)
}

/** The grid itself as a source: its inner texels (the border is the neighbours' or a copy). */
export function gridSource(grid: PaddedGrid): HorizonSource {
  return {
    data: grid.data,
    width: grid.width,
    height: grid.height,
    scale: 1,
    offsetX: 0.5,
    offsetY: 0.5,
    minX: 1,
    maxX: grid.width - 2,
    minY: 1,
    maxY: grid.height - 2,
  }
}

/**
 * A window of an ancestor grid around the grid it contains, `sub` its
 * rectangle in the ancestor's (normalized, v north, as resampleGrid()'s),
 * with `margin` of the ancestor's texels each side, clipped to its padded
 * texels (the border, its neighbours' edge or a copy of its own, covers a
 * grid at its edge out to the edge); copied, so the window can be
 * transferred.
 */
export function horizonWindow(ancestor: PaddedGrid, sub: readonly number[], margin = TILE_HORIZON_MARGIN_TEXELS): HorizonSource {
  const { data, width, height } = ancestor
  const iw = width - 2
  const ih = height - 2
  // the grid's corners in the ancestor's padded texels (a + 0.5, a inner)
  const x0 = Math.max(0, Math.floor(sub[0] * iw + 0.5 - margin))
  const x1 = Math.min(width - 1, Math.ceil(sub[2] * iw + 0.5 + margin))
  const y0 = Math.max(0, Math.floor(sub[1] * ih + 0.5 - margin))
  const y1 = Math.min(height - 1, Math.ceil(sub[3] * ih + 0.5 + margin))
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) out.set(data.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w)
  return {
    data: out,
    width: w,
    height: h,
    scale: 1 / (sub[2] - sub[0]),
    offsetX: sub[0] * iw + 0.5 - x0,
    offsetY: sub[1] * ih + 0.5 - y0,
    minX: 0,
    maxX: w - 1,
    minY: 0,
    maxY: h - 1,
  }
}

/** Latitude (radians) of normalized Mercator v (the library's EPSG:3857). */
export function mercatorLatitude(v: number): number {
  return 2 * Math.atan(Math.exp((2 * v - 1) * Math.PI)) - Math.PI / 2
}

/**
 * The step distances (grid texels, nearest first) a row with
 * `metresPerTexel` searches: geometric down from the reach to the first
 * step, so every grid's steps but its first fall at the same distances in
 * metres (the same ridge is found, or missed, alike on every level of
 * detail), then the first step itself. At least the reach.
 */
export function tileHorizonSteps(metresPerTexel: number): number[] {
  const steps: number[] = []
  for (let d = TILE_HORIZON_REACH_METRES / metresPerTexel; d >= TILE_HORIZON_FIRST_TEXELS || !steps.length; d /= TILE_HORIZON_STEP_RATIO) steps.push(d)
  if (steps[steps.length - 1] > TILE_HORIZON_FIRST_TEXELS * 1.05) steps.push(TILE_HORIZON_FIRST_TEXELS)
  return steps.reverse()
}

const isFlat = (data: Float32Array) => {
  const v = data[0]
  for (let i = 1; i < data.length; i++) if (data[i] !== v) return false
  return true
}

/**
 * Heights along a row of grid coordinates (x0 + a * dx, y) for a = 0 ..
 * out.length - 1, each from the finest source holding it (bilinear), NaN
 * where none does. Per source, the row's points inside it are one run of
 * a, so each source fills what the finer ones left in a tight loop.
 */
function sampleRow(sources: readonly HorizonSource[], x0: number, dx: number, y: number, out: Float64Array): void {
  const count = out.length
  out.fill(NaN)
  // the runs [lo, hi) still to fill
  let runs: number[] = [0, count]
  for (const s of sources) {
    if (!runs.length) break
    const inv = 1 / s.scale
    const ly = y * inv + s.offsetY
    if (ly < s.minY || ly > s.maxY) continue
    // a's whose lx = (x0 + a dx) inv + offsetX lies in [minX, maxX]
    const lx0 = x0 * inv + s.offsetX
    const ldx = dx * inv
    const lo = Math.max(0, Math.ceil((s.minX - lx0) / ldx - 1e-9))
    const hi = Math.min(count, Math.floor((s.maxX - lx0) / ldx + 1e-9) + 1)
    if (lo >= hi) continue
    let y0 = Math.floor(ly)
    if (y0 > s.maxY - 1) y0 = s.maxY - 1
    if (y0 < s.minY) y0 = s.minY
    const ty = ly - y0
    const w = s.width
    const d = s.data
    const row0 = y0 * w
    const row1 = s.maxY > s.minY ? row0 + w : row0
    const xMax = s.maxX - 1
    const step = s.maxX > s.minX ? 1 : 0
    const next: number[] = []
    for (let r = 0; r < runs.length; r += 2) {
      const a0 = Math.max(runs[r], lo)
      const a1 = Math.min(runs[r + 1], hi)
      if (a0 >= a1) {
        next.push(runs[r], runs[r + 1])
        continue
      }
      if (runs[r] < a0) next.push(runs[r], a0)
      if (a1 < runs[r + 1]) next.push(a1, runs[r + 1])
      for (let a = a0; a < a1; a++) {
        const lx = lx0 + a * ldx
        let x = Math.floor(lx)
        if (x > xMax) x = xMax
        if (x < s.minX) x = s.minX
        const tx = lx - x
        const h0 = d[row0 + x] + (d[row0 + x + step] - d[row0 + x]) * tx
        const h1 = d[row1 + x] + (d[row1 + x + step] - d[row1 + x]) * tx
        out[a] = h0 + (h1 - h0) * ty
      }
    }
    runs = next
  }
}

/**
 * The grid's horizon map (the header above): `grid` the decoded grid, or
 * null to read the context alone (a grid resampled from its ancestor, which
 * is then the context's first window). Null when it would hold no horizon
 * at all: a grid all at sea level (open water), or everywhere flat.
 */
export function bakeTileHorizon(job: HorizonJob, grid: PaddedGrid | null): Uint8Array<ArrayBuffer> | null {
  if (grid && grid.data.length > 1 && isFlat(grid.data) && grid.data[0] === 0) return null
  const sources = grid ? [gridSource(grid), ...job.context] : job.context
  if (!sources.length) return null
  const n = job.tileSize
  const padded = n + 2
  const size = tileHorizonSize(n)
  const out = new Uint8Array(size * size * TILE_HORIZON_DIRECTIONS)
  const dirX = new Float64Array(TILE_HORIZON_DIRECTIONS)
  const dirY = new Float64Array(TILE_HORIZON_DIRECTIONS)
  for (let d = 0; d < TILE_HORIZON_DIRECTIONS; d++) {
    const az = (2 * Math.PI * d) / TILE_HORIZON_DIRECTIONS
    dirX[d] = Math.sin(az)
    dirY[d] = Math.cos(az)
  }
  // Horizon texel a's centre in grid coordinates: gx = a * span + first.
  const span = padded / size
  const first = 0.5 * span - 1
  const base = new Float64Array(size)
  const heights = new Float64Array(size)
  const best = new Float64Array(size)
  const layerBytes = size * size * 4
  let any = false
  for (let b = 0; b < size; b++) {
    const gy = (b + 0.5) * span - 1
    const lat = mercatorLatitude(job.south + (gy / n) * (job.north - job.south))
    const metres = (2 * Math.PI * TILE_HORIZON_RADIUS * Math.cos(lat) * (job.north - job.south)) / n
    const steps = tileHorizonSteps(metres)
    sampleRow(sources, first, span, gy, base)
    for (let d = 0; d < TILE_HORIZON_DIRECTIONS; d++) {
      best.fill(0)
      for (const step of steps) {
        const dist = step * metres
        const drop = dist / (2 * TILE_HORIZON_RADIUS)
        const invDist = 1 / dist
        sampleRow(sources, first + dirX[d] * step, span, gy + dirY[d] * step, heights)
        for (let a = 0; a < size; a++) {
          // NaN (no data there, or none here) never wins
          const t = (heights[a] - base[a]) * invDist - drop
          if (t > best[a]) best[a] = t
        }
      }
      const at = Math.floor(d / 4) * layerBytes + b * size * 4 + (d % 4)
      for (let a = 0; a < size; a++) {
        const code = tileHorizonCode(best[a])
        out[at + a * 4] = code
        if (code) any = true
      }
    }
  }
  return any ? out : null
}
