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

// Eclipse shadows for a lit material (Phong or Lambert): direct sunlight is
// scaled by the fraction of the Sun's disc visible from each fragment's true
// position (see eclipse.ts, which this mirrors). Spread the result of
// useEclipseShadow() onto the material:
//   <meshPhongMaterial {...useEclipseShadow('earth')} ... />

// Light the atmosphere bends into Earth's umbra, as a fraction of sunlight:
// coppery, and brightest near the umbra's edge. Stylised; a real total lunar
// eclipse is ~10⁻⁴ of the full Moon, which would read as black here.
const UMBRA_GLOW: Record<ShadedBody, [number, number, number]> = {
  earth: [0, 0, 0],
  moon: [0.12, 0.032, 0.01],
}

const VERTEX_HEAD = /* glsl */ `
uniform vec2 uEclipseBody;
varying vec3 vEclipsePoint;
`

// Mirrors surfacePoint(): the texel's direction in the body's frame, read as
// a geodetic latitude on the ellipsoid, turned into the scene's axes (km).
const VERTEX_BODY = /* glsl */ `
{
  vec3 eclipseLocal = normalize(position);
  float eclipseN = uEclipseBody.x / sqrt(1.0 - uEclipseBody.y * eclipseLocal.y * eclipseLocal.y);
  vec3 eclipseP = eclipseN * vec3(eclipseLocal.x, eclipseLocal.y * (1.0 - uEclipseBody.y), eclipseLocal.z);
  vEclipsePoint = mat3(modelMatrix) * eclipseP / length(modelMatrix[0].xyz);
}
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

export interface EclipseShadow {
  update(t: number): void
  material: Pick<THREE.Material, 'onBeforeCompile' | 'customProgramCacheKey'>
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
export function useEclipseShadow(body: ShadedBody): EclipseShadow['material'] {
  const shadow = useMemo(() => createEclipseShadow(body), [body])
  useFrame(() => {
    const { timestamp } = useStore.getState()
    if (typeof timestamp === 'number') shadow.update(timestamp)
  })
  return shadow.material
}
