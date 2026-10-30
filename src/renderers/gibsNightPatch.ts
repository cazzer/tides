// City lights under the ship at night (tides-tvr.2): GIBS's VIIRS 2012
// lights (../gibs-patch.ts GIBS_NIGHT_LAYER), streamed like the day imagery
// (./gibsStream.ts) while some of the patch can be on the night side, into
// an R8 linear texture, and brought onto the night map's texel on the
// ground's Phong material through composePatches. Near the ground the night map's
// texels are kilometres wide and its lights show as squares; VIIRS at 500 m
// resolves them into towns and roads.
//
// VIIRS draws its lights on a faint blue ground, which the map lacks: each
// tile is stripped to its warm light as it is written (stripNightLight). The
// map and VIIRS are the same 2012 composite and register to the texel, but
// the map is graded far from linearly against VIIRS (its faint lights are
// cut to black, its cores much as VIIRS's), so no one scale adds VIIRS's
// detail to it without lighting what it left dark. The patch instead
// redistributes each map texel's light: the map times the lights over
// themselves at the map's texel. That keeps the map's colour and its light
// at its texel, so nothing shows a seam and the patch fades out by itself
// where the map resolves the lights, and it gathers a lit square into the
// towns and roads inside it. Faint lights the map cut stay dark, as the map
// shows them from altitude. The albedo, the night side's mask
// (./nightLights.ts, whose code follows) and everything lit are untouched.
import type { RefObject } from 'react'
import * as THREE from 'three'
import {
  createGibsTileStore,
  GIBS_COLS,
  GIBS_GROUND_WIDTH,
  GIBS_ROWS,
  GIBS_TILE_PX,
  gibsNightTileUrl,
  nightPatchWanted,
} from '../gibs-patch'
import { createGibsStream, EDGE_TILES, useStreamedPatch, type GibsStreamPass, type StreamedPatch, type StreamedPatchUse } from './gibsStream'

// Shared by every flight. GIBS serves these no-store, so this is the only
// cache: 160 tiles is ~9 MB of JPEG, a desktop's patch twice over.
const store = createGibsTileStore(async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GIBS night tile ${url}: HTTP ${response.status}`)
  return response.blob()
}, 160)

/** Network requests for GIBS night tiles this page has made. */
export function gibsNightTileRequests(): number {
  return store.requests
}

/**
 * VIIRS's ground under the lights is a dim blue (red at most 0.28 of blue in
 * every region sampled, linear), its lights warm. The strip
 * keeps red less NIGHT_STRIP_BLUE of blue and a floor for the JPEG's noise,
 * which leaves lightless tiles at exactly 0 and the lights ~0.85 of their
 * red. The ratio cancels any scale, so NIGHT_PATCH_GAIN only spreads the
 * strip over the 8-bit target, whose steps would otherwise band the dim
 * lights: the brightest stripped texel in seven regions sampled (Europe, the
 * Great Lakes, the US east coast, northern India, Japan, the Nile, south-east
 * Brazil) is 0.944, which it takes to 0.99.
 */
export const NIGHT_STRIP_BLUE = 0.35
export const NIGHT_STRIP_FLOOR = 0.002
export const NIGHT_PATCH_GAIN = 1.05
/** Added to both sides of the ratio, in stored units: three 8-bit steps and
 * more, so the steps and the JPEG's noise in the dimmest lights don't swing
 * it, and a texel VIIRS shows dark keeps the map's light. */
export const NIGHT_RATIO_FLOOR = 4 / 255
/** Of a tile's width, the fade toward an edge shared with a tile that isn't
 * shown: wider than the day patch's (./gibsStream.ts SEAM_TILES), as the
 * coarse reads reach a map texel and its mip's footprint each way, ~136
 * texels on phones (2048 px map) against the day's 128 px ramp. */
const NIGHT_SEAM_TILES = 0.3

/** A VIIRS texel's light as the target stores it, from its linear colour. */
export function stripNightLight(r: number, _g: number, b: number): number {
  return Math.max(r - NIGHT_STRIP_BLUE * b - NIGHT_STRIP_FLOOR, 0) * NIGHT_PATCH_GAIN
}

const f = (x: number) => x.toFixed(6)

// Draws a tile, stripped, into the slot the target's viewport frames: the
// tile is read raw (sRGB) and the target holds linear light.
const STRIP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
const STRIP_FRAGMENT = /* glsl */ `
uniform sampler2D uTile;
varying vec2 vUv;
void main() {
  vec3 c = sRGBTransferEOTF(texture2D(uTile, vUv)).rgb;
  gl_FragColor = vec4(max(c.r - ${f(NIGHT_STRIP_BLUE)} * c.b - ${f(NIGHT_STRIP_FLOOR)}, 0.0) * ${f(NIGHT_PATCH_GAIN)}, 0.0, 0.0, 1.0);
}
`

// The stream's pass; freeing just its tile keeps the program for the next
// approach.
function createStrip(): GibsStreamPass {
  const tile = new THREE.Texture()
  tile.flipY = false
  tile.generateMipmaps = false
  tile.magFilter = tile.minFilter = THREE.NearestFilter
  const material = new THREE.ShaderMaterial({
    uniforms: { uTile: { value: tile } },
    vertexShader: STRIP_VERTEX,
    fragmentShader: STRIP_FRAGMENT,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene().add(quad)
  return {
    scene,
    // The quad ignores it, but under reversed-Z three refits the projection
    // of any camera it first draws with (tides-zmw.9.3), and a bare Camera
    // has no updateProjectionMatrix.
    camera: new THREE.OrthographicCamera(),
    tile,
    dispose() {
      tile.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}

// One channel, linear, with mips: 4096² is 16.8 MB, 22.4 MB with its mips
// (5.6 MB at 2048² on phones).
function createTarget(side: number, gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(side * GIBS_TILE_PX, side * GIBS_TILE_PX, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    anisotropy: gl.capabilities.getMaxAnisotropy(),
    depthBuffer: false,
  })
}

const fragmentHead = (side: number) => /* glsl */ `
uniform sampler2D uGibsNight;
uniform sampler2D uGibsNightMask;
// The patch's north-west tile: column, row.
uniform vec2 uGibsNightOrigin;
uniform float uGibsNightActive;
#define GIBS_NIGHT_SIDE ${f(side)}
// The patch's cover where it ran (0 elsewhere), for the night lights' fade
// in flight (./nightLights.ts), whose code follows: where VIIRS covers, its
// texel is the finest the lights are drawn from.
float gibsNightCover = 0.0;

// A slot's fade-in, for unwrapped tile coordinates.
float gibsNightMask(ivec2 tile) {
  return texelFetch(uGibsNightMask, tile & ${side - 1}, 0).r;
}
`

// After the night map's texel is read, before the night side's mask (whose
// patch is earlier in the chain) scales the light. vEmissiveMapUv is the
// map's own coordinate, so the patch registers with it.
const EMISSIVE_BODY = /* glsl */ `
#ifdef USE_EMISSIVEMAP
if (uGibsNightActive > 0.5) {
  // Tiles from the patch's north-west corner; derivatives before branching.
  vec2 nightAt = vec2(
    fract(vEmissiveMapUv.x - uGibsNightOrigin.x / ${f(GIBS_COLS)}) * ${f(GIBS_COLS)},
    (1.0 - vEmissiveMapUv.y) * ${f(GIBS_ROWS)} - uGibsNightOrigin.y);
  vec2 nightDx = dFdx(nightAt);
  vec2 nightDy = dFdy(nightAt);
  nightDx.x -= ${f(GIBS_COLS)} * floor(nightDx.x / ${f(GIBS_COLS)} + 0.5);
  nightDy.x -= ${f(GIBS_COLS)} * floor(nightDy.x / ${f(GIBS_COLS)} + 0.5);
  // log2 of the map's texel in patch texels (2.92 for 10800 px, 5.32 for
  // 2048), and of the pixel's.
  vec2 nightMapSize = vec2(textureSize(emissiveMap, 0));
  float nightMapLod = log2(${f(GIBS_GROUND_WIDTH)} / nightMapSize.x);
  float nightPixelLod = log2(max(length(nightDx), length(nightDy)) * ${f(GIBS_TILE_PX)});
  float nightEdge = min(min(nightAt.x, GIBS_NIGHT_SIDE - nightAt.x), min(nightAt.y, GIBS_NIGHT_SIDE - nightAt.y));
  if (nightEdge > 0.0 && nightPixelLod < nightMapLod) {
    // Unwrapped tile coordinates, the fade-ins multiplied toward each edge,
    // as for the day patch (./gibsPatch.ts) over a wider seam.
    vec2 q = uGibsNightOrigin + nightAt;
    ivec2 cell = ivec2(floor(q));
    vec2 e = fract(q) - 0.5;
    ivec2 toward = ivec2(sign(e));
    vec2 ramp = smoothstep(${f(0.5 - NIGHT_SEAM_TILES)}, 0.5, abs(e));
    float mask = gibsNightMask(cell)
      * mix(1.0, gibsNightMask(cell + ivec2(toward.x, 0)), ramp.x)
      * mix(1.0, gibsNightMask(cell + ivec2(0, toward.y)), ramp.y)
      * mix(1.0, gibsNightMask(cell + toward), ramp.x * ramp.y);
    // Faded over the last mip before the map resolves as much. No fade at
    // the poles: nothing lights them.
    float cover = mask * smoothstep(0.0, ${f(EDGE_TILES)}, nightEdge)
      * (1.0 - smoothstep(nightMapLod - 1.0, nightMapLod, nightPixelLod));
    gibsNightCover = cover;
    if (cover > 0.0) {
      vec2 st = q / GIBS_NIGHT_SIDE;
      float fine = textureGrad(uGibsNight, st, nightDx / GIBS_NIGHT_SIDE, nightDy / GIBS_NIGHT_SIDE).r;
      // The patch as the map shows it: at the map's texel, read at the four
      // map texel centres round the pixel and blended as the map is
      // magnified, so an isolated light keeps no square halo.
      vec2 w = fract(vEmissiveMapUv * nightMapSize - 0.5);
      vec2 texel = vec2(${f(GIBS_COLS)}, ${f(-GIBS_ROWS)}) / nightMapSize / GIBS_NIGHT_SIDE;
      vec2 s00 = st - w * texel;
      float coarse = mix(
        mix(textureLod(uGibsNight, s00, nightMapLod).r, textureLod(uGibsNight, s00 + vec2(texel.x, 0.0), nightMapLod).r, w.x),
        mix(textureLod(uGibsNight, s00 + vec2(0.0, texel.y), nightMapLod).r, textureLod(uGibsNight, s00 + texel, nightMapLod).r, w.x),
        w.y);
      emissiveColor.rgb *= mix(1.0, (fine + ${f(NIGHT_RATIO_FLOOR)}) / (coarse + ${f(NIGHT_RATIO_FLOOR)}), cover);
      // emissive is the material's colour times its intensity.
      totalEmissiveRadiance = emissive * emissiveColor.rgb;
    }
  }
}
#endif
`

/** The patch's GLSL for the streamed tiles to reuse by text (tides-zmw.9.16):
 * fragmentHead(side) after common, emissiveBody after emissivemap_fragment. */
export const GIBS_NIGHT_GLSL = { fragmentHead, emissiveBody: EMISSIVE_BODY }

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`GIBS night patch: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

export type GibsNightPatch = StreamedPatch

const _sun = new THREE.Vector3()

/** A patch `side` tiles square (gibsPatchSide); 0 for none. */
export function createGibsNightPatch(side: number): GibsNightPatch {
  if (side === 0) {
    return {
      material: { onBeforeCompile() {}, customProgramCacheKey: () => '' },
      update() {},
      release() {},
      probes: () => [],
      uniforms: {},
      side: 0,
    }
  }
  const stream = createGibsStream({
    side,
    store,
    tileUrl: gibsNightTileUrl,
    label: 'GIBS night',
    fallback: 'the night map',
    createTarget: (gl) => createTarget(side, gl),
    createPass: createStrip,
    // The Sun from the ground's own transform (it is the scene's origin):
    // the cloud layer's uSunDir is still its default on the first frame.
    wanted: (subPoint, ground, active) =>
      nightPatchWanted(subPoint.dot(ground.worldToLocal(_sun.set(0, 0, 0)).normalize()), side, active),
  })
  const uniforms = {
    uGibsNight: stream.uniforms.texture,
    uGibsNightMask: stream.uniforms.mask,
    uGibsNightOrigin: stream.uniforms.origin,
    uGibsNightActive: stream.uniforms.active,
  }
  return {
    material: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.fragmentShader = inject(
          inject(shader.fragmentShader, 'common', fragmentHead(side)),
          'emissivemap_fragment',
          EMISSIVE_BODY
        )
      },
      customProgramCacheKey: () => `gibs-night-${side}`,
    },
    uniforms,
    side,
    update: stream.update,
    probes: () => [stream.probe()],
    release: stream.dispose,
  }
}

/**
 * The night patch for the ground mesh in `ground` (local sphere of
 * `radius`): with flight detail (flight-detail.ts), on devices that take
 * one, filled as the eye nears Earth's night side and freed when it leaves,
 * climbs into daylight or the detail ends.
 */
export function useGibsNightPatch(ground: RefObject<THREE.Object3D | null>, radius: number): StreamedPatchUse {
  return useStreamedPatch(createGibsNightPatch, ground, radius)
}
