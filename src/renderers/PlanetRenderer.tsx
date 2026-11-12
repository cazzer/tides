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
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { meshBounds } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Planet } from '../planets'
import {
  MAX_RING_BANDS,
  ringBandUniforms,
  ringGeometry,
  type RingBand,
} from './planetFrame'
import { usePlanetTextures } from './planetTextures'
import { useFlightTexture } from './useFlightTexture'
import { useShipBodyMap, type BodyMapDrawCheck } from './useShipBodyMap'
import type { FlightTextureKey } from '../flight-textures'
import { SUNLIGHT_INTENSITY } from '../lighting'
import { isLowQuality } from '../quality'
import {
  AMBIENT,
  bandUniforms,
  detailFlowTime,
  planetAtmosphereMaterial,
  planetDeckMaterial,
  planetSurfaceMaterial,
  setPlanetDetail,
  sunDirection,
  type BandUniforms,
  type PlanetDetail,
} from './planetMaterials'
import ringVertex from '../shaders/ring/vertex.glsl'
import ringFragment from '../shaders/ring/fragment.frag'
import { useBodySphere } from '../ship/limb-detail'
import { GlowOccluder } from './glow/GlowOccluder'
import { eyeNearBody, pickShellFaces } from './earth-shells'
import { deckFade, type DeckProfile } from '../cloud-deck'

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
  /** `texture`'s GPU-compressed KTX2 (tides-0oi.14), loaded in its place
   * where the browser takes it (planetTextures.ts). */
  compressedTexture?: string
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
  /** The sharper map that replaces `texture` near the ship (tides-01v.6). */
  flightTexture?: FlightTextureKey
  /** A gas giant's cloud deck, the fog the ship dives into under its cloud
   * tops (tides-ufyr.8.3). Needs `texture`. */
  deck?: DeckProfile
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
  const [map, ringMap] = usePlanetTextures([props.texture, props.ringShadow?.texture], {
    compressed: [props.compressedTexture],
  })
  const anchor = useRef<THREE.Group>(null)
  const flightMap = useFlightTexture(props.flightTexture, anchor, props.planet.radius)
  // Ship mode binds a small stand-in until the planet is a few px across.
  const shipMap = useShipBodyMap(map, anchor, props.planet.radius)
  return (
    <group ref={anchor}>
      <SurfaceMesh
        {...props}
        map={map}
        ringMap={ringMap}
        shownMap={flightMap ?? shipMap.shown}
        onBeforeDraw={shipMap.onBeforeDraw}
      />
    </group>
  )
}

function SurfaceMesh({
  planet,
  albedo = 1,
  limbDarkening = 1,
  ringShadow,
  detail,
  deck,
  map,
  ringMap,
  shownMap = map,
  onBeforeDraw,
}: PlanetSurfaceProps & {
  /** Picks the material's variant (textured or not). */
  map: THREE.Texture | null
  ringMap: THREE.Texture | null
  /** What uMap samples: the flight map, ship mode's stand-in, or `map`. */
  shownMap?: THREE.Texture | null
  /** Runs after the Sun's direction is set, before each draw. */
  onBeforeDraw?: BodyMapDrawCheck
}) {
  const sun = useSunDirection()
  const onBeforeRender = useMemo<BodyMapDrawCheck>(() => {
    if (!onBeforeDraw) return sun.onBeforeRender
    return function (renderer, scene, camera, geometry, material, group) {
      sun.onBeforeRender.call(this)
      onBeforeDraw.call(this, renderer, scene, camera, geometry, material, group)
    }
  }, [sun, onBeforeDraw])
  const shadowed = ringShadow !== undefined
  const flowingBands = detail?.style === 'bands'
  const material = useMemo(
    () => planetSurfaceMaterial(sun.uniform, { map, ringMap, shadowed, flowingBands }),
    [map, ringMap, shadowed, flowingBands, sun.uniform]
  )
  useEffect(() => () => material.dispose(), [material])
  // Read only by a flowing program (tides-ufyr.8.2).
  useFrame((state) => {
    material.uniforms.uDetailTime.value = detailFlowTime(state.clock.elapsedTime)
  })
  // A uniform swap, not a new material: that could drop and recompile a
  // program only this planet uses (Saturn's ring-shadowed one).
  useLayoutEffect(() => {
    setUniforms(material.uniforms, { uMap: shownMap })
  }, [material, shownMap])
  const geometry = useBodySphere(planet.key, planet.radius, [SPHERE_SEGMENTS, SPHERE_SEGMENTS])

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
    <>
      <mesh
        geometry={geometry}
        material={material}
        raycast={meshBounds}
        onBeforeRender={onBeforeRender}
      />
      {/* Hides the glow behind it, a planet across the Sun (tides-64u.3). */}
      <GlowOccluder geometry={geometry} />
      {deck && (
        <PlanetDeck
          planet={planet}
          deck={deck}
          map={shownMap}
          albedo={albedo}
          limbDarkening={limbDarkening}
          detail={detail}
        />
      )}
    </>
  )
}

const deckEye = new THREE.Vector3()
const deckViewport = new THREE.Vector4()

/**
 * A gas giant's cloud-deck fog (tides-ufyr.8.3, cloud-deck.ts): a shell at
 * R·top that, once the ship is inside it, lays an analytic exponential fog
 * over the view (shaders/planet/deck.frag), easing in to the cloud top
 * (deckFade), under which the globe culls itself and the fog covers the
 * view alone. Out of the ship's reach, and over the shell's top, it
 * discards every fragment (uDeckFade 0) rather than going invisible, which
 * would keep ShipWarmup from compiling it ahead (ship-warmup.ts coldWork).
 * Draws after the hazes (1) and rings (2), which it lies over. Samples the
 * globe's own map (`map`), detail and lighting.
 */
function PlanetDeck({
  planet,
  deck,
  map,
  albedo,
  limbDarkening,
  detail,
}: {
  planet: Planet
  deck: DeckProfile
  map: THREE.Texture | null
  albedo: number
  limbDarkening: number
  detail?: PlanetDetail
}) {
  const sun = useSunDirection()
  const R = planet.radius
  const material = useMemo(() => planetDeckMaterial(sun.uniform), [sun.uniform])
  const geometry = useBodySphere(planet.key, R * deck.top, [96, 48])
  useEffect(() => () => material.dispose(), [material])
  useFrame((state) => {
    material.uniforms.uDetailTime.value = detailFlowTime(state.clock.elapsedTime)
  })
  const onBeforeRender = useMemo<BodyMapDrawCheck>(
    () =>
      function (renderer, _scene, camera) {
        sun.onBeforeRender.call(this)
        pickShellFaces(this, material, camera, undefined, planet.key)
        const u = material.uniforms
        const distance = this.worldToLocal(camera.getWorldPosition(deckEye)).length()
        u.uDeckFade.value = eyeNearBody(camera, planet.key) ? deckFade(distance, R, deck) : 0
        const { fov } = camera as THREE.PerspectiveCamera
        const height = renderer.getCurrentViewport(deckViewport).w
        u.uPixelAngle.value = height > 0 ? (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))) / height : 0
      },
    [sun, material, planet.key, R, deck]
  )
  useLayoutEffect(() => {
    setUniforms(material.uniforms, { uMap: map })
  }, [material, map])
  useLayoutEffect(() => {
    setUniforms(material.uniforms, {
      uOuter: R * deck.top,
      uRadius: R,
      uScaleHeight: R * deck.scaleHeight,
      uVisibility: R * deck.visibility,
      uSunDepth: R * deck.sunDepth,
      uAlbedo: albedo,
      uMinnaert: Math.max(limbDarkening, MIN_MINNAERT),
    })
    setPlanetDetail(material, detail)
  }, [material, R, deck, albedo, limbDarkening, detail])

  return (
    <mesh
      geometry={geometry}
      material={material}
      renderOrder={3}
      raycast={noRaycast}
      onBeforeRender={onBeforeRender}
    />
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
 * own sizes and colours, lit from the Sun's actual direction. Drawn from
 * inside too, as the Earth's, while the planet is the limb body
 * (tides-ufyr.4), so the ship's stop can sit under it.
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
  const material = useMemo(() => planetAtmosphereMaterial(sun.uniform), [sun.uniform])
  // Faint but not zero at its outer edge, so from close by a coarse shell
  // shows as facets there.
  const geometry = useBodySphere(planet.key, R * outer, [96, 48])
  useEffect(() => () => material.dispose(), [material])
  // Both faces within the ship's reach (pickShellFaces), with no ground stop:
  // the depth test is off there and the shader stops each ray at the globe.
  const onBeforeRender = useMemo<BodyMapDrawCheck>(
    () =>
      function (_renderer, _scene, camera) {
        sun.onBeforeRender.call(this)
        pickShellFaces(this, material, camera, undefined, planet.key)
      },
    [sun, material, planet.key]
  )

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
      onBeforeRender={onBeforeRender}
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
