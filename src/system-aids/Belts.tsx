// The asteroid and Kuiper belts (tides-2hv.11), mounted by SystemAids.tsx
// while systemAids.belts is on. Each belt is one draw of points whose orbits
// (belt-particles.ts) the vertex shader advances from the sim clock, so the
// CPU sets two uniforms a frame and never touches a particle.
import { useEffect, useMemo, type FC } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  ORBIT_STRIDE,
  SHAPE_STRIDE,
  asteroidBelt,
  kuiperBelt,
  yearsSinceJ2000,
  type BeltOrbits,
} from './belt-particles'
import type { SystemAidProps } from './types'

/** Point diameter, CSS pixels. [TUNE] Under ~1.5 they vanish on a phone. */
export const BELT_POINT_SIZE = 1.8 // [TUNE]
/**
 * Peak opacity of the brightest particle. [TUNE] Low, so the belts read as
 * texture behind the planets rather than as extra stars.
 */
export const ASTEROID_OPACITY = 0.5 // [TUNE]
export const KUIPER_OPACITY = 0.45 // [TUNE]
// Rocky tan inside, warm enough to read apart from the white starfield behind
// it; icy blue-grey out past Neptune.
const ASTEROID_COLOR = new THREE.Color('#c9a172')
const KUIPER_COLOR = new THREE.Color('#9fb3c8')

// beltPosition (belt-particles.ts) in GLSL: keep them in step. The ortho main
// view draws every point the same size, so there is no size attenuation.
const vertexShader = /* glsl */ `
  uniform float uYears;
  uniform float uSize;
  attribute vec4 orbit;
  attribute vec2 shape;
  varying float vBrightness;

  void main() {
    float node = orbit.w;
    float u = orbit.z + 6.28318530718 * fract(uYears * orbit.y) - node;
    float cu = cos(u);
    float su = sin(u);
    float cn = cos(node);
    float sn = sin(node);
    float ci = cos(shape.x);
    vec3 ecliptic = orbit.x * vec3(cn * cu - sn * su * ci, sn * cu + cn * su * ci, su * sin(shape.x));
    vec3 scene = vec3(-ecliptic.x, ecliptic.z, ecliptic.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(scene, 1.0);
    gl_PointSize = uSize;
    vBrightness = shape.y;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vBrightness;

  void main() {
    // A soft round dot rather than the square point sprite.
    float d = length(gl_PointCoord - 0.5);
    float alpha = (1.0 - smoothstep(0.2, 0.5, d)) * uOpacity * vBrightness;
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// No position attribute: the shader builds positions from `orbit`, so the
// draw range sets the count, nothing can compute bounds (frustumCulled off)
// and nothing may raycast it.
function createBeltGeometry(belt: BeltOrbits): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('orbit', new THREE.BufferAttribute(belt.orbit, ORBIT_STRIDE))
  geometry.setAttribute('shape', new THREE.BufferAttribute(belt.shape, SHAPE_STRIDE))
  geometry.setDrawRange(0, belt.count)
  return geometry
}

function createBeltMaterial(color: THREE.Color, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uYears: { value: 0 },
      uSize: { value: BELT_POINT_SIZE },
      uColor: { value: color },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
  })
}

// Generated once and kept: toggling the belts rebuilds only the GL buffers.
let orbits: { asteroids: BeltOrbits; kuiper: BeltOrbits } | null = null
function beltOrbits() {
  orbits ??= { asteroids: asteroidBelt(), kuiper: kuiperBelt() }
  return orbits
}

interface Belt {
  geometry: THREE.BufferGeometry
  material: THREE.ShaderMaterial
}

function noRaycast() {}

// At render time, with the renderer drawing this frame: the sim clock has
// ticked (SimClock runs first) and the pixel ratio is the live one.
function setBeltUniforms(material: THREE.ShaderMaterial, renderer: THREE.WebGLRenderer) {
  const t = useStore.getState().timestamp ?? Date.now()
  material.uniforms.uYears.value = yearsSinceJ2000(t)
  material.uniforms.uSize.value = BELT_POINT_SIZE * renderer.getPixelRatio()
}

export const Belts: FC<SystemAidProps> = ({ distanceScale }) => {
  // Flight spacing can follow once flight-scale.ts (tides-2hv.6) exists.
  if (distanceScale === 'flight') return null
  return <SystemBelts />
}

function SystemBelts() {
  const belts = useMemo<Belt[]>(
    () => [
      {
        geometry: createBeltGeometry(beltOrbits().asteroids),
        material: createBeltMaterial(ASTEROID_COLOR, ASTEROID_OPACITY),
      },
      {
        geometry: createBeltGeometry(beltOrbits().kuiper),
        material: createBeltMaterial(KUIPER_COLOR, KUIPER_OPACITY),
      },
    ],
    []
  )

  useEffect(
    () => () => {
      for (const { geometry, material } of belts) {
        geometry.dispose()
        material.dispose()
      }
    },
    [belts]
  )

  return (
    <>
      {belts.map(({ geometry, material }, i) => (
        <points
          key={i}
          geometry={geometry}
          material={material}
          frustumCulled={false}
          raycast={noRaycast}
          onBeforeRender={(renderer) => setBeltUniforms(material, renderer)}
        />
      ))}
    </>
  )
}
