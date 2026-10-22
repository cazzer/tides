// Texture loading for the planets (PlanetRenderer.tsx and the per-planet
// files). The loaders share their own LoadingManager: planet textures load
// only once the planets are switched on, and must not drive the app's
// loading overlay (useProgress watches THREE.DefaultLoadingManager).
import { useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'

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
}

/**
 * Loads textures, null where a url is undefined. Suspends while they load.
 * At least one url must be given: an empty load still suspends for a tick,
 * which would blink the mesh, so untextured components skip this hook.
 */
export function usePlanetTextures(
  urls: readonly (string | undefined)[],
  { color = true }: PlanetTextureOptions = {}
): (THREE.Texture | null)[] {
  const defined = urls.filter((url): url is string => url !== undefined)
  if (defined.length === 0) throw new Error('usePlanetTextures needs a url')
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const loaded = useLoader(
    color ? colorTextureLoader : dataTextureLoader,
    defined,
    (loader) => {
      loader.anisotropy = maxAnisotropy
    }
  )
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
export function loadColorTexture(
  url: string,
  anisotropy: number,
  onLoad: (texture: THREE.Texture) => void,
  onError: (err: unknown) => void
): void {
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
