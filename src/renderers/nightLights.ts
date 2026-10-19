// City lights (the ground's emissive night map) only where the Sun is down:
// they come on through civil twilight and are gone on the day side, which a
// darker, unsaturated day (../lighting.ts) would otherwise show as yellow
// speckle. Spread through composePatches onto the ground's Phong material.
import type * as THREE from 'three'
import type { MaterialPatch } from './eclipseShadow'

const VERTEX_HEAD = /* glsl */ `
varying vec3 vNightLightsDir;
`

const VERTEX_BODY = /* glsl */ `
vNightLightsDir = position;
`

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uNightLightsSun;
varying vec3 vNightLightsDir;
`

// sin(elevation) of the Sun: lights from ~+2° down to full by ~-6°.
const FRAGMENT_BODY = /* glsl */ `
totalEmissiveRadiance *= smoothstep(0.035, -0.1, dot(normalize(vNightLightsDir), uNightLightsSun));
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`night lights: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** `sun`: the Sun's direction in the ground mesh's local frame, kept up to
 * date by the caller (the cloud layer's uSunDir). */
export function nightLightsPatch(sun: THREE.IUniform<THREE.Vector3>): MaterialPatch {
  return {
    onBeforeCompile(shader) {
      shader.uniforms.uNightLightsSun = sun
      shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'begin_vertex', VERTEX_BODY)
      shader.fragmentShader = inject(
        inject(shader.fragmentShader, 'common', FRAGMENT_HEAD),
        'emissivemap_fragment',
        FRAGMENT_BODY
      )
    },
    customProgramCacheKey: () => 'night-lights',
  }
}
