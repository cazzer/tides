// The GIBS imagery patch under the ship (tides-01v.7; tiles in ../gibs-patch.ts),
// on the ground's Phong material through composePatches. The tiles stream
// into one sRGB render-target texture (./gibsStream.ts), with a mask of each
// tile's fade-in: a tile still loading, or failed (offline), leaves the
// global map, and its shown neighbours fade out toward it.
//
// No GIBS layer matches the day map's grading (its ocean is a lit teal, Blue
// Marble's near black), so each tile is recoloured as it is written, through
// a lookup fitted from Blue Marble to the day map (tides-01v.15;
// scripts/fit-gibs-colour.mjs), and its mips are of the recoloured imagery.
// The fit is global and the two still differ region by region, so the patch
// adds only what the day map lacks: its difference from itself blurred to the
// day map's texel, in sRGB. The large scale stays the day map's, so nothing
// shows a seam, and the patch fades out by itself wherever the day map
// already resolves the ground. Night lights, the specular mask and the
// clouds are untouched.
//
// The day map is also warped against Blue Marble, by up to a few of its
// texels (most around the Great Lakes), which no recolour can fix: its
// blurred coasts would sit beside the patch's sharp ones. So the patch is
// read through an offset field fitted offline (tides-01v.20;
// scripts/fit-gibs-warp.mjs), zero wherever the two agree to two texels or
// the shores don't all confirm the shift.
import type { RefObject } from 'react'
import * as THREE from 'three'
import {
  createGibsTileStore,
  GIBS_COLS,
  GIBS_GROUND_WIDTH,
  GIBS_ROWS,
  GIBS_TILE_PX,
  gibsGroundTileUrl,
} from '../gibs-patch'
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'
import { createGibsStream, EDGE_TILES, SEAM_TILES, useStreamedPatch, type GibsStreamPass, type StreamedPatch, type StreamedPatchUse } from './gibsStream'
import colourLutUrl from '../assets/gibs-colour-lut.bin?url&inline'
import warpUrl from '../assets/gibs-warp.bin?url&inline'

// Shared by every flight: a few hundred tiles is ~10-20 MB of JPEG.
const store = createGibsTileStore(async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GIBS tile ${url}: HTTP ${response.status}`)
  return response.blob()
}, 400)

/** Network requests for GIBS ground tiles this page has made. */
export function gibsTileRequests(): number {
  return store.requests
}

const f = (x: number) => x.toFixed(6)

/** The recolour's lookup: COLOUR_LUT_SIDE^3 sRGB entries, red fastest, each
 * axis warped so entry k is at 255 (k / (side - 1))^2 of its channel. */
const COLOUR_LUT_SIDE = 17

function colourLut(): THREE.Data3DTexture {
  const rgb = Uint8Array.from(atob(colourLutUrl.slice(colourLutUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
  const n = COLOUR_LUT_SIDE ** 3
  if (rgb.length !== n * 3) throw new Error(`GIBS colour LUT: ${rgb.length} bytes, expected ${n * 3}`)
  const rgba = new Uint8Array(n * 4).fill(255)
  for (let i = 0; i < n; i++) rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4)
  const lut = new THREE.Data3DTexture(rgba, COLOUR_LUT_SIDE, COLOUR_LUT_SIDE, COLOUR_LUT_SIDE)
  lut.magFilter = lut.minFilter = THREE.LinearFilter
  lut.unpackAlignment = 1
  lut.needsUpdate = true
  return lut
}

/** The offset field: WARP_COLS x WARP_ROWS RG8 texels from the north,
 * each 128 plus WARP_UNITS a day-map texel (1/WARP_TEXELS of the
 * circumference, so twice that of the map's v), x east and y south, of
 * where Blue Marble shows what the day map shows at the texel's centre. */
const WARP_COLS = 180
const WARP_ROWS = 90
const WARP_UNITS = 16
const WARP_TEXELS = 10800

function warpField(): THREE.DataTexture {
  const rg = Uint8Array.from(atob(warpUrl.slice(warpUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
  if (rg.length !== WARP_COLS * WARP_ROWS * 2) {
    throw new Error(`GIBS warp field: ${rg.length} bytes, expected ${WARP_COLS * WARP_ROWS * 2}`)
  }
  const field = new THREE.DataTexture(rg, WARP_COLS, WARP_ROWS, THREE.RGFormat, THREE.UnsignedByteType)
  field.magFilter = field.minFilter = THREE.LinearFilter
  field.wrapS = THREE.RepeatWrapping
  field.unpackAlignment = 1
  field.needsUpdate = true
  return field
}

// Draws a tile, recoloured, into the slot the target's viewport frames. Both
// ends hold sRGB: the tile is read raw and the target encodes on write.
const RECOLOUR_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
const RECOLOUR_FRAGMENT = /* glsl */ `
uniform sampler2D uTile;
uniform sampler3D uLut;
varying vec2 vUv;
void main() {
  vec3 at = sqrt(texture2D(uTile, vUv).rgb);
  vec3 colour = texture(uLut, (at * ${f(COLOUR_LUT_SIDE - 1)} + 0.5) / ${f(COLOUR_LUT_SIDE)}).rgb;
  gl_FragColor = vec4(sRGBTransferEOTF(vec4(colour, 1.0)).rgb, 1.0);
}
`

// The stream's pass; freeing just its tile keeps the program and the LUT for
// the next approach.
function createRecolour(): GibsStreamPass {
  const tile = new THREE.Texture()
  tile.flipY = false
  tile.generateMipmaps = false
  tile.magFilter = tile.minFilter = THREE.NearestFilter
  const lut = colourLut()
  const material = new THREE.ShaderMaterial({
    uniforms: { uTile: { value: tile }, uLut: { value: lut } },
    vertexShader: RECOLOUR_VERTEX,
    fragmentShader: RECOLOUR_FRAGMENT,
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
      lut.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}

const fragmentHead = (side: number) => /* glsl */ `
uniform sampler2D uGibsPatch;
uniform sampler2D uGibsMask;
uniform sampler2D uGibsWarp;
// The patch's north-west tile: column, row.
uniform vec2 uGibsOrigin;
uniform float uGibsActive;
#define GIBS_SIDE ${f(side)}

// A slot's fade-in, for unwrapped tile coordinates.
float gibsMask(ivec2 tile) {
  return texelFetch(uGibsMask, tile & ${side - 1}, 0).r;
}
`

// After the albedo (and the poles' smoothing of it), before anything reads
// it. vMapUv is the day map's own coordinate, so the patch registers with it.
const ALBEDO_BODY = /* glsl */ `
float gibsCover = 0.0;
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
if (uGibsActive > 0.5) {
  // Tiles from the patch's north-west corner, moved to where Blue Marble
  // shows this ground (wrapped after, so the west edge stays put);
  // derivatives before branching.
  vec2 gibsWarp = (texture(uGibsWarp, vec2(vMapUv.x, 1.0 - vMapUv.y)).rg * 255.0 - 128.0)
    / vec2(${f(WARP_UNITS * WARP_TEXELS)}, ${f((WARP_UNITS * WARP_TEXELS) / 2)});
  vec2 gibsAt = vec2(
    fract(vMapUv.x + gibsWarp.x - uGibsOrigin.x / ${f(GIBS_COLS)}) * ${f(GIBS_COLS)},
    (1.0 - vMapUv.y + gibsWarp.y) * ${f(GIBS_ROWS)} - uGibsOrigin.y);
  vec2 gibsDx = dFdx(gibsAt);
  vec2 gibsDy = dFdy(gibsAt);
  gibsDx.x -= ${f(GIBS_COLS)} * floor(gibsDx.x / ${f(GIBS_COLS)} + 0.5);
  gibsDy.x -= ${f(GIBS_COLS)} * floor(gibsDy.x / ${f(GIBS_COLS)} + 0.5);
  // log2 of the day map's texel in patch texels, and of the pixel's.
  float gibsMapLod = log2(${f(GIBS_GROUND_WIDTH)} / float(textureSize(map, 0).x));
  float gibsPixelLod = log2(max(length(gibsDx), length(gibsDy)) * ${f(GIBS_TILE_PX)});
  float gibsEdge = min(min(gibsAt.x, GIBS_SIDE - gibsAt.x), min(gibsAt.y, GIBS_SIDE - gibsAt.y));
  if (gibsEdge > 0.0 && gibsPixelLod < gibsMapLod) {
    // Unwrapped tile coordinates: the textures repeat, so mod GIBS_SIDE is
    // the slot. Toward a tile's edge its fade-in is multiplied in turn by the
    // neighbours' there, the same product from either side of the edge.
    vec2 q = uGibsOrigin + gibsAt;
    ivec2 cell = ivec2(floor(q));
    vec2 e = fract(q) - 0.5;
    ivec2 toward = ivec2(sign(e));
    vec2 ramp = smoothstep(${f(0.5 - SEAM_TILES)}, 0.5, abs(e));
    float mask = gibsMask(cell)
      * mix(1.0, gibsMask(cell + ivec2(toward.x, 0)), ramp.x)
      * mix(1.0, gibsMask(cell + ivec2(0, toward.y)), ramp.y)
      * mix(1.0, gibsMask(cell + toward), ramp.x * ramp.y);
    float lat = (vMapUv.y - 0.5) * 180.0;
    // Faded over the last mip before the day map resolves as much, so the
    // ground detail's octaves come back gradually (the cut-off is in uv, so
    // off the equator it falls inside the detail's range).
    gibsCover = mask * smoothstep(0.0, ${f(EDGE_TILES)}, gibsEdge)
      * (1.0 - smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat)))
      * (1.0 - smoothstep(gibsMapLod - 1.0, gibsMapLod, gibsPixelLod));
    if (gibsCover > 0.0) {
      vec2 st = q / GIBS_SIDE;
      vec2 gx = gibsDx / GIBS_SIDE;
      vec2 gy = gibsDy / GIBS_SIDE;
      // The patch as the day map shows it: each axis of the pixel's
      // footprint widened to at least the day map's texel.
      float mapTexel = exp2(gibsMapLod) / ${f(GIBS_TILE_PX)};
      vec2 cx = gx * max(1.0, mapTexel / max(length(gibsDx), 1e-9));
      vec2 cy = gy * max(1.0, mapTexel / max(length(gibsDy), 1e-9));
      vec3 fine = sRGBTransferOETF(textureGrad(uGibsPatch, st, gx, gy)).rgb;
      vec3 coarse = sRGBTransferOETF(textureGrad(uGibsPatch, st, cx, cy)).rgb;
      vec3 base = sRGBTransferOETF(vec4(diffuseColor.rgb, 1.0)).rgb;
      diffuseColor.rgb = sRGBTransferEOTF(vec4(clamp(base + gibsCover * (fine - coarse), 0.0, 1.0), 1.0)).rgb;
    }
  }
}
#endif
`

// Where the patch shows, the ground detail (./groundDetail.ts) drops the
// octaves its imagery resolves.
const DETAIL_BODY = /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
groundDetailFine = gibsCover;
groundDetailFineTexel = groundDetailTexel * float(textureSize(map, 0).x) / ${f(GIBS_GROUND_WIDTH)};
#endif
`

// Before the chunk by default: the pole smoothing replaces map_fragment
// outright, and the ground detail's texel follows specularmap_fragment.
/** The patch's GLSL for the streamed tiles to reuse by text (tides-zmw.9.16):
 * fragmentHead(side) after common, albedoBody before color_fragment,
 * detailBody before normal_fragment_begin. */
export const GIBS_GLSL = { fragmentHead, albedoBody: ALBEDO_BODY, detailBody: DETAIL_BODY }

function inject(source: string, chunk: string, code: string, where: 'before' | 'after' = 'before'): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`GIBS patch: shader has no ${include}`)
  }
  return source.replace(include, where === 'before' ? `${code}\n${include}` : `${include}\n${code}`)
}

export type GibsPatch = StreamedPatch

function createTarget(side: number, gl: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(side * GIBS_TILE_PX, side * GIBS_TILE_PX, {
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    anisotropy: gl.capabilities.getMaxAnisotropy(),
    depthBuffer: false,
  })
}

/** A patch `side` tiles square (gibsPatchSide); 0 for none. */
export function createGibsPatch(side: number): GibsPatch {
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
    tileUrl: gibsGroundTileUrl,
    label: 'GIBS',
    fallback: 'the day map',
    createTarget: (gl) => createTarget(side, gl),
    createPass: createRecolour,
  })
  const warp = warpField()
  const uniforms = {
    uGibsPatch: stream.uniforms.texture,
    uGibsMask: stream.uniforms.mask,
    uGibsWarp: { value: warp },
    uGibsOrigin: stream.uniforms.origin,
    uGibsActive: stream.uniforms.active,
  }

  return {
    material: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.fragmentShader = inject(
          inject(inject(shader.fragmentShader, 'common', fragmentHead(side), 'after'), 'color_fragment', ALBEDO_BODY),
          'normal_fragment_begin',
          DETAIL_BODY
        )
      },
      customProgramCacheKey: () => `gibs-patch-${side}`,
    },
    uniforms,
    side,
    update: stream.update,
    probes: () => [stream.probe()],
    release() {
      stream.dispose()
      // three uploads it again if the patch is used after.
      warp.dispose()
    },
  }
}

/**
 * The patch for the ground mesh in `ground` (local sphere of `radius`): with
 * flight detail (flight-detail.ts), on devices that take one, filled as the
 * eye nears Earth and freed when it leaves or the detail ends.
 */
export function useGibsPatch(ground: RefObject<THREE.Object3D | null>, radius: number): StreamedPatchUse {
  return useStreamedPatch(createGibsPatch, ground, radius)
}
