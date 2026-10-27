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
// EarthRenderer updates per camera before the tiles draw. Outside ship mode
// there is no flight (null) and no fill, as on the globe.
//
// Points. In flight the globe breaks its lights into points near the ground
// (../nightPoints.ts, tides-zmw.23); the tiles take its head and its cell
// coordinate, the flight's uNightPointsEye (the eye's, split into whole
// cells and fraction in double on the CPU) plus nightPointsOffset() along
// the ray to the drawn point (here the base's surfaceRay, never the
// quantised surfaceGlobeUv), with the base's analytic derivatives as for
// VIIRS. Both key on the drawn point's direction, so the lights agree where
// the globe and the tiles draw the same ground; where the globe's coarser
// mesh stands off the tiles' surface (its flat cells sag under the sphere,
// its relief is smoother), the point under a pixel differs by that much
// and a light can shift across the hand-off's dissolve.
//
// No varyings, no defines: one program per tileset, keyed by whether the
// flight and the stream are on (fixed for a link).
import * as THREE from 'three'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY } from '../../lighting'
import { GIBS_COLS, GIBS_ROWS } from '../../gibs-patch'
import { GIBS_NIGHT_GLSL } from '../gibsNightPatch'
import { NIGHT_LIGHTS_GLSL, NIGHT_MASK_SUN } from '../nightLights'
import { NIGHT_POINTS_GLSL } from '../nightPoints'
import { injectAfterChunk, renameInSnippet, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile night'

const f = (x: number) => x.toFixed(6)

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

// In flight, the points (header) inside the gate after VIIRS, as the
// globe's land after its VIIRS and before its mask.
const POINTS_HEAD = `${NIGHT_POINTS_GLSL.head}${NIGHT_POINTS_GLSL.offsetHead}uniform vec4 uNightPointsEye;
`
const POINTS_BODY = /* glsl */ `
{
#ifdef GIBS_NIGHT_SIDE
  float nightPointsFine = gibsNightCover;
#else
  float nightPointsFine = 0.0;
#endif
  totalEmissiveRadiance *= nightPoints(emissiveColor.rgb, nightPointsFine, uNightPointsEye.xy,
    uNightPointsEye.zw + nightPointsOffset(uSurfaceEyeGround, surfaceRay),
    surfaceGlobeDx * NIGHT_POINTS_CELLS, surfaceGlobeDy * NIGHT_POINTS_CELLS, surfaceGlobeUv.y,
    float(textureSize(uTileNightMap, 0).x));
}
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
  pointsHead: NIGHT_POINTS_GLSL.head,
  pointsOffsetHead: NIGHT_POINTS_GLSL.offsetHead,
  pointsBody: POINTS_BODY,
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
    (flight ? TILE_NIGHT_GLSL.flightHead + POINTS_HEAD : '') +
    (side ? GIBS_NIGHT_GLSL.fragmentHead(side) : '')
  // The globe's order: the map, VIIRS's redistribution, in flight the
  // points, the night side's mask (on the night side: the gate).
  const emissive =
    NIGHT_GATE_OPEN + CITY_BODY + (side ? GIBS_BODY : '') + (flight ? POINTS_BODY : '') + NIGHT_GATE_CLOSE + MASK_BODY
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
