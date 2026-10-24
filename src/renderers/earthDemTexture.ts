// Earth's elevation map on the GPU (tides-zmw.1): a shipped DEM file
// (../earth-dem.ts) as a one-channel half-float texture in displacement units
// (1 = TERRAIN_DISPLACEMENT), the ground's displacement and relief map and the
// cloud march's ground. R16F filters in core WebGL2; its steps are 3–6 m near
// the highest ground, against the old 8-bit bump map's 25 m.
//
// The mips are built here as box means: the GPU can't generate them for a
// half-float texture without EXT_color_buffer_float. Rows go up south first,
// so with flipY off the texture reads as the flipY'd bump image did (v = 1
// north), as SphereGeometry's uvs and cloudShaders.ts' ground reads expect.
import * as THREE from 'three'
import { boxMips, decodeEarthDem, demLevel, toHalfBits, type DemLevel, type EarthDem } from '../earth-dem'

/** `level`'s heights as half floats, rows flipped to south first. */
function halfRowsSouthFirst({ width, height, data }: DemLevel): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width
    for (let x = 0; x < width; x++) out[y * width + x] = toHalfBits(data[from + x])
  }
  return out
}

function heightTexture(levels: DemLevel[]): THREE.DataTexture {
  const mipmaps = levels.map((level) => ({
    data: halfRowsSouthFirst(level),
    width: level.width,
    height: level.height,
  }))
  const [base] = mipmaps
  const texture = new THREE.DataTexture(base.data, base.width, base.height, THREE.RedFormat, THREE.HalfFloatType)
  texture.mipmaps = mipmaps
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  // As the bump image had; the shaders wrap longitude themselves (fract).
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.NoColorSpace
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

/** The DEM as a mipmapped height texture. */
export function earthDemTexture(dem: EarthDem): THREE.DataTexture {
  return heightTexture(boxMips(demLevel(dem)))
}

/** Sea level everywhere: what the ground shows if the DEM can't be read. */
export function flatDemTexture(): THREE.DataTexture {
  return heightTexture([{ width: 1, height: 1, data: new Float32Array(1) }])
}

/**
 * Loads a DEM file into earthDemTexture's texture, for useLoader (which
 * suspends on it). A file that won't decode (DecompressionStream needs
 * Safari 16.4) warns and gives flatDemTexture's: a flat Earth, not a broken
 * scene. A failed fetch is an error, as for the other maps.
 */
export class EarthDemLoader extends THREE.Loader<THREE.DataTexture> {
  load(
    url: string,
    onLoad: (texture: THREE.DataTexture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void
  ): void {
    const files = new THREE.FileLoader(this.manager)
    files.setPath(this.path)
    files.setResponseType('arraybuffer')
    files.setRequestHeader(this.requestHeader)
    files.setWithCredentials(this.withCredentials)
    this.manager.itemStart(url)
    files.load(
      url,
      (buffer) => {
        decodeEarthDem(buffer as ArrayBuffer)
          .then(earthDemTexture, (error: unknown) => {
            console.warn(`Earth elevation map ${url} failed to decode; drawing the ground flat.`, error)
            return flatDemTexture()
          })
          .then(onLoad)
          .finally(() => this.manager.itemEnd(url))
      },
      onProgress,
      (error) => {
        onError?.(error)
        this.manager.itemError(url)
        this.manager.itemEnd(url)
      }
    )
  }
}
