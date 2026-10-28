// The sea's wave climate (tides-d9f.5) on the GPU: the asset baked by
// scripts/build-wave-climate.mjs as a texture, and its lookup in GLSL. The
// layout, encoding and the scales the water takes from it are
// ./waterClimateLayout.ts's. It shares one texture array with the sea's
// baked noise (./waterNoise.ts): the tiles' program has no unit to spare.
import * as THREE from 'three'
import { bakeWaterNoise, NOISE_CELLS, NOISE_SIZE } from './waterNoise'
import climateUrl from '../assets/earth-wave-climate.bin?url&inline'
import { CLIMATE_BYTES, CLIMATE_COLS, CLIMATE_ROWS, coxMunkMss, GRAVITY, SWELL_MAX_M, SWELL_REF_M, WIND_WAVE_MAX_M, WIND_WAVE_REF_M } from './waterClimateLayout'

export * from './waterClimateLayout'

let texture: THREE.DataTexture | null = null

/** The asset as a texture for waterClimateAt(): one for the page, made on
 * first use. */
export function climateTexture(): THREE.DataTexture {
  texture ??= makeClimateTexture()
  return texture
}

function makeClimateTexture(): THREE.DataTexture {
  const rgba = Uint8Array.from(atob(climateUrl.slice(climateUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
  if (rgba.length !== CLIMATE_BYTES) {
    throw new Error(`wave climate: ${rgba.length} bytes, expected ${CLIMATE_BYTES}`)
  }
  const texture = new THREE.DataTexture(rgba, CLIMATE_COLS, CLIMATE_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.unpackAlignment = 1
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

let sea: THREE.DataArrayTexture | null = null

/** The climate and the noise as one texture array, one for the page: layer
 * 0 the climate in its corner, padded so a bilinear read at level 0 is the
 * climate texture's own (its longitude wraps, its latitude clamps), layer 1
 * the noise. Mipmapped, repeating, for the noise. */
export function waterSeaTexture(): THREE.DataArrayTexture {
  sea ??= makeSeaTexture()
  return sea
}

function makeSeaTexture(): THREE.DataArrayTexture {
  const climate = climateTexture().image.data as Uint8Array
  const layer = NOISE_SIZE * NOISE_SIZE * 4
  const data = new Uint8Array(layer * 2)
  // A climate texel (column wrapped, row clamped) into the layer at (x, y).
  const put = (x: number, y: number, col: number, row: number) => {
    const from = (Math.min(Math.max(row, 0), CLIMATE_ROWS - 1) * CLIMATE_COLS + ((col + CLIMATE_COLS) % CLIMATE_COLS)) * 4
    data.set(climate.subarray(from, from + 4), (y * NOISE_SIZE + x) * 4)
  }
  for (let row = -1; row <= CLIMATE_ROWS; row++) {
    for (let col = -1; col <= CLIMATE_COLS; col++) {
      put((col + NOISE_SIZE) % NOISE_SIZE, (row + NOISE_SIZE) % NOISE_SIZE, col, row)
    }
  }
  data.set(bakeWaterNoise(), layer)
  const texture = new THREE.DataArrayTexture(data, NOISE_SIZE, NOISE_SIZE, 2)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.unpackAlignment = 1
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

const f = (x: number) => x.toFixed(6)

/** The texture's lookup: waterClimateAt(up) is the raw texel at a local unit
 * direction, waterClimateDecode() its wind-wave and swell heights (m) and
 * doubled-angle axis (cos 2θ, sin 2θ; θ clockwise from north toward east);
 * waterMssScale() and waterSwellScale() the scales of those heights. */
export const WATER_CLIMATE_GLSL = /* glsl */ `
uniform sampler2DArray uWaterSea;

// A local direction's longitude (from -180 deg, radians) and latitude.
vec2 waterLonLat(vec3 up) {
  return vec2(atan(up.z, -up.x), asin(clamp(up.y, -1.0, 1.0)));
}

// climateUv() (./waterClimate.ts): v = 0 at the north, the asset's first
// row; in layer 0's corner (waterSeaTexture()), at level 0: fract(u) jumps
// at the antimeridian, so no derivatives.
vec4 waterClimateAt(vec2 lonLat) {
  float u = fract(lonLat.x / 6.283185307179586);
  float v = 0.5 - lonLat.y / 3.141592653589793;
  return textureLod(uWaterSea, vec3(vec2(u * ${f(CLIMATE_COLS)}, v * ${f(CLIMATE_ROWS)}) / ${f(NOISE_SIZE)}, 0.0), 0.0);
}

// The noise (./waterNoise.ts), four channels in -1 to 1, at a point in
// cells and a level.
vec4 waterNoiseAt(vec2 cells, float lod) {
  return textureLod(uWaterSea, vec3(cells / ${f(NOISE_CELLS)}, 1.0), lod) * 2.0 - 1.0;
}

vec4 waterClimateDecode(vec4 texel) {
  return vec4(
    ${f(WIND_WAVE_MAX_M)} * texel.r * texel.r,
    ${f(SWELL_MAX_M)} * texel.a * texel.a,
    texel.gb * 2.0 - 1.0
  );
}

// mssScale() and swellScale() (./waterClimate.ts).
float waterMssScale(float windWaveM) {
  float mss = 0.003 + 0.00512 * sqrt(${f(GRAVITY / 0.21)} * max(windWaveM, 0.0));
  return clamp(mss / ${f(coxMunkMss(WIND_WAVE_REF_M))}, 0.5, 2.0);
}
float waterSwellScale(float swellM) {
  return clamp(swellM / ${f(SWELL_REF_M)}, 0.4, 2.0);
}
`
