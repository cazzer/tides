// Building blocks for the seven planets (tides-kzj.2.4). Each planet's look
// lives in renderers/planets/<Name>.tsx, which composes these inside the
// planet's OrbitingBody: they all sit in the body's frame (+Y the north pole,
// equator in XZ), with no transform of their own.
//
// The scene's directional sunlight is aimed at the Earth (sunlight.ts), which
// is wrong for every other planet, so none of these use scene lights: each
// takes the Sun's direction in the body's frame from its world matrix just
// before it renders, with the Sun at the world origin.
import { useEffect, useMemo } from 'react'
import { useLoader, useThree } from '@react-three/fiber'
import { meshBounds } from '@react-three/drei'
import * as THREE from 'three'
import type { Planet } from '../planets'
import { ringGeometry, sunDirectionLocal } from './planetFrame'
import {
  AMBIENT_COLOR,
  AMBIENT_INTENSITY,
  SUNLIGHT_INTENSITY,
} from '../lighting'
import planetVertex from '../shaders/planet/vertex.glsl'
import planetFragment from '../shaders/planet/fragment.frag'
import ringVertex from '../shaders/ring/vertex.glsl'
import ringFragment from '../shaders/ring/fragment.frag'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'

// Colour textures arrive tagged sRGB (a uniform isn't tagged the way a
// material map is) with the anisotropy set by the last component to use it.
class PlanetTextureLoader extends THREE.TextureLoader {
  anisotropy = 1

  load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): THREE.Texture {
    return super.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        texture.anisotropy = this.anisotropy
        onLoad?.(texture)
      },
      onProgress,
      onError
    )
  }
}

// Its own manager: planet textures load only once the planets are switched
// on, and must not drive the app's loading overlay (useProgress watches
// THREE.DefaultLoadingManager).
const textureLoader = new PlanetTextureLoader(new THREE.LoadingManager())

const AMBIENT = new THREE.Color(AMBIENT_COLOR).multiplyScalar(AMBIENT_INTENSITY)

const noRaycast = () => null

/**
 * A `uSunDir` uniform and the mesh's onBeforeRender that keeps it current,
 * from the mesh's final transform for this frame (three calls it with the
 * mesh as `this`).
 */
function useSunDirection() {
  return useMemo(() => {
    const uniform = { value: new THREE.Vector3(1, 0, 0) }
    function onBeforeRender(this: THREE.Object3D) {
      sunDirectionLocal(this, uniform.value)
    }
    return { uniform, onBeforeRender }
  }, [])
}

function isLowQuality(): boolean {
  if (typeof window === 'undefined') return false
  const quality = new URLSearchParams(window.location.search).get('quality')
  if (quality === 'low') return true
  if (quality === 'high') return false
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
}

const SPHERE_SEGMENTS = isLowQuality() ? 64 : 128

/**
 * Loads a colour texture (or none, for an undefined url) through the planets'
 * own loader. Suspends while it loads.
 */
function usePlanetTexture(url: string | undefined): THREE.Texture | null {
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  // useLoader can't be skipped conditionally; an empty list loads nothing.
  const [texture = null] = useLoader(
    textureLoader,
    url ? [url] : [],
    (loader) => {
      loader.anisotropy = maxAnisotropy
    }
  )
  return texture
}

export interface PlanetSurfaceProps {
  planet: Planet
  /** Equirectangular map, longitude 0 at the centre. Without one the
   * planet is its catalog colour. */
  texture?: string
  /** Scales the texture (or colour) as MOON_ALBEDO does the Moon's. */
  albedo?: number
  /** Minnaert exponent: 1 is Lambert, > 1 darkens the limb. */
  limbDarkening?: number
}

/** The planet's globe: Sun-lit diffuse with the scene's ambient fill. */
export function PlanetSurface({
  planet,
  texture,
  albedo = 1,
  limbDarkening = 1,
}: PlanetSurfaceProps) {
  const map = usePlanetTexture(texture)
  const sun = useSunDirection()
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: planetVertex,
        fragmentShader: planetFragment,
        defines: map ? { USE_PLANET_MAP: '' } : {},
        uniforms: {
          uSunDir: sun.uniform,
          uColor: { value: new THREE.Color(planet.color) },
          uAlbedo: { value: albedo },
          uSunIntensity: { value: SUNLIGHT_INTENSITY },
          uAmbient: { value: AMBIENT },
          uMinnaert: { value: limbDarkening },
          uMap: { value: map },
        },
      }),
    [map, sun.uniform, planet.color, albedo, limbDarkening]
  )
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      material={material}
      raycast={meshBounds}
      onBeforeRender={sun.onBeforeRender}
    >
      <sphereGeometry args={[planet.radius, SPHERE_SEGMENTS, SPHERE_SEGMENTS]} />
    </mesh>
  )
}

export interface PlanetAtmosphereProps {
  planet: Planet
  /** Shell radii and scale height, as fractions of the planet's radius. */
  surface?: number
  outer: number
  scaleHeight: number
  /** Sunlit haze, and the colour it warms to toward the terminator. */
  sky: THREE.ColorRepresentation
  dusk: THREE.ColorRepresentation
  gain?: number
}

/**
 * An additive limb haze, the Earth's (AtmosphereRenderer) with the planet's
 * own sizes and colours, lit from the Sun's actual direction.
 */
export function PlanetAtmosphere({
  planet,
  surface = 1,
  outer,
  scaleHeight,
  sky,
  dusk,
  gain = 1.2,
}: PlanetAtmosphereProps) {
  const sun = useSunDirection()
  const R = planet.radius
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          uSurface: { value: R * surface },
          uOuter: { value: R * outer },
          uScaleHeight: { value: R * scaleHeight },
          uSun: sun.uniform,
          uGain: { value: gain },
          uSky: { value: new THREE.Color(sky) },
          uDusk: { value: new THREE.Color(dusk) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [R, surface, outer, scaleHeight, sun.uniform, gain, sky, dusk]
  )
  const geometry = useMemo(
    () => new THREE.SphereGeometry(R * outer, 96, 48),
    [R, outer]
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={1}
      raycast={noRaycast}
      onBeforeRender={sun.onBeforeRender}
    />
  )
}

export interface PlanetRingsProps {
  /** Must have `rings` in the catalog. */
  planet: Planet
  /** A radial strip, inner edge at u = 0: colour in RGB, opacity in alpha.
   * Without one the rings get placeholder bands in `color`. */
  texture?: string
  color?: THREE.ColorRepresentation
  opacity?: number
}

/** The planet's rings at the catalog radii, shadowed by the globe. */
export function PlanetRings({
  planet,
  texture,
  color = planet.color,
  opacity = 1,
}: PlanetRingsProps) {
  if (!planet.rings) throw new Error(`${planet.name} has no rings in the catalog`)
  const { inner, outer } = planet.rings
  const map = usePlanetTexture(texture)
  const sun = useSunDirection()
  const R = planet.radius
  const geometry = useMemo(
    () => ringGeometry(R * inner, R * outer),
    [R, inner, outer]
  )
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: ringVertex,
        fragmentShader: ringFragment,
        defines: map ? { USE_RING_MAP: '' } : {},
        uniforms: {
          uSunDir: sun.uniform,
          uColor: { value: new THREE.Color(color) },
          uOpacity: { value: opacity },
          uSunIntensity: { value: SUNLIGHT_INTENSITY },
          uAmbient: { value: AMBIENT },
          uPlanetRadius: { value: R },
          uMap: { value: map },
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    [map, sun.uniform, color, opacity, R]
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geometry.dispose(), [geometry])

  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={2}
      raycast={noRaycast}
      onBeforeRender={sun.onBeforeRender}
    />
  )
}
