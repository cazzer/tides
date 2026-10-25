// Earth's elevation map on the GPU (tides-zmw.1): a shipped DEM file
// (../earth-dem.ts) as one-channel half-float textures in displacement units
// (1 = TERRAIN_DISPLACEMENT). R16F filters in core WebGL2; its steps are 3–6 m
// near the highest ground, against the old 8-bit bump map's 25 m.
//
// Two textures share one set of mips (tides-zmw.2): `relief`, the whole map,
// for the ground's shading (groundRelief.ts), and `ground`, its mips from the
// limb sphere's width down, the drawn ground: the mesh's displacement
// (groundDisplacement.ts) and the cloud march's ground. A vertex read from
// the full map aliases peaks into one-vertex needles: the vertices sit 8–32
// texels apart.
//
// The mips are built here as box means: the GPU can't generate them for a
// half-float texture without EXT_color_buffer_float. Rows go up south first,
// so with flipY off the texture reads as the flipY'd bump image did (v = 1
// north), as SphereGeometry's uvs and cloudShaders.ts' ground reads expect.
import * as THREE from 'three'
import { boxMips, decodeEarthDem, demLevel, toHalfBits, type DemLevel, type EarthDem } from '../earth-dem'
import { LIMB_SEGMENTS } from '../ship/limb-detail'

/** The DEM's textures (see the header). */
export interface EarthDemTextures {
  relief: THREE.DataTexture
  ground: THREE.DataTexture
}

/** `level`'s heights as half floats, rows flipped to south first. */
function halfRowsSouthFirst({ width, height, data }: DemLevel): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width
    for (let x = 0; x < width; x++) out[y * width + x] = toHalfBits(data[from + x])
  }
  return out
}

interface HalfLevel {
  data: Uint16Array<ArrayBuffer>
  width: number
  height: number
}

function heightTexture(mipmaps: HalfLevel[]): THREE.DataTexture {
  const [base] = mipmaps
  const texture = new THREE.DataTexture(base.data, base.width, base.height, THREE.RedFormat, THREE.HalfFloatType)
  texture.mipmaps = mipmaps
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  // Longitude wraps: fract() in the shaders wraps a read's coordinate, not
  // its bilinear footprint, so a clamped map would read column 0 at u = 0
  // and column 4095 at u = 1 (hundreds of metres apart in places), cracking
  // the sphere's seam vertices and stepping the cloud base at 180°. Repeat
  // blends the two there instead.
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.NoColorSpace
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

const halfLevel = (level: DemLevel): HalfLevel => ({
  data: halfRowsSouthFirst(level),
  width: level.width,
  height: level.height,
})

/**
 * The DEM as mipmapped height textures. Throws on a DEM with no level the
 * limb sphere's width: the ground, the cloud march's ground mirror and the
 * terrain floor all assume one.
 */
export function earthDemTextures(dem: EarthDem): EarthDemTextures {
  const mipmaps = boxMips(demLevel(dem)).map(halfLevel)
  const ground = mipmaps.findIndex(({ width, height }) => width === LIMB_SEGMENTS[0] && height === LIMB_SEGMENTS[1])
  if (ground < 0) throw new Error(`Earth DEM ${dem.width}×${dem.height} has no ${LIMB_SEGMENTS.join('×')} level`)
  return { relief: heightTexture(mipmaps), ground: heightTexture(mipmaps.slice(ground)) }
}

/** Sea level everywhere: what the ground shows if the DEM can't be read. */
export function flatDemTextures(): EarthDemTextures {
  const level = () => [halfLevel({ width: 1, height: 1, data: new Float32Array(1) })]
  return { relief: heightTexture(level()), ground: heightTexture(level()) }
}

/**
 * Loads a DEM file into earthDemTextures' textures, for useLoader (which
 * suspends on it). A file that won't decode (DecompressionStream needs
 * Safari 16.4) warns and gives flatDemTextures': a flat Earth, not a broken
 * scene. A failed fetch is an error, as for the other maps.
 */
export class EarthDemLoader extends THREE.Loader<EarthDemTextures> {
  load(
    url: string,
    onLoad: (textures: EarthDemTextures) => void,
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
          .then(earthDemTextures, (error: unknown) => {
            console.warn(`Earth elevation map ${url} failed to decode; drawing the ground flat.`, error)
            return flatDemTextures()
          })
          .then(onLoad)
          .catch((error: unknown) => {
            onError?.(error)
            this.manager.itemError(url)
          })
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
