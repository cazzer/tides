// Texture loading for the planets (PlanetRenderer.tsx and the per-planet
// files). The loaders share their own LoadingManager: planet textures load
// only once the planets are switched on, and must not drive the app's
// loading overlay (useProgress watches THREE.DefaultLoadingManager).
import { useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { canUseCompressedBodyMaps } from '../body-maps'

// Sets the colour space and anisotropy on arrival: textures passed as
// shader uniforms aren't tagged the way R3F tags material maps.
class PlanetTextureLoader extends THREE.TextureLoader {
  readonly colorSpace: THREE.ColorSpace
  anisotropy = 1

  constructor(colorSpace: THREE.ColorSpace, manager: THREE.LoadingManager) {
    super(manager)
    this.colorSpace = colorSpace
  }

  load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): THREE.Texture {
    return super.load(
      url,
      (texture) => {
        texture.colorSpace = this.colorSpace
        texture.anisotropy = this.anisotropy
        onLoad?.(texture)
      },
      onProgress,
      onError
    )
  }
}

const manager = new THREE.LoadingManager()
/** Colour images (surface maps, ring colour + alpha): decoded from sRGB. */
const colorTextureLoader = new PlanetTextureLoader(THREE.SRGBColorSpace, manager)
/** Data images (bump, alpha-only or other non-colour maps): used as stored. */
const dataTextureLoader = new PlanetTextureLoader(THREE.NoColorSpace, manager)

export interface PlanetTextureOptions {
  /** False for non-colour data. Default true. */
  color?: boolean
  /**
   * Colour maps only: each url's GPU-compressed KTX2 sibling, if it has one
   * (body-maps.ts), loaded in its place where the browser takes it.
   */
  compressed?: readonly (string | undefined)[]
}

/** Loads a JPEG (or PNG) colour map: `onLoad` gets it tagged sRGB. */
export type ColorMapLoad = (
  url: string,
  anisotropy: number,
  onLoad: (texture: THREE.Texture) => void,
  onError: (err: unknown) => void
) => void

/** Loads a KTX2 map, rejecting where it can't. */
export type CompressedMapLoad = (url: string, gl: THREE.WebGLRenderer) => Promise<THREE.Texture>

let bodyKtx2: Promise<import('three/examples/jsm/loaders/KTX2Loader.js').KTX2Loader> | null = null

// The loader and its transcoder are fetched with the first map that needs
// them; a failed fetch is tried again by the next map.
const loadBodyKtx2: CompressedMapLoad = async (url, gl) => {
  bodyKtx2 ??= import('./ktx2Loader').then(
    (m) => m.getKtx2Loader(gl),
    (err: unknown) => {
      bodyKtx2 = null
      throw err
    }
  )
  return (await bodyKtx2).loadAsync(url)
}

/**
 * Colour maps by url (tides-0oi.14): a url with a KTX2 sibling (`ktx2For`)
 * loads that where `gl` takes one of its GPU formats
 * (canUseCompressedBodyMaps), the url itself everywhere else and wherever
 * the KTX2 fails. `gl` and `anisotropy` are set before each load (useLoader's
 * extensions, as PlanetTextureLoader's anisotropy is).
 */
export class BodyMapLoader extends THREE.Loader<THREE.Texture> {
  anisotropy = 1
  gl: THREE.WebGLRenderer | null = null
  readonly ktx2For = new Map<string, string>()

  constructor(
    private readonly loadColor: ColorMapLoad,
    private readonly loadCompressed: CompressedMapLoad = loadBodyKtx2
  ) {
    super()
  }

  load(
    url: string,
    onLoad: (texture: THREE.Texture) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): void {
    const { anisotropy, gl } = this
    const ktx2 = this.ktx2For.get(url)
    const fallBack = () => this.loadColor(url, anisotropy, onLoad, (err) => onError?.(err))
    if (!ktx2 || !gl || !canUseCompressedBodyMaps((ext) => gl.extensions.has(ext))) {
      fallBack()
      return
    }
    this.loadCompressed(ktx2, gl).then(
      (texture) => {
        // Its url, which a compressed texture otherwise doesn't keep (debugging, the perf-audit harness).
        texture.name = ktx2
        texture.anisotropy = anisotropy
        onLoad(texture)
      },
      (err: unknown) => {
        console.warn(`Compressed map ${ktx2} failed to load; using ${url}`, err)
        fallBack()
      }
    )
  }
}

const bodyMapLoader = new BodyMapLoader((url, anisotropy, onLoad, onError) => {
  colorTextureLoader.anisotropy = anisotropy
  colorTextureLoader.load(url, onLoad, undefined, onError)
})

/**
 * Loads textures, null where a url is undefined. Suspends while they load.
 * At least one url must be given: an empty load still suspends for a tick,
 * which would blink the mesh, so untextured components skip this hook.
 */
export function usePlanetTextures(
  urls: readonly (string | undefined)[],
  { color = true, compressed }: PlanetTextureOptions = {}
): (THREE.Texture | null)[] {
  const defined = urls.filter((url): url is string => url !== undefined)
  if (defined.length === 0) throw new Error('usePlanetTextures needs a url')
  compressed?.forEach((ktx2, i) => {
    const url = urls[i]
    if (ktx2 && url) bodyMapLoader.ktx2For.set(url, ktx2)
  })
  const gl = useThree((s) => s.gl)
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const loaded = useLoader(color ? bodyMapLoader : dataTextureLoader, defined, (loader) => {
    loader.anisotropy = maxAnisotropy
    if (loader instanceof BodyMapLoader) loader.gl = gl
  })
  return urls.map((url) => (url === undefined ? null : loaded[defined.indexOf(url)]))
}

// Decodes off the main thread, flipped as TextureLoader's images are on
// upload (three never flips an ImageBitmap), so the frame a moon's map
// arrives in only uploads it (tides-2hv.18). Safari before 17 and Firefox
// before 98 mishandle createImageBitmap's options, so they keep the image
// path, as three's GLTFLoader does. The bitmaps stay open: three
// re-uploads from them after a lost context.
const bitmapLoader =
  typeof createImageBitmap !== 'undefined' && canFlipBitmaps(navigator.userAgent)
    ? new THREE.ImageBitmapLoader(manager)
    : null
bitmapLoader?.setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' })

/** Whether this browser applies createImageBitmap's flip. */
export function canFlipBitmaps(ua: string): boolean {
  if (/^((?!chrome|android).)*safari/i.test(ua)) return Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0) >= 17
  const firefox = ua.match(/Firefox\/(\d+)/)
  return !firefox || Number(firefox[1]) >= 98
}

/**
 * Loads a colour texture without suspending, for maps that may arrive after
 * the body first shows (the moons, MoonBodies). Like usePlanetTextures, it
 * stays off the app's loading overlay.
 */
export const loadColorTexture: ColorMapLoad = (url, anisotropy, onLoad, onError) => {
  if (!bitmapLoader) {
    colorTextureLoader.anisotropy = anisotropy
    colorTextureLoader.load(url, onLoad, undefined, onError)
    return
  }
  bitmapLoader.load(
    url,
    (bitmap) => {
      const texture = new THREE.Texture(bitmap)
      texture.flipY = false
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = anisotropy
      texture.needsUpdate = true
      onLoad(texture)
    },
    undefined,
    onError
  )
}

const moonMapLoader = new BodyMapLoader(loadColorTexture)

/**
 * loadColorTexture for a body map with a KTX2 sibling (`ktx2Url`), which
 * it loads instead where `gl` takes it (BodyMapLoader).
 */
export function loadBodyMap(
  jpegUrl: string,
  ktx2Url: string | undefined,
  gl: THREE.WebGLRenderer,
  anisotropy: number,
  onLoad: (texture: THREE.Texture) => void,
  onError: (err: unknown) => void
): void {
  if (ktx2Url) moonMapLoader.ktx2For.set(jpegUrl, ktx2Url)
  moonMapLoader.gl = gl
  moonMapLoader.anisotropy = anisotropy
  moonMapLoader.load(jpegUrl, onLoad, undefined, onError)
}
