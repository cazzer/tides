// The flight-only high-res maps (tides-01v.6): KTX2 (Basis ETC1S and UASTC)
// builds of the planets' maps, made by scripts/build-flight-textures.sh and
// fetched only in ship mode as the ship nears each body. Until one arrives,
// and wherever it can't load, the planet keeps its 2k map. Earth's clouds
// stay 2k: the cloud march, tuned to that map, terraces sharper ones.
import type * as THREE from 'three'

export const FLIGHT_TEXTURE_KEYS = ['mars', 'mercury', 'jupiter', 'saturn', 'venus'] as const
export type FlightTextureKey = (typeof FLIGHT_TEXTURE_KEYS)[number]

const URLS = import.meta.glob<string>('./assets/flight/*.ktx2', {
  eager: true,
  query: '?url',
  import: 'default',
})

/** The widest map for `key` no wider than `cap`. Jupiter, Saturn and Venus
 * have only 4k sources. */
export function flightTextureUrl(key: FlightTextureKey, cap: 8192 | 4096): string | undefined {
  return (cap >= 8192 && URLS[`./assets/flight/${key}-8k.ktx2`]) || URLS[`./assets/flight/${key}-4k.ktx2`]
}

/**
 * How near, in the body's radii from its surface, the ship fetches its map.
 * At 40 R the body is a ~50 px disc on a 1080p screen, a couple of seconds
 * out at approach speed: time to fetch and transcode before it fills the view.
 */
export const FLIGHT_TEXTURE_RANGE = 40

export function inFlightTextureRange(surfaceGap: number, radius: number): boolean {
  return surfaceGap < FLIGHT_TEXTURE_RANGE * radius
}

/**
 * Whether KTX2Loader's pick for these maps will upload as sRGB here. It
 * prefers BC7, then ETC2, ETC1, BC1/BC3 (ASTC first, for UASTC), and last
 * plain RGBA (178 MB at 8k, worse than the JPEG it replaces). three uploads
 * sRGB ETC1 only through the ETC2 extension and sRGB BC1/BC3 only with the
 * s3tc_srgb one, so those fall back to the 2k map.
 */
export function canUseFlightTextures(has: (extension: string) => boolean): boolean {
  if (has('EXT_texture_compression_bptc') || has('WEBGL_compressed_texture_etc')) return true
  if (has('WEBGL_compressed_texture_etc1')) return false
  return has('WEBGL_compressed_texture_s3tc') && has('WEBGL_compressed_texture_s3tc_srgb')
}

export interface FlightTextureCache {
  /** The texture at `url`, loaded once; null if it failed or was released. */
  request(url: string): Promise<THREE.Texture | null>
  /** Disposes every texture, including any still loading when it lands. */
  release(): void
}

/** `load` gets whether its request still stands, to skip work for a
 * released cache (the texture it returns is then disposed). */
export function createFlightTextureCache(
  load: (url: string, isCurrent: () => boolean) => Promise<THREE.Texture>
): FlightTextureCache {
  let entries = new Map<string, Promise<THREE.Texture | null>>()
  let generation = 0
  return {
    request(url) {
      let entry = entries.get(url)
      if (!entry) {
        const requestedIn = generation
        entry = load(url, () => requestedIn === generation).then(
          (texture) => {
            if (requestedIn === generation) return texture
            texture.dispose()
            return null
          },
          (err: unknown) => {
            // After a release the loader may be gone mid-load: expected.
            if (requestedIn === generation) console.warn(`Flight texture ${url} failed to load; keeping the 2k map`, err)
            return null
          }
        )
        entries.set(url, entry)
      }
      return entry
    },
    release() {
      generation++
      const released = entries
      entries = new Map()
      for (const entry of released.values()) void entry.then((texture) => texture?.dispose())
    },
  }
}
