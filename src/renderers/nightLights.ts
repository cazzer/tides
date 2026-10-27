// City lights (the ground's emissive night map) only where the Sun is down:
// they come on through civil twilight and are gone on the day side, which a
// darker, unsaturated day (../lighting.ts) would otherwise show as yellow
// speckle. Spread through composePatches onto the ground's Phong material.
//
// In flight the same night side also takes the adapted eye's fill and the
// Moon's light (tides-tvr.2; ../night-flight.ts), from uniforms the flight
// sets per camera (createNightFlight); without one the patch is as before.
// In flight the lights also fade out as the ground nears and their sources'
// texels are magnified past a few pixels (tides-zmw.24; the fade, below).
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { CLOUD_AMBIENT } from '../lighting'
import { moonOffset } from '../ephemeris'
import { GIBS_GROUND_WIDTH } from '../gibs-patch'
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

// The fade (tides-zmw.24). From orbit the night map's texel (3.7 km at
// 10800 px, 19.5 km at the phones' 2048) and VIIRS's (500 m,
// ./gibsNightPatch.ts) are a pixel or less and the glow is right.
// Descending, a texel spans tens, then hundreds of pixels and the lights
// become a flat orange smear, which no finer source can resolve. In flight
// the emissive fades toward NIGHT_FADE_FLOOR as the finest source in play is
// magnified past NIGHT_FADE_TEXEL_PX_START pixels a texel, down by
// NIGHT_FADE_TEXEL_PX_END (smooth in log2 between). The magnification is
// across the pixel footprint's narrow axis (on the ground, east-west
// narrowed by cos(lat)): at a grazing view a pixel is long along the view
// however small across it, and its narrow axis grows smoothly away from the
// eye, so the far band fades as smoothly as the near ground, with no edge
// across the frame.
//
// The finest source is VIIRS's where its patch covers (the patch's
// gibsNightCover), else the map's, mixed in log2 by the cover.
//
// From orbit the map alone can be magnified past START where VIIRS doesn't
// cover (yet): 1500 km straight down on a 2880-row screen (a 1440 px window
// at the page's highest pixel ratio, 2) through the ship's 60° FOV is a
// ~601 m pixel, ~6 px a 3.7 km texel, and a phone's (~1700 rows, ~1 km)
// ~19 px a 19.5 km one. So the fade also waits for the footprint's narrow
// axis to shrink from NIGHT_FADE_PIXEL_M_OFF to NIGHT_FADE_PIXEL_M_FULL on
// the ground: from 1500 km up the factor is exactly 1 on every screen.
//
// Precision. On the globe the derivatives are of the interpolated map uv,
// whose float32 step is up to 2^-24 (u and v from 0.5 up): 2.4 m east-west
// at the equator, 1.2 m north-south. The step's error matters only once it
// is some of the narrow axis, which by then is tens of metres or less: past
// END at the map's texel alone (116 m), and near END with VIIRS's (15 m),
// where with FLOOR 0 the lights are ~0.12 of themselves at a 24 m axis (a
// step a tenth of it), and one step's error moves them by at most ~0.045
// of their full light anywhere (at ~29 m, where they are ~0.22): a faint
// shimmer at worst, on lights mostly gone (nightLights.test.ts holds the
// numbers). The tiles take the base's analytic surfaceGlobeDx/Dy instead,
// never differenced. The narrow axis is taken in map texels, so its squares
// stay normal float32 down to a millimetre's footprint; a zero footprint
// (the uv's float32 step the same across a pixel) is fully faded.

/** Pixels a texel of the finest source in play from which the night lights
 * fade in flight, and by which they are at NIGHT_FADE_FLOOR. */
export const NIGHT_FADE_TEXEL_PX_START = 4
export const NIGHT_FADE_TEXEL_PX_END = 32
/** Of the lights, what is kept past END. */
export const NIGHT_FADE_FLOOR = 0.0
/** The footprint's narrow axis on the ground, metres, over which the fade is
 * off and under which it is whole (the orbit's guard, above). */
export const NIGHT_FADE_PIXEL_M_OFF = 600
export const NIGHT_FADE_PIXEL_M_FULL = 300
/** The equator's length, metres, as the night map's width spans it. */
export const NIGHT_FADE_EQUATOR_M = 2 * Math.PI * 6371000

// Declarations after common (PI is three's). nightLightsNarrow is the
// smaller singular value of the footprint [a b]. nightLightsFade is the
// emissive's factor: dx and dy are the night map's uv's screen derivatives
// (no jump at the antimeridian), v its v, mapWidth the map's width in
// texels and fine VIIRS's cover (0 to 1).
const FADE_HEAD = /* glsl */ `
float nightLightsNarrow(vec2 a, vec2 b) {
  float frobenius = dot(a, a) + dot(b, b);
  float det = abs(a.x * b.y - a.y * b.x);
  return det / max(sqrt(0.5 * (frobenius + sqrt(max(frobenius * frobenius - 4.0 * det * det, 0.0)))), 1e-12);
}
float nightLightsFade(vec2 dx, vec2 dy, float v, float mapWidth, float fine) {
  // In map texels at the equator (a texel's north-south size anywhere): a
  // turn of u is the equator, narrowed east-west by cos(lat); of v, half.
  vec2 m = vec2(sin(v * PI), 0.5) * mapWidth;
  float logWidth = log2(max(mapWidth, 1e-6));
  float pixel = log2(max(nightLightsNarrow(dx * m, dy * m), 1e-6));
  float texelPx = fine * (logWidth - ${f(Math.log2(GIBS_GROUND_WIDTH))}) - pixel;
  float pixelM = pixel + ${f(Math.log2(NIGHT_FADE_EQUATOR_M))} - logWidth;
  float near = 1.0 - smoothstep(${f(Math.log2(NIGHT_FADE_PIXEL_M_FULL))}, ${f(Math.log2(NIGHT_FADE_PIXEL_M_OFF))}, pixelM);
  return mix(1.0, ${f(NIGHT_FADE_FLOOR)},
    smoothstep(${f(Math.log2(NIGHT_FADE_TEXEL_PX_START))}, ${f(Math.log2(NIGHT_FADE_TEXEL_PX_END))}, texelPx) * near);
}
`

// The fade's call, which the tiles take by rename: the derivatives are
// nightFadeDx/Dy, VIIRS's cover the patch's where it is on.
const FADE_CALL = /* glsl */ `
#ifdef GIBS_NIGHT_SIDE
  float nightFadeFine = gibsNightCover;
#else
  float nightFadeFine = 0.0;
#endif
  totalEmissiveRadiance *= nightLightsFade(nightFadeDx, nightFadeDy, vEmissiveMapUv.y,
    float(textureSize(emissiveMap, 0).x), nightFadeFine);
`

// In flight, after the map and VIIRS (whose code lands first), with the
// mask: the uv's derivatives in main's top level, before any branch,
// wrapped at the antimeridian, where u jumps by a turn.
const FADE_BODY = /* glsl */ `
#ifdef USE_EMISSIVEMAP
{
  vec2 nightFadeDx = dFdx(vEmissiveMapUv);
  vec2 nightFadeDy = dFdy(vEmissiveMapUv);
  nightFadeDx.x -= floor(nightFadeDx.x + 0.5);
  nightFadeDy.x -= floor(nightFadeDy.x + 0.5);
${FADE_CALL}}
#endif
`

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** nightLightsFade() in double, for the tests: `dx` and `dy` the map uv's
 * screen derivatives, `v` its v, `mapWidth` the night map's width, `fine`
 * VIIRS's cover. */
export function nightLightsFade(
  dx: readonly [number, number],
  dy: readonly [number, number],
  v: number,
  mapWidth: number,
  fine: number
): number {
  const mx = Math.sin(v * Math.PI) * mapWidth
  const my = 0.5 * mapWidth
  const [ax, ay, bx, by] = [dx[0] * mx, dx[1] * my, dy[0] * mx, dy[1] * my]
  const frobenius = ax * ax + ay * ay + bx * bx + by * by
  const det = Math.abs(ax * by - ay * bx)
  const wide = Math.sqrt(0.5 * (frobenius + Math.sqrt(Math.max(frobenius * frobenius - 4 * det * det, 0))))
  const logWidth = Math.log2(Math.max(mapWidth, 1e-6))
  const pixel = Math.log2(Math.max(det / Math.max(wide, 1e-12), 1e-6))
  const texelPx = fine * (logWidth - Math.log2(GIBS_GROUND_WIDTH)) - pixel
  const pixelM = pixel + Math.log2(NIGHT_FADE_EQUATOR_M) - logWidth
  const near = 1 - smoothstep(Math.log2(NIGHT_FADE_PIXEL_M_FULL), Math.log2(NIGHT_FADE_PIXEL_M_OFF), pixelM)
  const t = smoothstep(Math.log2(NIGHT_FADE_TEXEL_PX_START), Math.log2(NIGHT_FADE_TEXEL_PX_END), texelPx) * near
  return 1 + (NIGHT_FADE_FLOOR - 1) * t
}

/** The patch's GLSL for the streamed tiles to reuse by text (tides-zmw.9.13):
 * the heads after common, the mask after emissivemap_fragment, the flight's
 * light after lights_fragment_end; in flight the fade's head after common
 * and its call (fadeCall, inside the globe's fadeBody) before the mask. */
export const NIGHT_LIGHTS_GLSL = {
  fragmentHead: FRAGMENT_HEAD,
  fragmentBody: FRAGMENT_BODY,
  flightFragmentHead: FLIGHT_FRAGMENT_HEAD,
  flightLightBody: FLIGHT_LIGHT_BODY,
  fadeHead: FADE_HEAD,
  fadeCall: FADE_CALL,
  fadeBody: FADE_BODY,
}

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
        inject(shader.fragmentShader, 'common', flight ? FRAGMENT_HEAD + FLIGHT_FRAGMENT_HEAD + FADE_HEAD : FRAGMENT_HEAD),
        'emissivemap_fragment',
        flight ? FADE_BODY + FRAGMENT_BODY : FRAGMENT_BODY
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
