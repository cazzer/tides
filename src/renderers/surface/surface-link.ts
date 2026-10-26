// What the globe hands the streamed tiles: everything the tiles' material
// composer (tile-material.ts, tides-zmw.9.16) needs to lay the globe's own
// patches on them. tides-zmw.9.7 handed over the ground haze alone; the
// link now carries the haze and its frame, the Sun, the clouds, the eclipse,
// the night flight, the GIBS patches and the globe's maps and horizon, all as
// the globe's own objects (shared uniforms and textures: nothing is copied
// and the tiles take no extra VRAM). EarthRenderer fills their values for
// each camera (or each frame) as it does for the globe. Keyed by the scene
// both are drawn in: every drei View portals its own scene with its own
// EarthRenderer, and the tiles must read the link their own View's camera
// fills. Kept out of both components (and of the lazy surface chunk) so
// neither imports the other; types only.
import type * as THREE from 'three'
import type { CloudLayer } from '../cloudShaders'
import type { EarthHorizonUniforms } from '../earthHorizonTexture'
import type { MaterialPatch } from '../eclipseShadow'
import type { GroundHaze } from '../groundHaze'
import type { NightFlightUniforms } from '../nightLights'

/** A streamed globe patch (gibsStream.ts StreamedPatch) as the link hands it. */
export interface GlobeStream {
  patch: MaterialPatch
  /** By GLSL name; empty where the device takes no patch. */
  uniforms: Record<string, THREE.IUniform>
  /** Tiles a side; 0 for none. */
  side: number
}

/** The globe's side of the tiles' patches, published by EarthRenderer. */
export interface GlobeLink {
  /** The ground haze (its surfacePatch) and its frame (`haze.frame`, view
   * space to the ground mesh's frame, filled per camera). */
  haze: GroundHaze
  /** The Sun's direction in the ground mesh's frame (the clouds' uSunDir),
   * set per camera before anything draws. */
  sunDir: THREE.IUniform<THREE.Vector3>
  /** The cloud layer's shared uniforms, and whether its shell is the low
   * tier's (flat). */
  clouds: { uniforms: CloudLayer['uniforms']; flat: boolean }
  /** The Moon's shadow (eclipseShadow.ts createEclipseShadow's uniforms). */
  eclipse: Record<string, THREE.IUniform>
  /** The night fill and moonlight (nightLights.ts), updated per camera
   * before anything draws while the tiles are on; null outside ship mode. */
  nightFlight: NightFlightUniforms | null
  /** The streamed GIBS patches (day imagery and night lights): each as
   * composed onto the globe, and its uniforms by GLSL name (the stream's
   * texture, mask, origin, active; the day's warp field) and side, for the
   * tiles to reuse its exported GLSL (GIBS_GLSL, GIBS_NIGHT_GLSL) by text. */
  gibs: GlobeStream
  gibsNight: GlobeStream
  /** The globe's maps as uniforms (day colour, specular (water) mask, city
   * lights): bind them to the GLSL, never to a material slot, which
   * TilesRenderer disposes with each tile (tile-material.ts). EarthRenderer
   * keeps their values current, so the link stays the same object. */
  maps: { day: THREE.IUniform<THREE.Texture>; specular: THREE.IUniform<THREE.Texture>; night: THREE.IUniform<THREE.Texture> }
  /** The globe's horizon map for its terrain shadows (groundShadow.ts). */
  horizon: EarthHorizonUniforms
  /** The ground sphere's radius, scene units. */
  seaLevel: number
}

type Listener = () => void

const links = new Map<THREE.Object3D, GlobeLink>()
const listeners = new Set<Listener>()

/** EarthRenderer: publishes `link` for `scene` (null withdraws it). */
export function setSurfaceLink(scene: THREE.Object3D, link: GlobeLink | null): void {
  if (link) links.set(scene, link)
  else links.delete(scene)
  listeners.forEach((listener) => listener())
}

/** The link published for `scene`, or null. */
export function surfaceLink(scene: THREE.Object3D): GlobeLink | null {
  return links.get(scene) ?? null
}

/** Calls `listener` on every change; returns the unsubscribe. */
export function subscribeSurfaceLink(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
