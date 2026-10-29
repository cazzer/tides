// The globe's city lights and night fill on the streamed tiles (tides-
// zmw.9.13): the night map, its night-side mask (../nightLights.ts), the
// VIIRS redistribution under the ship (../gibsNightPatch.ts) and, in
// flight, the adapted eye's fill and the Moon's light, all by the globe's
// own GLSL on its own uniforms, so a tile's night is the globe's night.
//
// City lights. The globe takes them from its Phong emissive: the night map
// in the emissiveMap slot times emissive (CITY_LIGHTS_COLOR at
// CITY_LIGHTS_INTENSITY). A tile has no emissive map and must not take the
// globe's in a slot (TilesRenderer would free it with the tile), so after
// emissivemap_fragment (empty on the tiles) the map is read through the
// link's uniform at the base's surfaceGlobeUv, filtered for the pixel by
// surfaceGlobeTex, and emissiveColor and totalEmissiveRadiance are set as
// three's chunk sets them on the globe. Then, in the globe's text order (on
// the globe gibsNightPatch comes after nightLightsPatch in composePatches,
// so its code lands first): the VIIRS redistribution, then the night side's
// mask.
//
// VIIRS. GIBS_NIGHT_GLSL on the link's stream (texture, mask, origin,
// active, side), renamed to the tiles: the map's coordinate vEmissiveMapUv
// to surfaceGlobeUv (the tiles' Phong declares vMapUv and friends for the
// imagery, so every occurrence is counted), emissiveMap's size to the
// link's night map's, the emissive colour to the city lights' uniform, its
// USE_EMISSIVEMAP guard off (the tiles define no emissive map), and the
// patch coordinate's screen derivatives to the base's analytic ones
// (surfaceGlobeDx/Dy, from the smooth surfaceRay): the globe differences
// its interpolated uv, but the tiles' is per fragment from the quantised
// surfaceGround, which must never be differenced. The patch wraps its
// derivative at the antimeridian; the analytic one has no jump, so the wrap
// does nothing.
//
// Mask and fill. The globe reads the ground's direction from a varying
// (vNightLightsDir, the sphere's position); on the tiles it is the base's
// surfaceUp, in the same frame (the ground mesh's), against the same Sun
// (the link's sunDir, the clouds' uSunDir). The flight's fill (after
// lights_fragment_end, before the eclipse's and the clouds' code there, as
// on the globe) reads normal and vNormal, which Phong gives the tiles as it
// gives the globe; its uniforms are the link's nightFlight, which
// EarthRenderer updates per camera before the tiles draw. Without flight
// detail (flight-detail.ts) there is no flight (null) and no fill, as on the
// globe.
//
// Fade. In flight the globe fades its lights as their finest source's
// texel is magnified past a few pixels (../nightLights.ts, tides-zmw.24),
// after VIIRS and with the mask; the tiles take its functions and call by
// text, the map's width renamed to theirs, and measure the footprint from
// the base's analytic derivatives of the map's uv (surfaceGlobeDx/Dy, no
// antimeridian jump, so no wrap) where the globe differences its view
// position, inside the gate after VIIRS: where the mask is 0 the light is
// dark anyway. Its VIIRS cover is the patch's gibsNightCover, as on the
// globe.
//
// No varyings, no defines: one program per tileset, keyed by whether the
// flight and the stream are on (fixed for a link).
import * as THREE from 'three'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY } from '../../lighting'
import { GIBS_COLS, GIBS_ROWS } from '../../gibs-patch'
import { GIBS_NIGHT_GLSL } from '../gibsNightPatch'
import { NIGHT_LIGHTS_GLSL } from '../nightLights'
import { injectAfterChunk, renameInSnippet, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile night'

const f = (x: number) => x.toFixed(6)

/** sin of the Sun's elevation from which the globe's night mask (and its
 * fill) is 0: nightLights.ts's smoothstep(0.035, -0.1, ...). */
export const NIGHT_MASK_SUN = 0.035

// The night map and the globe's emissive colour (emissive times its
// intensity, as three sets the uniform).
const CITY_HEAD = /* glsl */ `
uniform sampler2D uTileNightMap;
uniform vec3 uTileCityLights;
`

// What three's emissivemap_fragment does on the globe, at the globe's uv.
const CITY_BODY = /* glsl */ `
emissiveColor = surfaceGlobeTex(uTileNightMap, surfaceGlobeUv);
totalEmissiveRadiance = uTileCityLights * emissiveColor.rgb;
`

// Where the mask (below) is 0, as the globe's is from NIGHT_MASK_SUN up, the
// lights are dark whatever the map holds: the map and VIIRS are skipped
// there (no implicit derivatives inside: surfaceGlobeTex and the patch take
// the base's), which leaves the day side's pixels as they were. The mask
// itself still runs, as the globe's.
const NIGHT_GATE_OPEN = /* glsl */ `
vec4 emissiveColor = vec4(0.0);
totalEmissiveRadiance = vec3(0.0);
if (dot(surfaceUp, uNightLightsSun) < ${f(NIGHT_MASK_SUN)}) {
`
const NIGHT_GATE_CLOSE = '}\n'

const MASK_HEAD = renameInSnippet(NIGHT_LIGHTS_GLSL.fragmentHead, 'varying vec3 vNightLightsDir;', '', WHAT, 1)
const MASK_BODY = renameInSnippet(NIGHT_LIGHTS_GLSL.fragmentBody, 'vNightLightsDir', 'surfaceUp', WHAT, 1)
// The fill's block, on the night side only: it scales by the same mask
// (1 - smoothstep(-0.1, 0.035, ...)), 0 from NIGHT_MASK_SUN up.
const FLIGHT_LIGHT = `if (dot(surfaceUp, uNightLightsSun) < ${f(NIGHT_MASK_SUN)})${renameInSnippet(
  NIGHT_LIGHTS_GLSL.flightLightBody,
  'vNightLightsDir',
  'surfaceUp',
  WHAT,
  1
)}`

// The patch's coordinate is (fract(u - ox / COLS) * COLS, (1 - v) * ROWS - oy).
const nightDerivative = (d: string) => `(${d} * vec2(${f(GIBS_COLS)}, ${f(-GIBS_ROWS)}))`

let body = GIBS_NIGHT_GLSL.emissiveBody
body = renameInSnippet(body, '#ifdef USE_EMISSIVEMAP', '', WHAT, 1)
body = renameInSnippet(body, '#endif', '', WHAT, 1)
body = renameInSnippet(body, 'vEmissiveMapUv', 'surfaceGlobeUv', WHAT, 3)
body = renameInSnippet(body, 'textureSize(emissiveMap, 0)', 'textureSize(uTileNightMap, 0)', WHAT, 1)
body = renameInSnippet(body, 'dFdx(nightAt)', nightDerivative('surfaceGlobeDx'), WHAT, 1)
body = renameInSnippet(body, 'dFdy(nightAt)', nightDerivative('surfaceGlobeDy'), WHAT, 1)
body = renameInSnippet(body, 'emissive * emissiveColor.rgb', 'uTileCityLights * emissiveColor.rgb', WHAT, 1)
const GIBS_BODY = body

const FADE_WIDTH = renameInSnippet(NIGHT_LIGHTS_GLSL.fadeWidth, 'textureSize(emissiveMap, 0)', 'textureSize(uTileNightMap, 0)', WHAT, 1)
const FADE_PIXEL = `  float nightFadePixel = nightLightsUvPixel(surfaceGlobeDx, surfaceGlobeDy, surfaceGlobeUv.y, nightFadeWidth);
`
const FADE_BODY = `{${FADE_WIDTH}${FADE_PIXEL}${NIGHT_LIGHTS_GLSL.fadeCall}}
`

/** The adapter's GLSL (the test checks it against the globe's). */
export const TILE_NIGHT_GLSL = {
  gateOpen: NIGHT_GATE_OPEN,
  gateClose: NIGHT_GATE_CLOSE,
  cityHead: CITY_HEAD,
  cityBody: CITY_BODY,
  maskHead: MASK_HEAD,
  maskBody: MASK_BODY,
  flightHead: NIGHT_LIGHTS_GLSL.flightFragmentHead,
  flightLight: FLIGHT_LIGHT,
  gibsHead: GIBS_NIGHT_GLSL.fragmentHead,
  gibsBody: GIBS_BODY,
  fadeHead: NIGHT_LIGHTS_GLSL.fadeHead,
  fadeBody: FADE_BODY,
}

/** The globe's emissive uniform: CITY_LIGHTS_COLOR (sRGB, made linear as
 * R3F's prop makes it) times CITY_LIGHTS_INTENSITY. */
export function cityLightsColor(target = new THREE.Color()): THREE.Color {
  return target.set(CITY_LIGHTS_COLOR).multiplyScalar(CITY_LIGHTS_INTENSITY)
}

export const tileNight: TileAdapter = (link) => {
  const flight = link.nightFlight
  const side = link.gibsNight.side
  const uniforms: Record<string, THREE.IUniform> = {
    uTileNightMap: link.maps.night,
    uTileCityLights: { value: cityLightsColor() },
    uNightLightsSun: link.sunDir,
    ...flight,
    ...(side ? link.gibsNight.uniforms : {}),
  }
  const head =
    CITY_HEAD +
    MASK_HEAD +
    (flight ? TILE_NIGHT_GLSL.flightHead + TILE_NIGHT_GLSL.fadeHead : '') +
    (side ? GIBS_NIGHT_GLSL.fragmentHead(side) : '')
  // The globe's order: the map, VIIRS's redistribution, in flight the fade,
  // the night side's mask (on the night side: the gate).
  const emissive =
    NIGHT_GATE_OPEN + CITY_BODY + (side ? GIBS_BODY : '') + (flight ? FADE_BODY : '') + NIGHT_GATE_CLOSE + MASK_BODY
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        let fragment = surfaceInject(shader.fragmentShader, 'fragmentHead', head)
        fragment = injectAfterChunk(fragment, 'emissivemap_fragment', emissive, WHAT)
        if (flight) fragment = injectAfterChunk(fragment, 'lights_fragment_end', FLIGHT_LIGHT, WHAT)
        shader.fragmentShader = fragment
      },
      customProgramCacheKey: () => `night-surface${flight ? '-flight' : ''}${side ? `-gibs${side}` : ''}`,
    },
  }
}
