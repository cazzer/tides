import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import type * as THREE from 'three'
import {
  SUN_RADIUS_KM,
  createEclipseShading,
  updateEclipseShading,
  type ShadedBody,
} from '../eclipse'
import { useStore } from '../store'
import { LUNAR_ECLIPSE_GLOW } from '../lighting'

// Eclipse shadows for a lit material (Phong or Lambert): direct sunlight is
// scaled by the fraction of the Sun's disc visible from each fragment's true
// position (see eclipse.ts, which this mirrors). Spread the result of
// useEclipseShadow() onto the material:
//   <meshPhongMaterial {...useEclipseShadow('earth')} ... />

// Light the atmosphere bends into the shadow, as a fraction of sunlight.
const UMBRA_GLOW: Record<ShadedBody, [number, number, number]> = {
  earth: [0, 0, 0],
  moon: LUNAR_ECLIPSE_GLOW,
}

// Mirrors surfacePoint(): a direction in the body's frame, read as a
// geodetic latitude on the ellipsoid, turned into the scene's axes (km).
const POINT = /* glsl */ `vec3 eclipsePoint(vec3 local) {
  vec3 eclipseLocal = normalize(local);
  float eclipseN = uEclipseBody.x / sqrt(1.0 - uEclipseBody.y * eclipseLocal.y * eclipseLocal.y);
  vec3 eclipseP = eclipseN * vec3(eclipseLocal.x, eclipseLocal.y * (1.0 - uEclipseBody.y), eclipseLocal.z);
  return mat3(modelMatrix) * eclipseP / length(modelMatrix[0].xyz);
}
`

const VERTEX_HEAD = /* glsl */ `
uniform vec2 uEclipseBody;
varying vec3 vEclipsePoint;

${POINT}`

// The vertex's own point.
const VERTEX_BODY = /* glsl */ `
vEclipsePoint = eclipsePoint(position);
`

// Mirrors coveredFraction() and sunVisibleFraction().
const FRAGMENT_HEAD = /* glsl */ `
uniform float uEclipseActive;
uniform vec3 uEclipseSun;
uniform vec4 uEclipseOccluder;
uniform vec3 uEclipseGlow;
varying vec3 vEclipsePoint;

float eclipseCovered(float sunRadius, float occluderRadius, float separation) {
  float r = occluderRadius / sunRadius;
  float d = separation / sunRadius;
  if (d >= 1.0 + r) return 0.0;
  if (d <= abs(r - 1.0)) return r >= 1.0 ? 1.0 : r * r;
  float a = acos(clamp((d * d + 1.0 - r * r) / (2.0 * d), -1.0, 1.0));
  float b = acos(clamp((d * d + r * r - 1.0) / (2.0 * d * r), -1.0, 1.0));
  float k = sqrt(max(0.0, (-d + 1.0 + r) * (d + 1.0 - r) * (d - 1.0 + r) * (d + 1.0 + r)));
  return clamp((a + r * r * b - 0.5 * k) / PI, 0.0, 1.0);
}

// x: visible fraction of the Sun's disc; y: depth into the umbra, 0 at its
// edge and 1 on its axis.
vec2 eclipseSunlight(vec3 point) {
  vec3 toSun = uEclipseSun - point;
  vec3 toOccluder = uEclipseOccluder.xyz - point;
  float sunDistance = length(toSun);
  float occluderDistance = length(toOccluder);
  float sunRadius = asin(${SUN_RADIUS_KM.toFixed(1)} / sunDistance);
  float occluderRadius = asin(min(1.0, uEclipseOccluder.w / occluderDistance));
  float separation = 2.0 * asin(min(1.0,
    0.5 * length(toSun / sunDistance - toOccluder / occluderDistance)));
  float visible = 1.0 - eclipseCovered(sunRadius, occluderRadius, separation);
  float umbra = max(occluderRadius - sunRadius, 1e-6);
  return vec2(visible, clamp((umbra - separation) / umbra, 0.0, 1.0));
}
`

const FRAGMENT_LIGHT = /* glsl */ `
if (uEclipseActive > 0.5) {
  vec2 eclipse = eclipseSunlight(vEclipsePoint);
  float shade = 1.0 - eclipse.x;
  vec3 glow = uEclipseGlow * shade * shade * shade * shade * (1.0 - 0.6 * eclipse.y);
  reflectedLight.directDiffuse *= vec3(eclipse.x) + glow;
  reflectedLight.directSpecular *= eclipse.x;
}
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`eclipse shadow: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** The patch's GLSL, for shaders written whole (the cloud layer): declare
 * the heads, run vertexBody after `position` is known, and call
 * eclipseSunlight(vEclipsePoint) when uEclipseActive > 0.5. point is
 * eclipsePoint() alone, for a fragment shader that finds its own point; it
 * reads uEclipseBody and modelMatrix, which that shader declares.
 * fragmentLight is the lit materials' shading, after lights_fragment_end
 * (the streamed surface tiles, tides-zmw.9.16, take it as the ground). */
export const ECLIPSE_GLSL = {
  point: POINT,
  vertexHead: VERTEX_HEAD,
  vertexBody: VERTEX_BODY,
  fragmentHead: FRAGMENT_HEAD,
  fragmentLight: FRAGMENT_LIGHT,
}

export type MaterialPatch = Pick<THREE.Material, 'onBeforeCompile' | 'customProgramCacheKey'>

export interface EclipseShadow {
  update(t: number): void
  material: MaterialPatch
  /** Shared with every material the shadow is spread onto. */
  uniforms: Record<string, THREE.IUniform>
}

export function createEclipseShadow(body: ShadedBody): EclipseShadow {
  const shading = createEclipseShading(body)
  const uniforms = {
    uEclipseActive: { value: 0 },
    uEclipseBody: {
      value: [shading.bodyRadius, shading.bodyEccentricitySq],
    },
    uEclipseSun: { value: shading.sun },
    uEclipseOccluder: { value: [0, 0, 0, shading.occluderRadius] },
    uEclipseGlow: { value: UMBRA_GLOW[body] },
  }
  return {
    uniforms,
    update(t) {
      updateEclipseShading(shading, body, t)
      uniforms.uEclipseActive.value = shading.active ? 1 : 0
      const occluder = uniforms.uEclipseOccluder.value
      occluder[0] = shading.occluder.x
      occluder[1] = shading.occluder.y
      occluder[2] = shading.occluder.z
    },
    material: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = inject(
          VERTEX_HEAD + shader.vertexShader,
          'begin_vertex',
          VERTEX_BODY
        )
        shader.fragmentShader = inject(
          inject(shader.fragmentShader, 'common', FRAGMENT_HEAD),
          'lights_fragment_end',
          FRAGMENT_LIGHT
        )
      },
      // Every eclipse-shadowed material compiles the same code; the uniforms
      // are per material.
      customProgramCacheKey: () => 'eclipse-shadow',
    },
  }
}

// One shadow per body; share it between that body's materials (the Earth's
// ground and cloud shell).
export function useEclipseShadowState(body: ShadedBody): EclipseShadow {
  const shadow = useMemo(() => createEclipseShadow(body), [body])
  useFrame(() => {
    const { timestamp } = useStore.getState()
    if (typeof timestamp === 'number') shadow.update(timestamp)
  })
  return shadow
}

export function useEclipseShadow(body: ShadedBody): EclipseShadow['material'] {
  return useEclipseShadowState(body).material
}

/** Two onBeforeCompile patches applied in turn, under a combined cache key. */
export function composePatches(...patches: MaterialPatch[]): MaterialPatch {
  return {
    onBeforeCompile(shader, renderer) {
      for (const p of patches) p.onBeforeCompile(shader, renderer)
    },
    customProgramCacheKey: () => patches.map((p) => p.customProgramCacheKey()).join('+'),
  }
}
