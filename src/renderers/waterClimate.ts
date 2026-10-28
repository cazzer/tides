// The sea's wave climate (tides-d9f.5) on the GPU: the asset baked by
// scripts/build-wave-climate.mjs as a texture, and its lookup in GLSL. The
// layout, encoding and the scales the water takes from it are
// ./waterClimateLayout.ts's.
import * as THREE from 'three'
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

const f = (x: number) => x.toFixed(6)

/** The texture's lookup: waterClimateAt(up) is the raw texel at a local unit
 * direction, waterClimateDecode() its wind-wave and swell heights (m) and
 * doubled-angle axis (cos 2θ, sin 2θ; θ clockwise from north toward east);
 * waterMssScale() and waterSwellScale() the scales of those heights. */
export const WATER_CLIMATE_GLSL = /* glsl */ `
uniform sampler2D uWaterClimate;

// climateUv() (./waterClimate.ts): v = 0 at the north, the asset's first row.
vec4 waterClimateAt(vec3 up) {
  float u = atan(up.z, -up.x) / 6.283185307179586;
  float v = 0.5 - asin(clamp(up.y, -1.0, 1.0)) / 3.141592653589793;
  // No mipmaps, and fract(u) jumps at the antimeridian: no derivatives.
  return textureLod(uWaterClimate, vec2(fract(u), v), 0.0);
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
