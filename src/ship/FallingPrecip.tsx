import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { shipTelemetry, type ShipTelemetry } from './ship-telemetry'
import { fillEarthEye, type Carrier } from './frame-carry'
import { prefersReducedMotion } from './reduced-motion'
import { EARTH_RADIUS } from './ship-bodies'
import { fineGroundDepth } from './ship-session'
import { earthTerrain, terrainFloorRadius } from './terrain-floor'
import { STREAK_ENERGY_FLOOR, easeToward, positiveMod, random } from './dust'
import {
  ABOVE_BASE_FADE_KM,
  EDGE_FADE,
  NEAR_FADE,
  PRECIP_HALF,
  PRECIP_TOP,
  RAIN_OPACITY,
  RATE_TAU_S,
  REDUCED_OPACITY,
  SHOWN_EPS,
  SNOW_OPACITY,
  SNOW_SWAY_HZ,
  UNDER_CLOUD_LIGHT,
  altitudeFade,
  baseOverGround,
  cloudCoverAt,
  coverGate,
  daylight,
  fallSpeed,
  glsl,
  particleCount,
  particlePool,
  precipIntensity,
  precipShown,
  shouldSample,
  speedFade,
  stepAnchor,
  streakVector,
  swayAmplitude,
  type CloudBytes,
  type PrecipTier,
} from './falling-precip'
import { EARTH_UNITS_PER_METRE } from '../surface-handover'
import { cloudDeckAt, EXAGGERATED_DECK } from '../cloud-layer'
import { earthLatLon } from '../surface-ground'
import { isLowQuality } from '../quality'
import { SURFACE_TILES_ON } from '../surface'
import { pickBlend } from '../cloud-frames'
import { precipFromFrames } from '../cloud-precip'
import { precipBytesOf } from '../renderers/cloudBlend'
import { realClouds } from '../renderers/realCloudTextures'
import { reversedFloatDepth } from '../renderers/depth-precision'

// Seeded so every visit gets the same field (SpaceDust's is 0x3b16).
const SEED = 0x7a1d
// A drop's radius in CSS pixels is its size over its distance (share of the
// half-side), clamped: raindrops thin streaks, flakes soft dots.
const DROP_SIZE = 0.375
const DROP_RADIUS: readonly [number, number] = [1.2, 2.4]
// Soft discs a few pixels wide far off, up to a dozen near (tides-bl3.7).
const FLAKE_SIZE = 1.6
const FLAKE_RADIUS: readonly [number, number] = [2.5, 7]
const RAIN_COLOR: readonly [number, number, number] = [0.75, 0.8, 0.85]
const SNOW_COLOR: readonly [number, number, number] = [0.95, 0.97, 1]
// After the planets' translucent shells, as SpaceDust.
const PRECIP_RENDER_ORDER = 10
// sin(a) and cos(0.7 a) both repeat over 20π, so the sway's phase wraps
// there and stays precise in float32.
const SWAY_PERIOD = 20 * Math.PI
const SWAY_RATE = 2 * Math.PI * SNOW_SWAY_HZ
const RAD_TO_DEG = 180 / Math.PI
const WORLD_Y = new THREE.Vector3(0, 1, 0)
const WORLD_X = new THREE.Vector3(1, 0, 0)
// Read once: it parses the URL and reads storage.
const FLAT = isLowQuality()

function vec3(c: readonly [number, number, number]): string {
  return `vec3(${c.map(glsl).join(', ')})`
}

// SpaceDust's screen-space capsule (see its shader), with each drop either
// rain or snow (look.x against the snow share), its own kind's wrap and
// streak, and snow swaying across the horizontal (uEast, uNorth).
const vertexShader = /* glsl */ `
  uniform vec3 uOffsetRain;
  uniform vec3 uOffsetSnow;
  uniform vec3 uStreakRain;
  uniform vec3 uStreakSnow;
  uniform float uHalf;
  uniform float uSnowShare;
  uniform float uOpacity;
  uniform float uSwayPhase;
  uniform float uSway;
  uniform vec3 uEast;
  uniform vec3 uNorth;
  uniform vec2 uResolution;
  uniform float uNear;
  attribute vec4 seed;
  attribute vec2 look;
  varying vec2 vLocal;
  varying float vLength;
  varying float vRadius;
  varying float vAlpha;
  varying float vSnow;

  void main() {
    float snow = look.x < uSnowShare ? 1.0 : 0.0;
    float side = 2.0 * uHalf;
    vec3 rel = mod(seed.xyz * side - mix(uOffsetRain, uOffsetSnow, snow), side) - uHalf;
    float a = uSwayPhase + look.y * 6.2831853;
    rel += (uEast * sin(a) + uNorth * cos(a * 0.7)) * (uSway * snow);
    vec3 share = abs(rel) / uHalf;
    float reach = length(share);
    float box = max(share.x, max(share.y, share.z));
    float fade = smoothstep(${glsl(NEAR_FADE[0])}, ${glsl(NEAR_FADE[1])}, reach)
      * (1.0 - smoothstep(${glsl(EDGE_FADE[0])}, ${glsl(EDGE_FADE[1])}, box));

    mat3 view = mat3(viewMatrix);
    vec3 head = view * rel;
    vec3 tail = head + view * mix(uStreakRain, uStreakSnow, snow);
    float front = -0.01 * uHalf;
    if (fade <= 0.0 || uOpacity <= 0.0 || head.z > front) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (tail.z > front) tail = mix(head, tail, (front - head.z) / (tail.z - head.z));

    vec4 clip0 = projectionMatrix * vec4(head, 1.0);
    vec4 clip1 = projectionMatrix * vec4(tail, 1.0);
    vec4 nearClip = projectionMatrix * vec4(0.0, 0.0, -1.001 * uNear, 1.0);
    float nearDepth = nearClip.z / nearClip.w;
    vec2 halfRes = 0.5 * uResolution;
    vec2 s0 = clip0.xy / clip0.w * halfRes;
    vec2 s1 = clip1.xy / clip1.w * halfRes;
    vec2 d = s1 - s0;
    float len = length(d);
    vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    float radius = snow > 0.5
      ? clamp(${glsl(FLAKE_SIZE)} / reach, ${glsl(FLAKE_RADIUS[0])}, ${glsl(FLAKE_RADIUS[1])})
      : clamp(${glsl(DROP_SIZE)} / reach, ${glsl(DROP_RADIUS[0])}, ${glsl(DROP_RADIUS[1])});
    float along = position.x;
    float end = along * 2.0 - 1.0;
    vec2 pixel = mix(s0, s1, along) + dir * end * radius + normal * position.y * radius;
    vLocal = vec2(along * len + end * radius, position.y * radius);
    vLength = len;
    vRadius = radius;
    vSnow = snow;
    float dotSize = 2.0 * radius;
    float energy = max(${glsl(STREAK_ENERGY_FLOOR)}, dotSize / (dotSize + len));
    vAlpha = fade * seed.w * uOpacity * energy * mix(${glsl(RAIN_OPACITY)}, ${glsl(SNOW_OPACITY)}, snow);

    float depth = along < 0.5
      ? (head.z > -uNear ? nearDepth : clip0.z / clip0.w)
      : (tail.z > -uNear ? nearDepth : clip1.z / clip1.w);
    gl_Position = vec4(pixel / halfRes, depth, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uLight;
  varying vec2 vLocal;
  varying float vLength;
  varying float vRadius;
  varying float vAlpha;
  varying float vSnow;

  void main() {
    float beyond = max(max(-vLocal.x, vLocal.x - vLength), 0.0);
    float edge = length(vec2(beyond, vLocal.y));
    float shape = 1.0 - smoothstep(vRadius * 0.35, vRadius, edge);
    // A raindrop bright at its head, half as bright at its tail; a flake even.
    float trail = mix(1.0, mix(0.5, 1.0, vSnow), clamp(vLocal.x, 0.0, vLength) / max(vLength, 1e-3));
    vec3 color = mix(${vec3(RAIN_COLOR)}, ${vec3(SNOW_COLOR)}, vSnow) * uLight;
    gl_FragColor = vec4(color, shape * trail * vAlpha);
  }
`

function createPrecipGeometry(count: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3)
  )
  geometry.setIndex([0, 1, 2, 2, 1, 3])
  const next = random(SEED)
  const seeds = new Float32Array(count * 4)
  const looks = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = next()
    seeds[i * 4 + 1] = next()
    seeds[i * 4 + 2] = next()
    seeds[i * 4 + 3] = 0.5 + 0.5 * next()
    looks[i * 2] = next()
    looks[i * 2 + 1] = next()
  }
  geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4))
  geometry.setAttribute('look', new THREE.InstancedBufferAttribute(looks, 2))
  geometry.instanceCount = 0
  return geometry
}

function createPrecipMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uOffsetRain: { value: new THREE.Vector3() },
      uOffsetSnow: { value: new THREE.Vector3() },
      uStreakRain: { value: new THREE.Vector3() },
      uStreakSnow: { value: new THREE.Vector3() },
      uHalf: { value: PRECIP_HALF },
      uSnowShare: { value: 0 },
      uOpacity: { value: 0 },
      uSwayPhase: { value: 0 },
      uSway: { value: 0 },
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uNorth: { value: new THREE.Vector3(0, 0, 1) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.01 },
      uLight: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    // Not additive: lit drops over a dark ground, never glowing at night.
    blending: THREE.NormalBlending,
  })
}

// A frame's cloud map bytes (its DataTexture's image), or null for the
// static clouds, whose image the CPU can't read.
function cloudBytesOf(texture: THREE.Texture | 'static'): CloudBytes | null {
  if (texture === 'static') return null
  const image = texture.image as Partial<CloudBytes> | undefined
  return image?.data && image.width && image.height ? (image as CloudBytes) : null
}

// What the field reads of the eye: the ship's telemetry, or the main view's
// own (createSystemEye).
type EyeView = Pick<ShipTelemetry, 'earthEye'> & { air: Pick<ShipTelemetry['air'], 'speed' | 'velocity'> }

function createSystemEye(): EyeView {
  return {
    earthEye: { up: new THREE.Vector3(0, 1, 0), local: new THREE.Vector3(0, 1, 0), altitude: Infinity },
    // Earth carries the close-zoomed camera, so the air is still about it.
    air: { speed: 0, velocity: new THREE.Vector3() },
  }
}

const earthCarrier: Required<Carrier> = { position: new THREE.Vector3(), radius: 1, spin: new THREE.Quaternion() }

// The main camera's place over Earth, in close zoom only (store.closeZoom);
// elsewhere it is nowhere (altitude Infinity), and nothing falls.
function fillSystemEye(view: EyeView, camera: THREE.Camera): void {
  const { closeZoom, earth, earthRadius } = useStore.getState()
  const body = earth?.current as THREE.Object3D | null | undefined
  if (!closeZoom || !body || earthRadius == null) {
    view.earthEye.altitude = Infinity
    return
  }
  body.getWorldPosition(earthCarrier.position)
  body.getWorldQuaternion(earthCarrier.spin)
  earthCarrier.radius = earthRadius
  fillEarthEye(view, camera.position, earthCarrier)
}

const viewport = new THREE.Vector4()
const down = new THREE.Vector3()
const toSun = new THREE.Vector3()
const latLon: [number, number] = [0, 0]

/**
 * Rain and snow falling around the ship under a precipitating cloud
 * (tides-bl3.3; falling-precip.ts): one instanced draw of streaks and flakes
 * in a box around the eye, as many as the real weather's rate under the eye
 * asks, fading out over the cloud base. Hidden (no draw) when dry, over the
 * base, with the weather not 'real', or away from Earth. Mount in the ship
 * View after ShipController (`eye` 'ship': it reads shipTelemetry), or in the
 * main view (`eye` 'system', tides-bl3.8): there it falls in close zoom only,
 * around the main camera, which Earth carries (close-zoom.ts), so the air
 * is still about it.
 */
export function FallingPrecip({ eye: source = 'ship' }: { eye?: 'ship' | 'system' }) {
  const view: EyeView = useMemo(() => (source === 'ship' ? shipTelemetry : createSystemEye()), [source])
  const tier: PrecipTier = useMemo(() => {
    const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    return FLAT || coarse ? 'low' : 'high'
  }, [])
  const geometry = useMemo(() => createPrecipGeometry(particlePool(tier)), [tier])
  const material = useMemo(() => createPrecipMaterial(), [])
  const mesh = useRef<THREE.Mesh>(null)
  const gate = useRef({
    amount: 0,
    snowShare: 0,
    targetAmount: 0,
    targetSnowShare: 0,
    lastSampleMs: -Infinity,
    rain: new THREE.Vector3(),
    snow: new THREE.Vector3(),
  })

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  // Per camera, at render time: the viewport, near plane and the Sun's
  // height over the eye's horizon (the Sun is the scene's origin).
  useEffect(() => {
    const target = mesh.current
    if (!target) return
    const uniforms = material.uniforms
    target.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(viewport)
      const ratio = renderer.getPixelRatio()
      uniforms.uResolution.value.set(viewport.z / ratio, viewport.w / ratio)
      uniforms.uNear.value = (camera as THREE.PerspectiveCamera).near
      const sunUp = toSun.copy(camera.position).negate().normalize().dot(view.earthEye.up)
      uniforms.uLight.value = daylight(sunUp) * UNDER_CLOUD_LIGHT
    }
  }, [material, view])

  useFrame(({ gl, clock, camera }, delta) => {
    const target = mesh.current
    if (!target) return
    const g = gate.current
    if (source === 'system') fillSystemEye(view, camera)
    const eye = view.earthEye
    const { weatherSource, timestamp, jumpDate } = useStore.getState()
    if (weatherSource !== 'real' || !Number.isFinite(eye.altitude)) {
      g.amount = 0
      g.targetAmount = 0
      target.visible = false
      return
    }
    // Over any deck's base and band: nothing falls, and no ground to read.
    if (eye.altitude > PRECIP_TOP) {
      g.amount = 0
      g.targetAmount = 0
      target.visible = false
      return
    }
    const floor = earthTerrain()
    const ground = floor ? terrainFloorRadius(floor, EARTH_RADIUS, eye.local) - EARTH_RADIUS : 0
    const flat = FLAT
    const deck = flat ? EXAGGERATED_DECK : cloudDeckAt(fineGroundDepth(SURFACE_TILES_ON, reversedFloatDepth(gl)))
    const fade = altitudeFade(
      eye.altitude - ground,
      baseOverGround(flat, deck, ground),
      ABOVE_BASE_FADE_KM * deck.unitsPerKm
    )
    const dt = Math.min(Math.max(delta, 0), 0.1)
    const nowMs = clock.elapsedTime * 1000
    if (fade <= 0) {
      // Over the base: nothing to read, and what fell eases out.
      g.targetAmount = 0
    } else if (shouldSample(nowMs, g.lastSampleMs)) {
      g.lastSampleMs = nowMs
      const simMs = jumpDate?.getTime() ?? timestamp
      const pick = simMs == null ? null : pickBlend(realClouds.getSnapshot().frames, simMs)
      earthLatLon(eye.local, latLon)
      const rate = pick
        ? precipFromFrames(precipBytesOf(pick.a), precipBytesOf(pick.b), pick.mix, latLon[0] * RAD_TO_DEG, latLon[1] * RAD_TO_DEG)
        : null
      const { amount, snowShare } = precipIntensity(rate)
      // Only under the cloud drawn overhead: the rate's grid is 10° coarse.
      const cover =
        pick && amount > 0
          ? cloudCoverAt(cloudBytesOf(pick.a), cloudBytesOf(pick.b), pick.mix, latLon[0] * RAD_TO_DEG, latLon[1] * RAD_TO_DEG)
          : 0
      g.targetAmount = amount * coverGate(cover)
      // Dry keeps the last split, so the field doesn't turn to rain as it eases out.
      if (amount > 0) g.targetSnowShare = snowShare
    }
    g.amount = easeToward(g.amount, g.targetAmount, dt, RATE_TAU_S)
    g.snowShare = easeToward(g.snowShare, g.targetSnowShare, dt, RATE_TAU_S)
    if (g.targetAmount === 0 && g.amount < SHOWN_EPS) g.amount = 0
    const fadeSpeed = speedFade(view.air.speed / EARTH_UNITS_PER_METRE)
    const shown = precipShown(g.amount, fade, fadeSpeed)
    target.visible = shown
    if (!shown) return

    const reduced = prefersReducedMotion()
    const air = view.air.velocity
    down.copy(eye.up).negate()
    const rainFall = fallSpeed('rain', reduced)
    const snowFall = fallSpeed('snow', reduced)
    stepAnchor(g.rain, air, down, rainFall, dt, PRECIP_HALF)
    stepAnchor(g.snow, air, down, snowFall, dt, PRECIP_HALF)
    // Through the mesh: the memoized geometry and material are the hooks' own.
    ;(target.geometry as THREE.InstancedBufferGeometry).instanceCount = particleCount(tier, g.amount, g.snowShare)

    const u = (target.material as THREE.ShaderMaterial).uniforms
    u.uOffsetRain.value.copy(g.rain)
    u.uOffsetSnow.value.copy(g.snow)
    streakVector(u.uStreakRain.value, air, down, rainFall, PRECIP_HALF, reduced, 'rain')
    streakVector(u.uStreakSnow.value, air, down, snowFall, PRECIP_HALF, reduced, 'snow')
    u.uSnowShare.value = g.snowShare
    u.uOpacity.value = fade * fadeSpeed * (reduced ? REDUCED_OPACITY : 1)
    if (!reduced) u.uSwayPhase.value = positiveMod(u.uSwayPhase.value + dt * SWAY_RATE, SWAY_PERIOD)
    u.uSway.value = swayAmplitude(reduced)
    const east = u.uEast.value as THREE.Vector3
    east.crossVectors(WORLD_Y, eye.up)
    if (east.lengthSq() < 1e-12) east.crossVectors(WORLD_X, eye.up)
    east.normalize()
    ;(u.uNorth.value as THREE.Vector3).crossVectors(eye.up, east)
  })

  return (
    <mesh
      ref={mesh}
      name="falling-precip"
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={PRECIP_RENDER_ORDER}
      visible={false}
    />
  )
}
