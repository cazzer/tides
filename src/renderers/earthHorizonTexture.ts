// Earth's horizon map on the GPU (tides-zmw.4): a shipped horizon file
// (../earth-horizon.ts) as a two-layer RGBA8 array texture, layer 0 holding
// directions N, NE, E, SE and layer 1 S, SW, W, NW, so the shader reads all
// eight with one sampler and two taps. RGBA8 lets the GPU build the mips.
// Rows go up south first (v = 1 north), as the elevation map's
// (./earthDemTexture.ts), and longitude wraps.
//
// Nothing waits for it: the ground starts on a blank map (no shadows, full
// sky) and takes the real one when the file arrives, by swapping the shared
// uniform's value, so first paint never waits on the download.
import * as THREE from 'three'
import { decodeEarthHorizon, type EarthHorizon } from '../earth-horizon'

/** What ./groundShadow.ts reads: the map, and how to read it. */
export interface EarthHorizonUniforms {
  map: THREE.IUniform<THREE.DataArrayTexture>
  /** x: radians per unit the texture reads; y: the map's exaggeration (eRef). */
  code: THREE.IUniform<THREE.Vector2>
}

const LAYERS = 2
const CHANNELS = 4

/** `horizon` as the array texture, mipmapped. */
export function earthHorizonTexture({ width, height, directions, angles }: EarthHorizon): THREE.DataArrayTexture {
  if (directions !== LAYERS * CHANNELS) throw new Error(`Earth horizon: ${directions} directions, expected 8`)
  const n = width * height
  const data = new Uint8Array(n * directions)
  for (let d = 0; d < directions; d++) {
    const layer = Math.floor(d / CHANNELS) * n * CHANNELS
    for (let y = 0; y < height; y++) {
      const from = d * n + (height - 1 - y) * width
      const to = layer + y * width * CHANNELS + (d % CHANNELS)
      for (let x = 0; x < width; x++) data[to + x * CHANNELS] = angles[from + x]
    }
  }
  return arrayTexture(data, width, height, true)
}

/** No horizon anywhere: what the ground shows until the map arrives. */
export function blankHorizonTexture(): THREE.DataArrayTexture {
  return arrayTexture(new Uint8Array(LAYERS * CHANNELS), 1, 1, false)
}

function arrayTexture(data: Uint8Array<ArrayBuffer>, width: number, height: number, mipmaps: boolean): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(data, width, height, LAYERS)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  texture.generateMipmaps = mipmaps
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // As the elevation map's: a clamped map would step at 180°.
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.NoColorSpace
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

/** The uniforms' code for `horizon`. */
function horizonCode({ bits, eRef }: Pick<EarthHorizon, 'bits' | 'eRef'>): THREE.Vector2 {
  return new THREE.Vector2((255 / ((1 << bits) - 1)) * (Math.PI / 2), eRef)
}

const shared = new Map<string, EarthHorizonUniforms>()

/**
 * The horizon map at `url`, shared by every ground that asks: blank at
 * first, then (in a browser) the file's once it has loaded. A file that
 * won't load or decode warns and leaves the ground unshadowed.
 */
export function earthHorizon(url: string): EarthHorizonUniforms {
  let uniforms = shared.get(url)
  if (uniforms) return uniforms
  uniforms = { map: { value: blankHorizonTexture() }, code: { value: horizonCode({ bits: 8, eRef: 1 }) } }
  shared.set(url, uniforms)
  if (typeof window !== 'undefined') void loadInto(url, uniforms)
  return uniforms
}

async function loadInto(url: string, uniforms: EarthHorizonUniforms): Promise<void> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const horizon = await decodeEarthHorizon(await response.arrayBuffer())
    const blank = uniforms.map.value
    uniforms.map.value = earthHorizonTexture(horizon)
    uniforms.code.value = horizonCode(horizon)
    blank.dispose()
  } catch (error: unknown) {
    console.warn(`Earth horizon map ${url} failed to load; the ground is drawn without terrain shadows.`, error)
  }
}
