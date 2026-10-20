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
