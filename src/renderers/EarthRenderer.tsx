import { useLoader, useFrame, useThree } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { realCloudBlend, realClouds, useRealCloudsActive } from './realCloudTextures'
import { pickBlend } from '../cloud-frames'
import { composePatches, useEclipseShadowState, type MaterialPatch } from './eclipseShadow'
import { createCloudLayer, type CloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGroundHaze } from './groundHaze'
import { groundShadowPatch } from './groundShadow'
import { useGibsPatch } from './gibsPatch'
import { useGibsNightPatch } from './gibsNightPatch'
import { streamedPatch } from './gibsStream'
import { nightLightsPatch, useNightFlight } from './nightLights'
import { eyeSky, EYE_AIRLESS_KM } from '../night-flight'
import { poleSmoothingPatch } from './poleSmoothing'
import { createWater, waterPatch } from './water'
import { prefersReducedMotion } from '../ship/reduced-motion'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY, TONE_MAPPING_EXPOSURE } from '../lighting'
import {
  driftOffset,
  STATIC_DRIFT_PER_FRAME,
  TERRAIN_DISPLACEMENT,
} from '../cloud-layer'
import { isLowQuality } from '../quality'
import { SURFACE_TILES_ON } from '../surface'
import { fineGroundDepth } from '../ship/ship-session'
import { reversedFloatDepth } from './depth-precision'
import { globeStencil } from './surface/surface-scale'
import { setSurfaceLink, type GlobeLink, type GlobeStream } from './surface/surface-link'
import { LIMB_SEGMENTS, isLimbSphere, useBodySphere } from '../ship/limb-detail'
import { EARTH_BASE_SEGMENTS } from '../ship/terrain-floor'
import { warmDefinesOnce } from '../ship/ship-warmup'
import { EarthDemLoader } from './earthDemTexture'
import { earthHorizon } from './earthHorizonTexture'
import {
  EARTH_LIMB_SWAP_FLOOR,
  createGroundDisplacement,
  groundLod,
  groundMorph,
  type GroundDisplacement,
} from './groundDisplacement'

// Import assets directly
import earthSpecularMapHigh from '../assets/earth-specular.jpg'
import earthSpecularMapLow from '../assets/earth-specular-2k.jpg'
import earthCloudsTextureHigh from '../assets/earth-clouds.jpg'
import earthCloudsTextureLow from '../assets/earth-clouds-2k.jpg'
import earthNightTextureHigh from '../assets/earth-night.jpg'
import earthNightTextureLow from '../assets/earth-night-2k.jpg'
import earthDemHigh from '../assets/earth-dem-4k.bin?url'
import earthDemLow from '../assets/earth-dem-2k.bin?url'
import earthBathyHigh from '../assets/earth-bathy-4k.png'
import earthBathyLow from '../assets/earth-bathy-2k.png'
import earthHorizonCurvedUrl from '../assets/earth-horizon-1k.bin?url'
import earthHorizonTrueUrl from '../assets/earth-horizon-1k-true.bin?url'
import { HORIZON_TRUE_CURVE_RELIEF, horizonCurveRelief } from '../earth-horizon'
import { RELIEF } from '../relief'

// The horizon map whose curvature is exact nearer the page's relief
// (../earth-horizon.ts, tides-zmw.21): only that one is fetched.
const earthHorizonUrl = horizonCurveRelief(RELIEF) === HORIZON_TRUE_CURVE_RELIEF ? earthHorizonTrueUrl : earthHorizonCurvedUrl

interface EarthRendererProps {
  diameter: number
  texture: string
  /** No cloud shell and no cloud shadows on the ground, for the solar
   * eclipse demo's Moon's shadow (tides-zec.7.1). */
  hideClouds?: boolean
}

export default function EarthRenderer({
  diameter,
  texture,
  hideClouds = false,
}: EarthRendererProps) {
  const textureSet = getEarthTextureSet(texture)

  useTexture.preload(textureSet.specular)
  useTexture.preload(textureSet.clouds)
  useTexture.preload(textureSet.night)
  useTexture.preload(textureSet.bathy)
  useLoader.preload(EarthDemLoader, textureSet.dem)

  const cloudRef = useRef<THREE.Mesh>(null)
  const groundRef = useRef<THREE.Mesh>(null)
  const drift = useRef(0)

  // Load textures using imported paths
  const earthTexture = useLoader(THREE.TextureLoader, texture)
  const specularMap = useLoader(THREE.TextureLoader, textureSet.specular)
  const cloudsTexture = useLoader(THREE.TextureLoader, textureSet.clouds)
  const nightTexture = useLoader(THREE.TextureLoader, textureSet.night)
  // The sea's depth under the water's body (waterDepth.ts, tides-d9f.6).
  const depthMap = useLoader(THREE.TextureLoader, textureSet.bathy)
  const { relief: demTexture, ground: groundTexture } = useLoader(EarthDemLoader, textureSet.dem)
  const gl = useThree((s) => s.gl)
  prepareMaps(
    gl.capabilities.getMaxAnisotropy(),
    [earthTexture, nightTexture, cloudsTexture],
    [specularMap, demTexture, depthMap]
  )
  // Its columns run on round the date line, as the globe's uv does.
  depthMap.wrapS = THREE.RepeatWrapping
  // A uniform whose value follows the texture, so a new one keeps the
  // patch (and the tiles' link) as they are.
  const waterDepth = useMemo(() => ({ value: NO_TEXTURE }), [])
  waterDepth.value = depthMap
  const real = useStore((s) => s.weatherSource) === 'real'
  useRealCloudsActive(real)
  // A lost context comes back with blank render targets, and nothing redraws
  // them while paused.
  useEffect(() => {
    const canvas = gl.domElement
    const restart = () => realCloudBlend.release()
    canvas.addEventListener('webglcontextrestored', restart)
    return () => canvas.removeEventListener('webglcontextrestored', restart)
  }, [gl])
  // The Moon's shadow during solar eclipses, on the ground and the clouds.
  const eclipseShadow = useEclipseShadowState('earth')
  // Clouds with relief, and their shadows on the ground (tides-y2e).
  const clouds = useMemo(
    () => createCloudLayer(eclipseShadow, textureSet.low),
    [eclipseShadow, textureSet.low]
  )
  useEffect(() => () => clouds.dispose(), [clouds])
  // The clouds' programs warmed for the defines they turn to (tides-tvr.4.5),
  // by three's record of the material, which a dispose replaces (as React
  // StrictMode's replayed effects do in dev); and whether the shell has
  // been faced to a camera yet, which sets the defines it draws with.
  const warmedDefines = useRef(new WeakSet<object>())
  const cloudsFaced = useRef(false)
  const scene = useThree((s) => s.scene)
  // Both limbs show from the ship's stop, the cloud shell's the nearer.
  const groundSphere = useBodySphere('earth', diameter, EARTH_BASE_SEGMENTS, EARTH_LIMB_SWAP_FLOOR)
  const cloudSphere = useBodySphere('earth', diameter + clouds.shellAltitude, [96, 64])
  // Real imagery under the ship (tides-01v.7).
  const gibsPatch = useGibsPatch(groundRef, diameter)
  // Sharper city lights, and the night lit for the adapted eye (tides-tvr.2).
  const gibsNightPatch = useGibsNightPatch(groundRef, diameter)
  const nightFlight = useNightFlight(clouds.uniforms.uSunDir, clouds.material.uniforms.uAmbient)
  // Aerial perspective from inside the atmosphere (tides-zmw.5).
  const groundHaze = useMemo(
    () => createGroundHaze(clouds.uniforms.uSunDir, diameter, textureSet.low),
    [clouds, diameter, textureSet.low]
  )
  // In an effect, on the haze React keeps: a memo may run twice (StrictMode),
  // and sharing there handed the clouds the discarded haze's switch.
  useEffect(() => groundHaze.shareWith(clouds.material), [groundHaze, clouds])
  // Open water that reads as water from low down (tides-07z): its waves'
  // clock and phases, at the haze's eye.
  const water = useMemo(() => createWater(groundHaze.frame), [groundHaze])
  // The streamed tiles (tides-zmw.9.7) take the globe's features through
  // this link (its haze, eclipse, clouds, night, maps and horizon; the
  // tiles' composer, tides-zmw.9.16, surface/tile-material.ts), and the globe
  // gives way under them (surface-scale.ts). None of it without the tiles.
  // The maps as uniforms whose values follow the textures (set below), so a
  // new texture keeps the link.
  const surfaceMaps = useMemo<GlobeLink['maps'] | null>(
    () =>
      SURFACE_TILES_ON
        ? { day: { value: NO_TEXTURE }, specular: { value: NO_TEXTURE }, night: { value: NO_TEXTURE }, depth: waterDepth }
        : null,
    [waterDepth]
  )
  if (surfaceMaps) {
    surfaceMaps.day.value = earthTexture
    surfaceMaps.specular.value = specularMap
    surfaceMaps.night.value = nightTexture
  }
  const surfaceLink = useMemo<GlobeLink | null>(
    () =>
      SURFACE_TILES_ON && surfaceMaps
        ? {
            haze: groundHaze,
            sunDir: clouds.uniforms.uSunDir,
            clouds: { uniforms: clouds.uniforms, flat: textureSet.low },
            eclipse: eclipseShadow.uniforms,
            nightFlight: nightFlight?.uniforms ?? null,
            gibs: globeStream(gibsPatch),
            gibsNight: globeStream(gibsNightPatch),
            maps: surfaceMaps,
            horizon: earthHorizon(earthHorizonUrl),
            seaLevel: diameter,
            water,
          }
        : null,
    [groundHaze, clouds, textureSet.low, eclipseShadow, nightFlight, gibsPatch, gibsNightPatch, surfaceMaps, diameter, water]
  )
  useEffect(() => {
    if (!surfaceLink) return
    setSurfaceLink(scene, surfaceLink)
    return () => setSurfaceLink(scene, null)
  }, [scene, surfaceLink])
  // The tiles draw before the ground, so with them on the night flight is
  // set per camera before anything draws too (the ground's own call stays).
  const tileNightFlight = SURFACE_TILES_ON ? nightFlight : null
  // The Sun in the Earth's frame and the cloud shell's faces, then the
  // haze's camera and frame, for each camera before anything draws (the
  // tiles draw before the ground); one wrapper, so its cleanup restores the
  // scene's.
  const cloudsHidden = useRef(hideClouds)
  cloudsHidden.current = hideClouds
  useEffect(() => {
    // A new layer (a new tier) is faced afresh.
    cloudsFaced.current = false
    return cloudsFaceEachCamera(scene, clouds, cloudRef, (renderer, camera) => {
      cloudsFaced.current = true
      // After faceCamera, which sets it for this camera.
      if (cloudsHidden.current) clouds.uniforms.uGroundShadow.value = 0
      // The tiles' handover marks (surface-scale.ts), cleared within this
      // View's scissor.
      if (SURFACE_TILES_ON) renderer.clearStencil()
      if (groundRef.current) {
        groundHaze.update(groundRef.current, camera)
        // At the haze's eye, just set.
        water.update()
      }
      // The eye for this camera: its exposure, up a little under a low
      // Sun near the ground in flight, and how much the daylit sky hides
      // the stars (night-flight.ts dayExposure(), skyDaylight()).
      eyeSky.daylight = 0
      eyeSky.heightKm = EYE_AIRLESS_KM
      eyeSky.up.set(0, 1, 0)
      eyeSky.sunDiscFade = 0
      renderer.toneMappingExposure =
        TONE_MAPPING_EXPOSURE *
        (nightFlight && groundRef.current ? nightFlight.adaptEye(groundRef.current, camera, diameter) : 1)
      // After the Sun, which it reads; as the ground's onBeforeRender.
      if (tileNightFlight && groundRef.current && cloudRef.current?.parent) {
        tileNightFlight.update(groundRef.current, camera, diameter)
      }
    })
  }, [scene, clouds, groundHaze, water, tileNightFlight, nightFlight, diameter])
  // Out of flight, the eye as the day's at once, for a View with no Earth of
  // its own to set it (the 'top' panel).
  useEffect(() => () => restoreEye(gl), [nightFlight, gl])
  // And with the night flight on, once this View has drawn: in close zoom
  // the overview panels draw in the same frame (tides-tvr.7.3).
  useEffect(() => (nightFlight ? restoreEyeAfterDrawing(scene) : undefined), [nightFlight, scene])
  const groundPatch = useMemo(
    () =>
      composePatches(
        eclipseShadow.material,
        clouds.groundPatch,
        nightLightsPatch(clouds.uniforms.uSunDir, nightFlight?.uniforms),
        poleSmoothingPatch(),
        groundDetailPatch(textureSet.low),
        groundShadowPatch(clouds.uniforms.uSunDir, earthHorizon(earthHorizonUrl)),
        // After the shadows in the list, so its sky lands before they dim
        // directSpecular.
        waterPatch(water, groundHaze.frame, textureSet.low, waterDepth),
        gibsPatch,
        gibsNightPatch,
        groundHaze.patch
      ),
    [eclipseShadow, clouds, textureSet.low, gibsPatch, gibsNightPatch, nightFlight, groundHaze, water, waterDepth]
  )
  // The mesh's displacement, at its vertex spacing (tides-zmw.2).
  const displacement = useMemo(() => createGroundDisplacement(EARTH_BASE_SEGMENTS), [])
  const drawnPatch = useMemo(() => composePatches(groundPatch, displacement.patch), [groundPatch, displacement])
  displacement.uniforms.uGroundHeights.value = groundTexture
  // The ground's program holds the patch's uniforms; a new patch (Fast
  // Refresh re-runs the memos) needs a new program.
  const groundMaterial = useRef<THREE.MeshPhongMaterial>(null)
  useLayoutEffect(() => {
    if (groundMaterial.current) groundMaterial.current.needsUpdate = true
  }, [drawnPatch])
  useLayoutEffect(() => {
    if (groundMaterial.current) globeStencil(groundMaterial.current, SURFACE_TILES_ON)
  }, [])
  // The static clouds, and with Real weather until the frame loop has a blend
  // to show, so the first frame isn't missing its map.
  if (!real || !clouds.uniforms.uCloudMap.value) clouds.setMap(cloudsTexture, false, null)
  // The march's ground is the drawn ground's texture: its lod 0 is the limb
  // sphere's vertices (cloudShaders.ts cloudGround()).
  clouds.uniforms.uTerrainMap.value = groundTexture
  clouds.uniforms.uSeaLevel.value = diameter

  // The static clouds drift east, slower than the Earth turns; the shader
  // offsets the texture rather than turning the mesh, so the ground's shadows
  // drift with them. The waves move on by the wall clock, still under
  // prefers-reduced-motion.
  useFrame(({ clock, gl, camera }, delta) => {
    water.advance(delta, prefersReducedMotion())
    if (!real) {
      drift.current += STATIC_DRIFT_PER_FRAME
      clouds.uniforms.uCloudShift.value = driftOffset(drift.current)
      return
    }
    // Real clouds sit on the geography they were photographed over.
    clouds.uniforms.uCloudShift.value = 0
    const { timestamp, jumpDate, timeScale } = useStore.getState()
    if (timestamp == null) return
    // Every View runs this; the shared clock keeps the second and third calls
    // in a frame no-ops.
    const wallMs = clock.elapsedTime * 1000
    const jumpToMs = jumpDate?.getTime() ?? null
    realClouds.tick(timestamp, jumpToMs, timeScale, wallMs, Date.now(), textureSet.clouds)
    const pick = pickBlend(realClouds.getSnapshot().frames, jumpToMs ?? timestamp)
    const texture = (t: THREE.Texture | 'static') => (t === 'static' ? cloudsTexture : t)
    const out = realCloudBlend.update(
      gl,
      pick && { a: texture(pick.a), b: texture(pick.b), mix: pick.mix },
      cloudsTexture,
      wallMs
    )
    clouds.setMap(out?.texture ?? cloudsTexture, out?.measured ?? false, out?.typed ? { grid: out.typeTexture, tops: out.topsTexture } : null)
    // The typed program (or, typed already, the untyped), compiled ahead of
    // the frame that turns to it: else that frame links it, tens of ms, in
    // each View the ship's warm-up (ShipWarmup) doesn't run in, the
    // overview's panels. Here, as three's compile must not run mid-render.
    if (cloudsFaced.current && cloudRef.current?.parent) {
      warmDefinesOnce(gl, cloudRef.current, camera, scene, warmedDefines.current, (material) => gl.properties.get(material))
    }
  })

  return (
    <group>
      {/* Land with topology - main Earth surface */}
      <mesh
        ref={groundRef}
        geometry={groundSphere}
        raycast={meshBounds}
        onBeforeRender={(renderer, _scene, camera, geometry) => {
          setGroundDisplacement(displacement, groundTexture, groundRef.current, renderer, camera, geometry, diameter)
          // The haze and the Sun are set per camera before anything draws
          // (cloudsFaceEachCamera, above).
          if (!cloudRef.current?.parent) return
          nightFlight?.update(groundRef.current!, camera, diameter)
        }}
      >
        <meshPhongMaterial
          ref={groundMaterial}
          {...drawnPatch}
          map={earthTexture}
          specularMap={specularMap}
          // specular="#aaddff"
          emissiveMap={nightTexture}
          emissive={CITY_LIGHTS_COLOR}
          emissiveIntensity={CITY_LIGHTS_INTENSITY}
          displacementMap={demTexture}
          displacementScale={TERRAIN_DISPLACEMENT}
        />
      </mesh>

      {/* Clouds: a shell over the highest ground and cloud tops. The cloud
          texture is a uniform, never a material map: R3F would tag it sRGB. */}
      <mesh
        ref={cloudRef}
        visible={!hideClouds}
        geometry={cloudSphere}
        raycast={meshBounds}
        material={clouds.material}
      />

      {/* Atmosphere glow */}
      {/* <mesh ref={atmosphereRef}>
        <sphereGeometry args={[diameter * 1.08, 32, 32]} />
        <meshBasicMaterial
          color="#88ccff"
          transparent
          opacity={0.1}
          side={THREE.BackSide}
        />
      </mesh> */}
    </group>
  )
}

/** The link's maps before their first render's textures. */
const NO_TEXTURE = null as unknown as THREE.Texture

/** A streamed patch as the tiles' link hands it (surface/surface-link.ts). */
function globeStream(patch: MaterialPatch): GlobeStream {
  const streamed = streamedPatch(patch)
  return { patch, uniforms: streamed?.uniforms ?? {}, side: streamed?.side ?? 0 }
}

// The cloud shell picks its faces and draw order for each camera before
// three sorts the scene (CloudLayer.faceCamera), after the Sun's direction
// in the Earth's frame, which it reads for the ground's shadow (tides-l0z);
// `each` runs after it, with the world matrices updated and nothing drawn
// yet. Outside the component:
// the react-hooks lint rejects mutating the scene from useThree in place.
// Returns the cleanup.
// The eye outside flight: the day's exposure, and no daylight veil on the
// stars. Module level, so the renderer from useThree isn't mutated in a hook.
function restoreEye(renderer: THREE.WebGLRenderer) {
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE
  eyeSky.daylight = 0
  eyeSky.heightKm = EYE_AIRLESS_KM
  eyeSky.up.set(0, 1, 0)
  eyeSky.sunDiscFade = 0
}

// After `scene` draws, the day's eye again (restoreEye), for the Views drawn
// after it. Returns the cleanup.
function restoreEyeAfterDrawing(scene: THREE.Scene) {
  const previous = scene.onAfterRender
  scene.onAfterRender = function (renderer, renderScene, camera, target) {
    previous.call(this, renderer, renderScene, camera, target)
    restoreEye(renderer)
  }
  return () => {
    scene.onAfterRender = previous
  }
}

function cloudsFaceEachCamera(
  scene: THREE.Scene,
  clouds: CloudLayer,
  cloudRef: RefObject<THREE.Mesh | null>,
  each?: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void
) {
  const previous = scene.onBeforeRender
  scene.onBeforeRender = function (renderer, renderScene, camera, target) {
    previous.call(this, renderer, renderScene, camera, target)
    if (cloudRef.current) {
      sunInEarthFrame(cloudRef.current.parent, clouds.uniforms.uSunDir.value)
      // FINE_DECK only where the depth buffer can part its base from the
      // ground, as the ship's true-scale stop (tides-45y).
      clouds.faceCamera(cloudRef.current, camera, fineGroundDepth(SURFACE_TILES_ON, reversedFloatDepth(renderer)))
    }
    each?.(renderer, camera)
  }
  return () => {
    scene.onBeforeRender = previous
  }
}

// The Sun's direction in the Earth's frame, from `earth`'s final transform
// this frame. The Sun is the scene's origin, as for the directional light
// (sunlight.ts).
function sunInEarthFrame(earth: THREE.Object3D | null | undefined, target: THREE.Vector3) {
  if (!earth) return
  earth.matrixWorld.decompose(_position, _quaternion, _scale)
  target.copy(_position).negate().normalize().applyQuaternion(_quaternion.invert())
}

/**
 * Sets what three reads at a map's first upload (tides-01v.1): the full
 * anisotropy, which grazing views of the ground need, and one channel for
 * the grey data maps (the specular mask, the elevation map and the sea's
 * depth), a quarter of the VRAM. The material, the cloud shader and the
 * water read their red channel.
 */
function prepareMaps(anisotropy: number, colour: THREE.Texture[], grey: THREE.Texture[]) {
  for (const map of colour) map.anisotropy = anisotropy
  for (const map of grey) {
    map.anisotropy = anisotropy
    map.format = THREE.RedFormat
  }
}

/**
 * The ground mesh's displacement level, segments and morph for this draw:
 * the base sphere's level, or the limb sphere's blended toward the base's
 * (groundMorph) as seen by `camera`.
 */
function setGroundDisplacement(
  { uniforms }: GroundDisplacement,
  texture: THREE.DataTexture,
  mesh: THREE.Mesh | null,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  geometry: THREE.BufferGeometry,
  radius: number
) {
  const limb = isLimbSphere(geometry)
  const segments = limb ? LIMB_SEGMENTS : EARTH_BASE_SEGMENTS
  uniforms.uGroundLod.value = groundLod(texture.image.height, segments[1])
  uniforms.uGroundCells.value.set(...segments)
  uniforms.uGroundBaseLod.value = groundLod(texture.image.height, EARTH_BASE_SEGMENTS[1])
  uniforms.uGroundMorph.value = 0
  if (!limb || !mesh || !(camera instanceof THREE.PerspectiveCamera)) return
  const scale = mesh.matrixWorld.getMaxScaleOnAxis()
  const distance = _eye.setFromMatrixPosition(camera.matrixWorld).distanceTo(_centre.setFromMatrixPosition(mesh.matrixWorld))
  uniforms.uGroundMorph.value = groundMorph(
    EARTH_BASE_SEGMENTS,
    distance / scale,
    radius,
    renderer.getDrawingBufferSize(_buffer).y,
    camera.fov
  )
}

const _eye = new THREE.Vector3()
const _centre = new THREE.Vector3()
const _buffer = new THREE.Vector2()
const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()

function getEarthTextureSet(baseTexture: string) {
  if (!isLowQuality()) {
    return {
      day: baseTexture,
      specular: earthSpecularMapHigh,
      clouds: earthCloudsTextureHigh,
      night: earthNightTextureHigh,
      dem: earthDemHigh,
      bathy: earthBathyHigh,
      low: false,
    }
  }

  return {
    day: baseTexture,
    specular: earthSpecularMapLow,
    clouds: earthCloudsTextureLow,
    night: earthNightTextureLow,
    dem: earthDemLow,
    bathy: earthBathyLow,
    low: true,
  }
}
