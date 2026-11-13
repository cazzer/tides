// Live lightning (tides-ufyr.13): with Real weather, the GOES-East and
// -West Geostationary Lightning Mappers' flashes, each a brief additive
// glow at the cloud deck's height, flickering with its real timing
// (../lightning.ts, shaders/lightning). One instanced draw per View; the
// flashes come from ./lightningFeed.ts, shared by every View. Each frame
// starts the flashes whose time the clock just crossed in the ring of slots
// (./lightningInstances.ts), which the vertex shader plays out.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { latLonToLocal, sunDirectionLocal } from '../aurora'
import {
  emitCrossed,
  flashBrightness,
  flashRadiusKm,
  flashSeed,
  hashKey,
  isJump,
  lightningCaps,
  lightningClock,
  windowStride,
  type FlashBatch,
} from '../lightning'
import { CLOUD_FLAT_ALTITUDE, cloudDeckAt, EARTH_RADIUS_KM } from '../cloud-layer'
import { isLowQuality, touchDevice } from '../quality'
import { SURFACE_TILES_ON } from '../surface'
import { fineGroundDepth } from '../ship/ship-session'
import { reversedFloatDepth } from './depth-precision'
import { LIGHTNING_RENDER_ORDER } from './earth-shells'
import { lightningFeed } from './lightningFeed'
import { createLightningInstances } from './lightningInstances'
import lightningVertex from '../shaders/lightning/vertex.glsl'
import lightningFragment from '../shaders/lightning/fragment.frag'

/** The cloud deck's flat sheet on the low tier, as the cloud layer's (EarthRenderer textureSet.low). */
const LOW_QUALITY = isLowQuality()
const CAPS = lightningCaps(LOW_QUALITY || touchDevice())
/** [TUNE] A flash's height: where an 8 km cloud top is drawn. */
const FLASH_KM = 8
/** [TUNE] The glow's gain. */
const LIGHTNING_GAIN = 1.5
/** The smallest a flash's glow is drawn, px. */
const MIN_FLASH_PX = 2.5
/** Downloads start only while some View shows Earth at least this big (radius, px). */
const MIN_EARTH_PX = 40
/** ... and has within this long (wall ms). */
const SEEN_MS = 1500

/** Wall ms (performance.now()) any View last drew Earth big enough to fetch for. */
let earthSeenAt = -Infinity

const noRaycast = () => null

const frustum = new THREE.Frustum()
const viewProjection = new THREE.Matrix4()
const earthSphere = new THREE.Sphere()
const viewport = new THREE.Vector4()
const local = new THREE.Vector3()
const eye = new THREE.Vector3()

// three r180's Frustum takes the reversed depth its typings predate.
const setFrustum = frustum.setFromProjectionMatrix.bind(frustum) as (
  m: THREE.Matrix4,
  coordinateSystem: THREE.CoordinateSystem,
  reversedDepth: boolean
) => THREE.Frustum

/** Earth's radius on screen in this camera, px, or 0 when out of its view. */
function earthPixels(earth: THREE.Object3D, radius: number, camera: THREE.Camera, viewportH: number): number {
  earthSphere.center.setFromMatrixPosition(earth.matrixWorld)
  earthSphere.radius = radius
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  setFrustum(viewProjection, camera.coordinateSystem, camera.reversedDepth === true)
  if (!frustum.intersectsSphere(earthSphere)) return 0
  const p = camera.projectionMatrix.elements
  const perspective = p[11] === -1
  const scale = (p[5] * viewportH) / 2
  if (!perspective) return radius * scale
  const distance = earthSphere.center.distanceTo(eye.setFromMatrixPosition(camera.matrixWorld))
  return distance > radius ? (radius * scale) / distance : Infinity
}

interface LightningRendererProps {
  /** The Earth sphere's radius in scene units. */
  radius: number
  /** The clouds are hidden (a demo aid): no lightning, nothing fetched. */
  hidden: boolean
}

export default function LightningRenderer({ radius, hidden }: LightningRendererProps) {
  const real = useStore((s) => s.weatherSource) === 'real'
  const mesh = useRef<THREE.Mesh>(null)
  const instances = useMemo(() => createLightningInstances(CAPS.capacity), [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: lightningVertex,
        fragmentShader: lightningFragment,
        uniforms: {
          uTime: { value: 0 },
          uRadius: { value: radius },
          uKmToScene: { value: radius / EARTH_RADIUS_KM },
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uMinPx: { value: MIN_FLASH_PX },
          uViewportH: { value: 1 },
          uGain: { value: LIGHTNING_GAIN },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [radius]
  )
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => instances.dispose(), [instances])
  useEffect(() => {
    if (!real) lightningFeed.deactivate()
  }, [real])

  // The frame's emission state, read by the one emit callback.
  const frame = useRef({ prevClock: null as number | null, prevStride: 0, emitted: 0, batch: null as FlashBatch | null, keyHash: 0 })
  const emit = useMemo(
    () => (batch: FlashBatch, i: number) => {
      const f = frame.current
      if (f.emitted >= CAPS.perFrame) return false
      if (f.batch !== batch) {
        f.batch = batch
        f.keyHash = hashKey(batch.key)
      }
      latLonToLocal(batch.lat[i], batch.lon[i], local)
      const written = instances.write(
        local.x,
        local.y,
        local.z,
        flashSeed(f.keyHash, i),
        batch.durationMs[i] / 1000,
        flashBrightness(batch.energyJ[i]),
        flashRadiusKm(batch.areaKm2[i])
      )
      // A full ring drops the rest.
      if (!written) return false
      f.emitted++
      return true
    },
    [instances]
  )

  useFrame((state) => {
    const { timestamp, jumpDate, timeScale } = useStore.getState()
    // Uniforms are updated through the mesh, not the memoised material.
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (timestamp == null || !shader) return
    const u = shader.uniforms
    u.uTime.value = instances.begin(state.clock.elapsedTime)
    sunDirectionLocal(timestamp, u.uSun.value)
    const f = frame.current
    if (!real) {
      f.prevClock = null
      instances.flush()
      return
    }
    const nowMs = Date.now()
    const wallMs = performance.now()
    // During a jump only its target matters: its window loads on the way.
    const clockMs = lightningClock(jumpDate?.getTime() ?? timestamp, nowMs)
    const stride = windowStride(timeScale)
    const batches = lightningFeed.tick({
      clockMs,
      stride,
      rate: timeScale,
      wallMs,
      nowMs,
      fetch: !hidden && wallMs - earthSeenAt < SEEN_MS,
    })
    const from = f.prevClock
    const steady = from !== null && stride === f.prevStride && jumpDate == null && !isJump(from, clockMs, stride)
    f.prevClock = clockMs
    f.prevStride = stride
    f.emitted = 0
    // Nothing is emitted for a jump, a scrub or a change of stride (the
    // display times move).
    if (steady && !hidden) {
      for (let i = 0; i < batches.length; i++) {
        emitCrossed(batches[i], stride, from, clockMs, emit)
        if (f.emitted >= CAPS.perFrame) break
      }
    }
    instances.flush()
  })

  // Per camera: the deck's height for its depth buffer (as the cloud
  // layer's, EarthRenderer), its viewport, and whether it shows Earth.
  const onBeforeRender: THREE.Object3D['onBeforeRender'] = (renderer, _scene, camera, _geometry, shader) => {
    const u = (shader as THREE.ShaderMaterial).uniforms
    if (LOW_QUALITY) {
      u.uRadius.value = radius + CLOUD_FLAT_ALTITUDE
    } else {
      const deck = cloudDeckAt(fineGroundDepth(SURFACE_TILES_ON, reversedFloatDepth(renderer)))
      u.uRadius.value = radius + deck.clearance + deck.unitsPerKm * FLASH_KM
    }
    u.uViewportH.value = renderer.getCurrentViewport(viewport).w
    if (mesh.current && earthPixels(mesh.current, radius, camera, viewport.w) >= MIN_EARTH_PX) {
      earthSeenAt = performance.now()
    }
  }

  return (
    <mesh
      ref={mesh}
      geometry={instances.geometry}
      material={material}
      visible={real && !hidden}
      frustumCulled={false}
      renderOrder={LIGHTNING_RENDER_ORDER}
      raycast={noRaycast}
      onBeforeRender={onBeforeRender}
      // Compiled with the scene while Real weather is off, so turning it on
      // links nothing mid-frame.
      userData={{ compileHidden: true }}
    />
  )
}
