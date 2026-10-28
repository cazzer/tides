// The sea's static noise (tides-d9f.5), baked: the Earth-fixed noise the
// water scales its roughness by and bends its swell with (./water.ts) was
// value noise evaluated per pixel, five octaves of it, over half a
// millisecond of the near sea's frame on the high tier. It never moves, so
// it is a texture instead: NOISE_CELLS² cells of tileable value noise, four
// independent channels, smoothstep between the lattice's values as the
// procedural noise had, mipmapped (the mips are each octave's fade with
// distance). It shares one texture array with the wave climate (layer 0
// the climate, layer 1 the noise: ./waterClimate.ts waterSeaTexture()), as
// the tiles' program has no texture unit to spare.
//
// The water reads it on the Mercator plane of longitude and latitude
// (conformal, so a cell stays round; it shrinks with cos(latitude) as the
// plane does), each octave at a whole number of tiles round the equator
// (noiseCellsAround()), so the antimeridian is seamless.

/** The noise layer's size (texels, square) and its cells across. */
export const NOISE_SIZE = 512
export const NOISE_CELLS = 64
export const NOISE_CELL_TEXELS = NOISE_SIZE / NOISE_CELLS

// mulberry32: a small seeded PRNG, so every build bakes the same noise.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** The noise layer: NOISE_SIZE² RGBA8, each channel value noise on its own
 * NOISE_CELLS² lattice (wrapping, so the layer tiles), sampled at texel
 * centres. A byte b reads as 2 b / 255 - 1. */
export function bakeWaterNoise(seed = 0x5ea5ea): Uint8Array {
  const rand = mulberry32(seed)
  const lattice = Array.from({ length: 4 }, () => Float32Array.from({ length: NOISE_CELLS * NOISE_CELLS }, rand))
  const out = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4)
  const at = (c: Float32Array, i: number, j: number) => c[(j % NOISE_CELLS) * NOISE_CELLS + (i % NOISE_CELLS)]
  for (let y = 0; y < NOISE_SIZE; y++) {
    const fy = (y + 0.5) / NOISE_CELL_TEXELS
    const j = Math.floor(fy)
    const ty = smooth(fy - j)
    for (let x = 0; x < NOISE_SIZE; x++) {
      const fx = (x + 0.5) / NOISE_CELL_TEXELS
      const i = Math.floor(fx)
      const tx = smooth(fx - i)
      for (let k = 0; k < 4; k++) {
        const c = lattice[k]
        const a = at(c, i, j) + (at(c, i + 1, j) - at(c, i, j)) * tx
        const b = at(c, i, j + 1) + (at(c, i + 1, j + 1) - at(c, i, j + 1)) * tx
        out[(y * NOISE_SIZE + x) * 4 + k] = Math.round(255 * (a + (b - a) * ty))
      }
    }
  }
  return out
}

/** An octave of `km` cells' count round the equator: the nearest whole
 * number of tiles (NOISE_CELLS each) to the circumference over `km`. */
export function noiseCellsAround(km: number, radiusKm: number): number {
  return NOISE_CELLS * Math.max(1, Math.round((2 * Math.PI * radiusKm) / km / NOISE_CELLS))
}

/** The Mercator plane's coordinates (radians) of a longitude and latitude
 * (radians), the latitude held short of the poles as the GLSL holds it. */
export function noiseMercator(lon: number, lat: number): [number, number] {
  const held = Math.max(-NOISE_LAT_MAX, Math.min(NOISE_LAT_MAX, lat))
  return [lon, Math.log(Math.tan(Math.PI / 4 + held / 2))]
}

/** The latitude (radians) the noise's plane stops at: 85 deg. */
export const NOISE_LAT_MAX = (85 * Math.PI) / 180
