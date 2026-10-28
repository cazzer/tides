import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { shipTelemetry } from './ship-telemetry'
import { prefersReducedMotion } from './reduced-motion'
import { densityAltitudeKm, shipCarry } from './frame-carry'
import {
  EDGE_FADE,
  NEAR_FADE,
  REDUCED_MOTION_OPACITY,
  STREAK_ENERGY_FLOOR,
  airDustShare,
  dustAnchor,
  fieldLevel,
  fieldOpacity,
  layerHalfSize,
  slotLayer,
  streakLength,
  wrapOffset,
} from './dust'

// Motes per layer. Touch devices are the weaker GPUs; 600 still reads.
const MOTES = 1500
const MOTES_COARSE = 600
// Peak opacity of a full-brightness mote.
const DUST_OPACITY = 0.85
const DUST_COLOR = new THREE.Color(0.78, 0.86, 1)
// Mote radius in CSS pixels is DOT_SIZE over its distance (share of the
// half-size), clamped: nearer motes are bigger, the furthest a soft pixel.
const DOT_SIZE = 0.9
const DOT_RADIUS: readonly [number, number] = [2, 3.5]
// Seeded so every visit gets the same field.
const SEED = 0x3b16

function glsl(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : `${x}`
}

// Draw after the planets' translucent shells (clouds, atmosphere, aurora use
// renderOrder 0–3), so those don't blend over motes in front of a planet.
const DUST_RENDER_ORDER = 10

const viewport = new THREE.Vector4()
const anchor = new THREE.Vector3()

// Each mote is a capsule quad built in screen space from its head (where it
// is) to its tail (where it was a shutter-time ago), so the CPU sets only
// uniforms per frame. `position` holds the quad corner: x 0 at the head, 1 at
// the tail; y the side, ±1. The fade and streak-energy lines are GLSL copies
// of distanceFade and streakEnergy in dust.ts: keep them in step.
const vertexShader = /* glsl */ `
  uniform vec3 uOffset;
  uniform float uHalf;
  uniform vec3 uStreak;
  uniform float uOpacity;
  uniform vec2 uResolution;
  uniform float uNear;
  attribute vec4 seed;
  varying vec2 vLocal;
  varying float vLength;
  varying float vRadius;
  varying float vAlpha;

  void main() {
    float side = 2.0 * uHalf;
    vec3 rel = mod(seed.xyz * side - uOffset, side) - uHalf;
    vec3 share = abs(rel) / uHalf;
    float reach = length(share);
    float box = max(share.x, max(share.y, share.z));
    float fade = smoothstep(${glsl(NEAR_FADE[0])}, ${glsl(NEAR_FADE[1])}, reach)
      * (1.0 - smoothstep(${glsl(EDGE_FADE[0])}, ${glsl(EDGE_FADE[1])}, box));

    mat3 view = mat3(viewMatrix);
    vec3 head = view * rel;
    vec3 tail = head + view * uStreak;
    // In front of the eye, not the near plane: low in the air the near plane
    // stands 0.4x the ground gap off (shipNear), past the whole air's box, so
    // a mote nearer than it draws at it (below): nothing drawn is nearer.
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

    float radius = clamp(${glsl(DOT_SIZE)} / reach, ${glsl(DOT_RADIUS[0])}, ${glsl(DOT_RADIUS[1])});
    float along = position.x;
    float end = along * 2.0 - 1.0;
    vec2 pixel = mix(s0, s1, along) + dir * end * radius + normal * position.y * radius;
    vLocal = vec2(along * len + end * radius, position.y * radius);
    vLength = len;
    vRadius = radius;
    float dotSize = 2.0 * radius;
    float energy = max(${glsl(STREAK_ENERGY_FLOOR)}, dotSize / (dotSize + len));
    vAlpha = fade * seed.w * uOpacity * energy;

    // w = 1 so the varyings interpolate linearly across the screen-space
    // quad; depth is linear in screen space anyway.
    float depth = along < 0.5
      ? (head.z > -uNear ? nearDepth : clip0.z / clip0.w)
      : (tail.z > -uNear ? nearDepth : clip1.z / clip1.w);
    gl_Position = vec4(pixel / halfRes, depth, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vLocal;
  varying float vLength;
  varying float vRadius;
  varying float vAlpha;

  void main() {
    float beyond = max(max(-vLocal.x, vLocal.x - vLength), 0.0);
    float edge = length(vec2(beyond, vLocal.y));
    float shape = 1.0 - smoothstep(vRadius * 0.35, vRadius, edge);
    // Bright at the head, fading toward where it was.
    float trail = mix(1.0, 0.25, clamp(vLocal.x, 0.0, vLength) / max(vLength, 1e-3));
    gl_FragColor = vec4(uColor, shape * trail * vAlpha);
  }
`

// Small deterministic PRNG (mulberry32), so the field is the same each visit.
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function createDustGeometry(count: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3)
  )
  geometry.setIndex([0, 1, 2, 2, 1, 3])
  const next = random(SEED)
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = next()
    seeds[i * 4 + 1] = next()
    seeds[i * 4 + 2] = next()
    seeds[i * 4 + 3] = 0.5 + 0.5 * next()
  }
  geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4))
  geometry.instanceCount = count
  return geometry
}

function createDustMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uOffset: { value: new THREE.Vector3() },
      uHalf: { value: 1 },
      uStreak: { value: new THREE.Vector3() },
      uOpacity: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.01 },
      uColor: { value: DUST_COLOR },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

const SLOTS = [0, 1] as const

/**
 * ED-style space dust for ship mode (tides-3bl.6): motes fixed in the world
 * in a box that wraps around the camera, drawn as streaks along the ship's
 * velocity. Two meshes crossfade between dust layers of different scales so
 * motion reads from Moon-skimming to cruise (see dust.ts). Mount in the ship
 * View; reads shipTelemetry and the rendering camera only.
 */
export function SpaceDust() {
  const geometry = useMemo(() => {
    const coarse =
      typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    return createDustGeometry(coarse ? MOTES_COARSE : MOTES)
  }, [])
  const materials = useMemo(() => SLOTS.map(createDustMaterial), [])
  const meshes = useRef<(THREE.Mesh | null)[]>([])

  useEffect(
    () => () => {
      geometry.dispose()
      for (const material of materials) material.dispose()
    },
    [geometry, materials]
  )

  // At render time, after every useFrame (ShipController included) has run,
  // with the camera actually drawing this frame. A wrap offset a frame behind
  // the camera would carry the motes along with the ship.
  useEffect(() => {
    for (const slot of SLOTS) {
      const mesh = meshes.current[slot]
      if (!mesh) continue
      const uniforms = materials[slot].uniforms
      mesh.onBeforeRender = (renderer, _scene, camera) => {
        const { speed, velocity } = shipTelemetry
        // Low in Earth's air, a box sized to the ship's speed (dust.ts, tides-d9f.1).
        const airShare = airDustShare(densityAltitudeKm(shipTelemetry.air.density))
        const level = fieldLevel(speed, airShare)
        const { layer, weight } = slotLayer(level, slot)
        const half = layerHalfSize(layer)
        const reduced = prefersReducedMotion() ? REDUCED_MOTION_OPACITY : 1
        const opacity = weight * fieldOpacity(speed, airShare) * DUST_OPACITY * reduced
        uniforms.uOpacity.value = opacity
        if (opacity <= 0) return
        // The View's live viewport, in CSS pixels, so resizes and rotation
        // track without a React render.
        renderer.getCurrentViewport(viewport)
        const ratio = renderer.getPixelRatio()
        uniforms.uResolution.value.set(viewport.z / ratio, viewport.w / ratio)
        const p = dustAnchor(camera.position, shipCarry.carried, anchor)
        uniforms.uHalf.value = half
        uniforms.uOffset.value.set(wrapOffset(p.x, half), wrapOffset(p.y, half), wrapOffset(p.z, half))
        const length = streakLength(speed, level, half, airShare)
        const streak = uniforms.uStreak.value as THREE.Vector3
        if (speed > 0) streak.copy(velocity).multiplyScalar(length / speed)
        else streak.set(0, 0, 0)
        uniforms.uNear.value = (camera as THREE.PerspectiveCamera).near
      }
    }
  }, [materials])

  return (
    <>
      {SLOTS.map((slot) => (
        <mesh
          key={slot}
          ref={(mesh) => {
            meshes.current[slot] = mesh
          }}
          geometry={geometry}
          material={materials[slot]}
          frustumCulled={false}
          renderOrder={DUST_RENDER_ORDER}
        />
      ))}
    </>
  )
}
