// City lights (the ground's emissive night map) only where the Sun is down:
// they come on through civil twilight and are gone on the day side, which a
// darker, unsaturated day (../lighting.ts) would otherwise show as yellow
// speckle. Spread through composePatches onto the ground's Phong material.
//
// In flight the same night side also takes the adapted eye's fill and the
// Moon's light (tides-tvr.2; ../night-flight.ts), from uniforms the flight
// sets per camera (createNightFlight); without one the patch is as before.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { CLOUD_AMBIENT } from '../lighting'
import { moonOffset } from '../ephemeris'
import {
  MOON_UP_FROM,
  MOON_UP_TO,
  MOONLIGHT_RGB,
  NIGHT_FILL_RGB,
  moonIlluminatedFraction,
  moonlightStrength,
  nightAdaptation,
  nightCloudAmbient,
} from '../night-flight'
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

const f = (x: number) => x.toFixed(6)

const FLIGHT_FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uNightMoon;
uniform vec3 uNightMoonView;
uniform vec3 uNightFill;
uniform vec3 uNightMoonLight;
`

/** How far the night lights' albedo goes toward its luminance: the eye
 * sees little colour by night (scotopic vision), so lit at the day's hue a
 * moonlit sea and fields read as a dim day. The lights' cool colours keep a
 * tint. */
export const NIGHT_DESATURATION = 0.75

// After the lights, the ground's horizon occlusion and its sky fill (later
// in the chain, so their code lands first), and before the cloud shadow and
// the eclipse, which dim only the Sun's light. On the night side as the
// city lights are: the fill from the sky the ground's slope faces, the
// Moon's light on the slope from where it stands, both on the albedo greyed
// toward its luminance (a local: later chunks read diffuseColor). Moonlight
// has no shadows.
const FLIGHT_LIGHT_BODY = /* glsl */ `
{
  vec3 nightUp = normalize(vNightLightsDir);
  float nightSide = 1.0 - smoothstep(-0.1, 0.035, dot(nightUp, uNightLightsSun));
  float moonLit = smoothstep(${f(MOON_UP_FROM)}, ${f(MOON_UP_TO)}, dot(nightUp, uNightMoon))
    * max(dot(normal, uNightMoonView), 0.0);
  float sky = 0.5 + 0.5 * dot(normal, normalize(vNormal));
  vec3 nightAlbedo = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))),
    ${f(NIGHT_DESATURATION)});
  reflectedLight.indirectDiffuse += nightSide * (uNightFill * sky + uNightMoonLight * moonLit)
    * BRDF_Lambert(nightAlbedo);
}
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`night lights: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** The night fill's and the moonlight's uniforms (createNightFlight). */
export interface NightFlightUniforms {
  /** The Moon's direction in the ground mesh's frame, and in view space. */
  uNightMoon: THREE.IUniform<THREE.Vector3>
  uNightMoonView: THREE.IUniform<THREE.Vector3>
  /** Linear, already scaled by the adaptation (and the Moon's by its phase). */
  uNightFill: THREE.IUniform<THREE.Color>
  uNightMoonLight: THREE.IUniform<THREE.Color>
}

/** `sun`: the Sun's direction in the ground mesh's local frame, kept up to
 * date by the caller (the cloud layer's uSunDir). `flight`: the night
 * flight's uniforms, in ship mode. */
export function nightLightsPatch(sun: THREE.IUniform<THREE.Vector3>, flight?: NightFlightUniforms): MaterialPatch {
  return {
    onBeforeCompile(shader) {
      shader.uniforms.uNightLightsSun = sun
      shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'begin_vertex', VERTEX_BODY)
      shader.fragmentShader = inject(
        inject(shader.fragmentShader, 'common', flight ? FRAGMENT_HEAD + FLIGHT_FRAGMENT_HEAD : FRAGMENT_HEAD),
        'emissivemap_fragment',
        FRAGMENT_BODY
      )
      if (!flight) return
      Object.assign(shader.uniforms, flight)
      shader.fragmentShader = inject(shader.fragmentShader, 'lights_fragment_end', FLIGHT_LIGHT_BODY)
    },
    customProgramCacheKey: () => (flight ? 'night-lights-flight' : 'night-lights'),
  }
}

export interface NightFlight {
  uniforms: NightFlightUniforms
  /** For the drawing camera, before the ground draws: `ground` is the
   * ground mesh, whose local sphere has `radius`. Reads the Sun from the
   * `sun` uniform, so after it is set for the frame. */
  update(ground: THREE.Object3D, camera: THREE.Camera, radius: number): void
}

/**
 * The night fill and the moonlight for the ground's patch, and the cloud
 * shell's ambient (`cloudAmbient`, the shell's uAmbient), by the drawing
 * camera's adaptation: per draw and without smoothing, so each view is lit
 * for its own eye and a jump in time lands lit at once.
 */
export function createNightFlight(sun: THREE.IUniform<THREE.Vector3>, cloudAmbient: THREE.IUniform<number>): NightFlight {
  const uniforms: NightFlightUniforms = {
    uNightMoon: { value: new THREE.Vector3(0, 1, 0) },
    uNightMoonView: { value: new THREE.Vector3(0, 1, 0) },
    uNightFill: { value: new THREE.Color(0, 0, 0) },
    uNightMoonLight: { value: new THREE.Color(0, 0, 0) },
  }
  const moonWorld = new THREE.Vector3()
  let moonAt: number | null = null
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const sunWorld = new THREE.Vector3()
  const up = new THREE.Vector3()
  return {
    uniforms,
    update(ground, camera, radius) {
      const { timestamp } = useStore.getState()
      if (timestamp == null) return
      // From Earth's centre in scene axes; the drawn Moon sits nearer in
      // flight (flight-scale.ts), so seen low it can be some degrees off.
      if (moonAt !== timestamp) {
        moonWorld.fromArray(moonOffset(timestamp)).normalize()
        moonAt = timestamp
      }
      ground.matrixWorld.decompose(position, quaternion, scale)
      // The Sun is the scene's origin.
      sunWorld.copy(position).negate().normalize()
      const strength = moonlightStrength(moonIlluminatedFraction(sunWorld, moonWorld))
      const moon = uniforms.uNightMoon.value.copy(moonWorld).applyQuaternion(quaternion.invert())
      uniforms.uNightMoonView.value.copy(moonWorld).transformDirection(camera.matrixWorldInverse)
      ground.worldToLocal(up.setFromMatrixPosition(camera.matrixWorld))
      const gap = up.length() / radius - 1
      up.normalize()
      const adaptation = nightAdaptation(up.dot(sun.value), gap)
      uniforms.uNightFill.value.copy(NIGHT_FILL_RGB).multiplyScalar(adaptation)
      uniforms.uNightMoonLight.value.copy(MOONLIGHT_RGB).multiplyScalar(adaptation * strength)
      cloudAmbient.value = nightCloudAmbient(adaptation, strength, up.dot(moon))
    },
  }
}

/** The night flight in ship mode, else null; the cloud ambient goes back
 * to CLOUD_AMBIENT when the flight ends. */
export function useNightFlight(sun: THREE.IUniform<THREE.Vector3>, cloudAmbient: THREE.IUniform<number>): NightFlight | null {
  const shipMode = useStore((s) => s.shipMode)
  const flight = useMemo(() => (shipMode ? createNightFlight(sun, cloudAmbient) : null), [shipMode, sun, cloudAmbient])
  useEffect(
    () => () => {
      if (flight) cloudAmbient.value = CLOUD_AMBIENT
    },
    [flight, cloudAmbient]
  )
  return flight
}
