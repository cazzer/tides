// Building blocks for the seven planets (tides-kzj.2.4). Each planet's look
// lives in renderers/planets/<Name>.tsx, which composes these inside the
// planet's OrbitingBody: they all sit in the body's frame (+Y the north pole,
// equator in XZ), with no transform of their own.
//
// The scene's directional sunlight is aimed at the Earth (sunlight.ts), which
// is wrong for every other planet, so none of these use scene lights: each
// takes the Sun's direction in the body's frame from its world matrix just
// before it renders, with the Sun at the world origin.
//
// Each material is built once per shader variant (which textures, whether
// the rings shadow the globe); props only change uniform values.
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { meshBounds } from '@react-three/drei'
import * as THREE from 'three'
import type { Planet } from '../planets'
import {
  MAX_RING_BANDS,
  ringBandUniforms,
  ringGeometry,
  type RingBand,
} from './planetFrame'
import { usePlanetTextures } from './planetTextures'
import { SUNLIGHT_INTENSITY } from '../lighting'
import { isLowQuality } from '../quality'
import {
  AMBIENT,
  bandUniforms,
  planetSurfaceMaterial,
  setPlanetDetail,
  sunDirection,
  type BandUniforms,
  type PlanetDetail,
} from './planetMaterials'
import ringVertex from '../shaders/ring/vertex.glsl'
import ringFragment from '../shaders/ring/fragment.frag'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'

export type { RingBand } from './planetFrame'

/** Below this the Minnaert limb term brightens the limb without bound. */
const MIN_MINNAERT = 0.5

const noRaycast = () => null

function useSunDirection() {
  return useMemo(() => sunDirection(), [])
}

// Uniform values change in place: the materials are built once per variant.
function setUniforms(
  uniforms: Record<string, THREE.IUniform>,
  values: Record<string, unknown>
) {
  for (const [name, value] of Object.entries(values)) uniforms[name].value = value
}

const SPHERE_SEGMENTS = isLowQuality() ? 64 : 128

/** A ring system's extent and opacity, shared by PlanetRings and the
 * shadow it casts (PlanetSurface's ringShadow). */
export interface RingProfile {
  /** Planet radii. */
  inner: number
  outer: number
  /** A radial strip, inner edge at u = 0: colour in RGB, opacity in alpha. */
  texture?: string
  /** Without a texture: the rings and ringlets, radii in planet radii (at
   * most 16). Default: one opaque band across the whole ring. */
  bands?: readonly RingBand[]
  /** Scales the opacity. Default 1. */
  opacity?: number
}

function setBands(
  uniforms: Record<string, THREE.IUniform>,
  { inner, outer, bands }: Pick<RingProfile, 'inner' | 'outer' | 'bands'>
) {
  const u = uniforms as unknown as BandUniforms
  u.uBandCount.value = ringBandUniforms(
    bands ?? [{ inner, outer, opacity: 1 }],
    inner,
    outer,
    u.uBands.value
  )
}

export interface PlanetSurfaceProps {
  planet: Planet
  /** Equirectangular map, longitude 0 at the centre. Without one the
   * planet is its catalog colour. */
  texture?: string
  /** Scales the texture (or colour) as MOON_ALBEDO does the Moon's. */
  albedo?: number
  /** Minnaert exponent: 1 (default) is Lambert, > 1 darkens the limb;
   * clamped to ≥ 0.5. */
  limbDarkening?: number
  /** Rings that shade the globe; pass the same profile as PlanetRings. */
  ringShadow?: RingProfile
  /** Detail finer than the texture, for close fly-bys. Keep it stable
   * (module level): it's an effect dependency. */
  detail?: PlanetDetail
}

/** The planet's globe: Sun-lit diffuse with the scene's ambient fill. */
export function PlanetSurface(props: PlanetSurfaceProps) {
  // Untextured globes never suspend, so they show from the first frame.
  return props.texture || props.ringShadow?.texture ? (
    <TexturedSurface {...props} />
  ) : (
    <SurfaceMesh
      {...props}
      map={null}
      ringMap={null}
    />
  )
}

function TexturedSurface(props: PlanetSurfaceProps) {
  const [map, ringMap] = usePlanetTextures([
    props.texture,
    props.ringShadow?.texture,
  ])
  return (
    <SurfaceMesh
      {...props}
      map={map}
      ringMap={ringMap}
    />
  )
}

function SurfaceMesh({
  planet,
  albedo = 1,
  limbDarkening = 1,
  ringShadow,
  detail,
  map,
  ringMap,
}: PlanetSurfaceProps & {
  map: THREE.Texture | null
  ringMap: THREE.Texture | null
}) {
  const sun = useSunDirection()
  const shadowed = ringShadow !== undefined
  const material = useMemo(
    () => planetSurfaceMaterial(sun.uniform, { map, ringMap, shadowed }),
    [map, ringMap, shadowed, sun.uniform]
  )
  useEffect(() => () => material.dispose(), [material])

  useLayoutEffect(() => {
    const u = material.uniforms
    u.uColor.value.set(planet.color)
    setUniforms(u, {
      uAlbedo: albedo,
      uMinnaert: Math.max(limbDarkening, MIN_MINNAERT),
    })
    setPlanetDetail(material, detail)
    if (ringShadow) {
      setUniforms(u, {
        uRingInner: ringShadow.inner,
        uRingOuter: ringShadow.outer,
        uRingOpacity: ringShadow.opacity ?? 1,
      })
      setBands(u, ringShadow)
    }
  }, [material, planet.color, albedo, limbDarkening, ringShadow, detail])

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
          uSurface: { value: 0 },
          uOuter: { value: 0 },
          uScaleHeight: { value: 0 },
          uSun: sun.uniform,
          uGain: { value: 1 },
          uSky: { value: new THREE.Color() },
          uDusk: { value: new THREE.Color() },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [sun.uniform]
  )
  const geometry = useMemo(
    () => new THREE.SphereGeometry(R * outer, 96, 48),
    [R, outer]
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geometry.dispose(), [geometry])

  useLayoutEffect(() => {
    const u = material.uniforms
    setUniforms(u, {
      uSurface: R * surface,
      uOuter: R * outer,
      uScaleHeight: R * scaleHeight,
      uGain: gain,
    })
    u.uSky.value.set(sky)
    u.uDusk.value.set(dusk)
  }, [material, R, surface, outer, scaleHeight, gain, sky, dusk])

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

export interface PlanetRingsProps extends Partial<RingProfile> {
  /** Its catalog `rings` give inner and outer unless they're passed. */
  planet: Planet
  /** The ring colour without a texture. Default: the planet's. */
  color?: THREE.ColorRepresentation
  /** Brightness of the face turned away from the Sun. Default 0.3. */
  unlitFace?: number
  /** Scales the texture (or colour), lit and ambient alike. Default 1. */
  albedo?: number
  /** How the lit face's brightness follows the Sun's and the viewer's
   * angles from the ring plane: 'lambert' (default) dims with the Sun's
   * alone; 'lommel-seeliger', for thick rings of particles, keeps them
   * bright under a low Sun when seen from near the ring plane. */
  law?: RingLightingLaw
}

export type RingLightingLaw = 'lambert' | 'lommel-seeliger'

/** The planet's rings in its equatorial plane, shadowed by the globe. */
export function PlanetRings(props: PlanetRingsProps) {
  // Untextured rings never suspend, so they show from the first frame.
  return props.texture ? (
    <TexturedRings {...props} />
  ) : (
    <RingsMesh
      {...props}
      map={null}
    />
  )
}

function TexturedRings(props: PlanetRingsProps) {
  const [map] = usePlanetTextures([props.texture])
  return (
    <RingsMesh
      {...props}
      map={map}
    />
  )
}

function RingsMesh({
  planet,
  inner = planet.rings?.inner,
  outer = planet.rings?.outer,
  bands,
  opacity = 1,
  color = planet.color,
  unlitFace = 0.3,
  albedo = 1,
  law = 'lambert',
  map,
}: PlanetRingsProps & { map: THREE.Texture | null }) {
  if (inner === undefined || outer === undefined) {
    throw new Error(`${planet.name} has no ring radii`)
  }
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
        defines: {
          ...(map && { USE_RING_MAP: '' }),
          MAX_RING_BANDS,
          ...(law === 'lommel-seeliger' && { USE_LOMMEL_SEELIGER: '' }),
        },
        uniforms: {
          uSunDir: sun.uniform,
          uColor: { value: new THREE.Color() },
          uOpacity: { value: 1 },
          uSunIntensity: { value: SUNLIGHT_INTENSITY },
          uAmbient: { value: AMBIENT },
          uPlanetRadius: { value: 0 },
          uUnlitFace: { value: 0.3 },
          uAlbedo: { value: 1 },
          uRingMap: { value: map },
          ...bandUniforms(),
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    [map, law, sun.uniform]
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geometry.dispose(), [geometry])

  useLayoutEffect(() => {
    const u = material.uniforms
    u.uColor.value.set(color)
    setUniforms(u, {
      uOpacity: opacity,
      uPlanetRadius: R,
      uUnlitFace: unlitFace,
      uAlbedo: albedo,
    })
    setBands(u, { inner, outer, bands })
  }, [material, color, opacity, R, unlitFace, albedo, inner, outer, bands])

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
