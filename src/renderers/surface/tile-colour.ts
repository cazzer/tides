// The globe's colour on the streamed tiles (tides-zmw.9.11). Under the same
// light and haze the tiles drew their imagery as it comes (EOX's Sentinel-2
// mosaic, USGS in the US), the globe its day map, graded far brighter and
// paler (Amazon forest 19,45,20 against 100,103,62 sRGB): through the
// handover band the two stood 11 to 37 dE2000 apart.
//
// Albedo, in linear light, after the imagery's lookup (map_fragment):
//   albedo = mix(imagery, anchored, w),
//   anchored = imagery * g + (dayMap - ref * g), g = dayMap / ref within 4x
// (a gain toward the day map's colour, the rest added; the anchored mean is
// the day map's):
// - imagery: as it comes (EOX), or USGS graded to EOX's look as the overlay
//   fetched it (imagery-grade.ts, in a worker), so the two sources meet
//   without a step at every height.
// - dayMap: the globe's own day map at the fragment's globe coordinate,
//   filtered for its footprint (isotropically: see Cost).
// - ref: the imagery seen at about the day map's texel (tile-colour-ref.ts:
//   EOX's level-5 pixels over the tile, fetched at runtime, bilinear on the
//   global pixel grid as the day map is on its own). dayMap - ref is the day
//   map's local difference from the imagery, so at w = 1 the tiles keep the
//   imagery's detail on the day map's own colour: what the globe shows at
//   that scale (its GIBS patch adds only detail, keeping the day map's
//   mean, and is left out: the imagery has that detail already). Until a
//   tile's reference arrives it is taken as the tile's own colour, so the
//   tile shows the day map's colour without the detail rather than the
//   wrong mean.
// - w, the user's pick (2026-10-26): 1 through the handover band and down to
//   COLOUR_MATCH_TOP_METRES over the ground, easing (smoothstep in log
//   height) to 0 at COLOUR_MATCH_BOTTOM_METRES, where the tiles show the
//   imagery's own colour; the height is the eye's own over the ground under
//   it, one value for the view (colourEyeWeight()). (A colour grade from
//   EOX to the day map's palette on the imagery itself, tried first, lifted
//   EOX's dark forest ~3x and with it its JPEG blocks and mosaic seams.)
//
// Light: the globe's sky fill (groundDetail.ts GROUND_DETAIL_GLSL.lightBody,
// its unbent normal the base's surfaceGeomNormal), which on a slope takes a
// share of the flat ground's sunlight from the sky dome as the globe does;
// on flat ground it changes nothing. Then, by w, the relief's light evened
// out to the flat ground's mean brightness (RELIEF_BODY, below): the globe
// has no relief to shade at the handover. The haze is already the globe's
// (tile-haze.ts).
//
// Headless, tiles-only against globe-only box means at 200 / 50 km over the
// ground (dE2000; before: canyon 37.1/27.1, Amazon 33.3/37.0, Sahara
// 10.7/13.4, open Atlantic 25.7/26.1): see the bead's notes.
//
// Cost: the globe's coordinate comes from the tile's own imagery coordinate
// (vMapUv, linear in Web Mercator) through a per-tile fit (fitTileGlobe(),
// from the mesh's vertices), not from the base's surfaceGlobeUv (its atan,
// asin and derivatives cost ~0.3 ms at 1080p headless); the maps are read at
// an isotropic level of detail (textureLod: the anchor is coarse, and the
// day map's 16x anisotropy cost more again), in a branch that skips them
// wherever w is 0.
import * as THREE from 'three'
import { GROUND_DETAIL_GLSL } from '../groundDetail'
import { EARTH_KM_PER_UNIT } from '../../surface-handover'
import { earthLatLon, surfaceGroundSampler } from '../../surface-ground'
import { tileRadianBounds } from './credit-sources'
import { terrainTileSymbols } from './surface-coverage'
import { colourRefStore, colourRefWindow, mercatorX, mercatorY, type ColourRefStore, type ColourRefWindow } from './tile-colour-ref'
import { injectAfterChunk, renameInSnippet, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile colour'

/** Where the tiles start easing from the day map's colour to the imagery's
 * own, going down: metres of the eye over the ground. */
export const COLOUR_MATCH_TOP_METRES = 50_000
/** Where the ease ends: below it the tiles show the imagery's graded look. */
export const COLOUR_MATCH_BOTTOM_METRES = 5_000

/** The globe ground's sky fill share (groundDetail.ts GROUND_SKY_FILL; the
 * test pins the two together). */
export const TILE_SKY_FILL = 0.2

/** The least cosine of a slope (its bent normal against the unbent) the
 * relief's brightness is evened out by: a 66 degree slope and steeper take
 * at most 2.5 times its light. */
export const COLOUR_RELIEF_MIN_COS = 0.4

/** The day map's weight for an eye `metres` over the ground (the GLSL's
 * colourMatch). */
export function colourMatchWeight(metres: number): number {
  const t = Math.min(
    1,
    Math.max(0, Math.log2(Math.max(metres, 1) / COLOUR_MATCH_BOTTOM_METRES) / Math.log2(COLOUR_MATCH_TOP_METRES / COLOUR_MATCH_BOTTOM_METRES))
  )
  return t * t * (3 - 2 * t)
}

const f = (x: number) => x.toPrecision(9)
const UNITS_PER_METRE = 1 / (EARTH_KM_PER_UNIT * 1000)

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uColourDay;
// The day map for the glint's deep water too (tile-glint.ts), no unit of its own.
#define TILE_COLOUR_DAY
uniform sampler2D uColourRef;
// Per tile (fitTileGlobe()): the globe's u = x + y s and the reference's
// column z + w s; the globe's v = x + t (y + t z); the reference's row
// x + y t, z its share (fading in over COLOUR_REF_FADE_MS once it arrives).
// (s, t) = vMapUv; w 1 where the fit holds.
uniform vec4 uColourGlobeU;
uniform vec4 uColourGlobeV;
uniform vec4 uColourRefV;
// The day map's weight w for this draw's eye (colourEyeWeight()), the same
// for every tile.
uniform float uColourW;
#ifndef GROUND_SKY_FILL
#define GROUND_SKY_FILL ${TILE_SKY_FILL.toFixed(1)}
#endif
`

// After the imagery's lookup (diffuseColor = the graded texel, linear). At
// main's scope (the names are the feature's own), so a debug view can read
// the parts. All of it in a branch on uniforms (so in uniform control
// flow, derivatives and all): under 5 km over the ground (the stop) none of
// it runs. The footprint (log2, in globe u, the day map 2:1) from the
// coordinate's derivatives.
const ALBEDO_BODY = /* glsl */ `
#ifdef USE_MAP
  float colourW = 0.0;
  if (uColourW > 0.0 && uColourGlobeV.w > 0.5) {
    colourW = uColourW;
    vec2 colourUv = vec2(uColourGlobeU.x + uColourGlobeU.y * vMapUv.x,
      uColourGlobeV.x + vMapUv.y * (uColourGlobeV.y + vMapUv.y * uColourGlobeV.z));
    vec2 colourDx = dFdx(colourUv) * vec2(1.0, 0.5);
    vec2 colourDy = dFdy(colourUv) * vec2(1.0, 0.5);
    float colourFoot = 0.5 * log2(max(max(dot(colourDx, colourDx), dot(colourDy, colourDy)), 1e-24));
    {
      vec3 colourDay = textureLod(uColourDay, colourUv, colourFoot + log2(float(textureSize(uColourDay, 0).x))).rgb;
      vec2 colourRefAt = vec2(uColourGlobeU.z + uColourGlobeU.w * vMapUv.x, uColourRefV.x + uColourRefV.y * vMapUv.y);
      vec3 colourRef = mix(diffuseColor.rgb, textureLod(uColourRef, colourRefAt, 0.0).rgb, uColourRefV.z);
      // A gain where the day map and the reference are within 4x of each
      // other, the rest added: the mean is the day map's either way, and a
      // dark pixel next to a bright feature the reference spreads (a river's
      // sediment through dark forest) dims by the same share as the
      // feature, not by its brightness (which, added in sRGB or its square
      // root, drew a black halo along every river).
      vec3 colourGain = clamp(colourDay / max(colourRef, vec3(1e-4)), 0.25, 4.0);
      vec3 colourAnchored = diffuseColor.rgb * colourGain + (colourDay - colourRef * colourGain);
      diffuseColor.rgb = max(mix(diffuseColor.rgb, colourAnchored, colourW), 0.0);
    }
  }
#endif
`

// The globe's sky fill on the tiles' normals: no specular map to gate on.
const LIGHT_BODY = renameInSnippet(
  renameInSnippet(
    GROUND_DETAIL_GLSL.lightBody,
    '#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0',
    '#if NUM_DIR_LIGHTS > 0',
    WHAT,
    1
  ),
  'groundUp',
  'surfaceGeomNormal',
  WHAT,
  2
)

// The globe's tint of the Sun's light (tides-34q), on the tiles' normals.
const SUN_TINT_BODY = renameInSnippet(
  renameInSnippet(
    GROUND_DETAIL_GLSL.sunTintBody,
    '#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0',
    '#if NUM_DIR_LIGHTS > 0',
    WHAT,
    1
  ),
  'groundUp',
  'surfaceGeomNormal',
  WHAT,
  1
)

// The relief's light evened out where the tiles match the globe (by w): the
// globe has no relief at that scale to shade (its ground is flat-lit from
// the band down), while the tiles' bumped relief, drawn 3 to 12 times true,
// sends more of its light sideways than up to an eye above it (a slope's
// pixel takes n.l, over a footprint 1/cos(slope) of its ground), so rugged
// ground drew a fifth darker than the globe's at the handover. Divided by
// the slope's cosine, each pixel takes the light its ground intercepts, and
// the relief keeps its shading at the flat ground's mean brightness; easing
// with w to the tiles' own near the ground.
const RELIEF_BODY = /* glsl */ `
#if defined(USE_MAP) && NUM_DIR_LIGHTS > 0
if (colourW > 0.0) {
  reflectedLight.directDiffuse *= mix(1.0, 1.0 / max(dot(normal, surfaceGeomNormal), ${f(COLOUR_RELIEF_MIN_COS)}), colourW);
}
#endif
`

/** The adapter's GLSL (the test checks it against the globe's). */
export const TILE_COLOUR_GLSL = { fragmentHead: FRAGMENT_HEAD, albedoBody: ALBEDO_BODY, lightBody: LIGHT_BODY, sunTintBody: SUN_TINT_BODY, reliefBody: RELIEF_BODY }

/** Stands in for a tile's reference until it arrives. */
let placeholder: THREE.DataTexture | null = null
function noReference(): THREE.DataTexture {
  if (!placeholder) {
    placeholder = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
    placeholder.needsUpdate = true
  }
  return placeholder
}

/** A tile's own uniforms: its coordinate fit and its reference. */
export interface TileColourUniforms extends Record<string, THREE.IUniform> {
  uColourRef: THREE.IUniform<THREE.Texture>
  uColourGlobeU: THREE.IUniform<THREE.Vector4>
  uColourGlobeV: THREE.IUniform<THREE.Vector4>
  uColourRefV: THREE.IUniform<THREE.Vector4>
}

/** A late reference fades in over this, rather than popping its detail in. */
export const COLOUR_REF_FADE_MS = 400

/**
 * The day map's weight for an eye `eyeGround` (the ground mesh's frame,
 * scene units) over a sea sphere of `seaLevel`: from the eye's own height
 * over the ground under it (the tiles' sampler's highest within 1 km, true
 * metres; the sea without tiles), so one value holds for the whole view. A
 * weight from each fragment's own drawn ground (at 12x relief, 100 km of
 * it) banded ridges by their contours.
 */
export function colourEyeWeight(eyeGround: THREE.Vector3, seaLevel: number, sampler = surfaceGroundSampler()): number {
  const r = eyeGround.length()
  if (!(r > 0)) return 0
  const [lat, lon] = earthLatLon(new THREE.Vector3().copy(eyeGround).divideScalar(r))
  const ground = sampler?.maxElevation(lat, lon, 1000)?.metres ?? 0
  return colourMatchWeight((r - seaLevel) / UNITS_PER_METRE - Math.max(ground, 0))
}

/** The fit's worst miss it takes, in globe u or v: a mapping that misses
 * by more isn't the imagery's Mercator. Latitude's quadratic itself misses
 * by under a day-map texel from level 4 down (a tenth from level 5; level 3,
 * only ever far off, ~5). */
export const TILE_GLOBE_FIT_TOLERANCE = 5e-3

/** Least squares of y on the powers of x up to `degree` (1 or 2). */
function polyfit(xs: number[], ys: number[], degree: 1 | 2): number[] | null {
  const n = degree + 1
  const A = new Float64Array(n * n)
  const b = new Float64Array(n)
  for (let i = 0; i < xs.length; i++) {
    const p = [1, xs[i], xs[i] * xs[i]]
    for (let r = 0; r < n; r++) {
      b[r] += p[r] * ys[i]
      for (let c = 0; c < n; c++) A[r * n + c] += p[r] * p[c]
    }
  }
  if (n === 2) {
    const det = A[0] * A[3] - A[1] * A[2]
    if (!(Math.abs(det) > 1e-30)) return null
    return [(b[0] * A[3] - A[1] * b[1]) / det, (A[0] * b[1] - A[2] * b[0]) / det]
  }
  const m = new THREE.Matrix3().set(A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8])
  if (!(Math.abs(m.determinant()) > 1e-30)) return null
  const v = new THREE.Vector3(b[0], b[1], b[2]).applyMatrix3(m.invert())
  return [v.x, v.y, v.z]
}

/** A tile's fit (fitTileGlobe()): the uniforms' values. */
export interface TileGlobeFit {
  /** u = u[0] + u[1] s */
  u: number[]
  /** v = v[0] + v[1] t + v[2] t^2 */
  v: number[]
  /** The reference's column and row, 0-1 over its window: x[0] + x[1] s, y[0] + y[1] t. */
  refX: number[]
  refY: number[]
}

/**
 * The globe's coordinate (SphereGeometry's uv: the base's surfaceGlobeUv) and
 * the reference window's, as functions of the tile's imagery coordinate
 * (vMapUv = the map's transform of the mesh's uv), fitted on the mesh's
 * vertices (ECEF metres from its parent, which the plugin centres on the
 * tile): the imagery is drawn in Web Mercator, so u and the reference's
 * column are linear in s and its row in t, and v (latitude) close to
 * quadratic in t. Null where the mesh doesn't give a fit within
 * TILE_GLOBE_FIT_TOLERANCE (or has no map or vertices).
 */
export function fitTileGlobe(mesh: THREE.Mesh, map: THREE.Texture | null, window: ColourRefWindow): TileGlobeFit | null {
  const position = mesh.geometry.getAttribute('position')
  const uv = mesh.geometry.getAttribute('uv')
  if (!map || !position || !uv || position.count < 3) return null
  map.updateMatrix()
  mesh.updateMatrix()
  const point = new THREE.Vector3()
  const st = new THREE.Vector3()
  const n = 256 * 2 ** window.zoom
  const step = Math.max(1, Math.floor(position.count / 256))
  const s: number[] = []
  const t: number[] = []
  const lons: number[] = []
  const lats: number[] = []
  let centre: number | null = null
  for (let i = 0; i < position.count; i += step) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix)
    st.set(uv.getX(i), uv.getY(i), 1).applyMatrix3(map.matrix)
    let lon = Math.atan2(point.y, point.x)
    // Unwrapped about the first vertex, so a tile on the antimeridian keeps one side.
    centre ??= lon
    lon = centre + Math.atan2(Math.sin(lon - centre), Math.cos(lon - centre))
    s.push(st.x)
    t.push(st.y)
    lons.push(lon)
    lats.push(Math.atan2(point.z, Math.hypot(point.x, point.y)))
  }
  const u = polyfit(s, lons.map((lon) => 0.5 + lon / (2 * Math.PI)), 1)
  const v = polyfit(t, lats.map((lat) => 0.5 + lat / Math.PI), 2)
  const refX = polyfit(s, lons.map((lon) => (mercatorX(lon) * n - window.x0) / window.width), 1)
  const refY = polyfit(t, lats.map((lat) => (mercatorY(lat) * n - window.y0) / window.height), 1)
  if (!u || !v || !refX || !refY) return null
  for (let i = 0; i < s.length; i++) {
    const du = u[0] + u[1] * s[i] - (0.5 + lons[i] / (2 * Math.PI))
    const dv = v[0] + t[i] * (v[1] + t[i] * v[2]) - (0.5 + lats[i] / Math.PI)
    if (!(Math.abs(du) < TILE_GLOBE_FIT_TOLERANCE && Math.abs(dv) < TILE_GLOBE_FIT_TOLERANCE)) return null
  }
  return { u, v, refX, refY }
}

/** The terrain level of `tile`: its TILE_LEVEL, else from its width. */
function tileLevel(tile: object, west: number, east: number): number {
  const symbols = terrainTileSymbols(tile)
  const level = symbols ? (tile as Record<symbol, unknown>)[symbols.level] : undefined
  if (typeof level === 'number') return level
  return Math.round(Math.log2((2 * Math.PI) / Math.max(east - west, 1e-9)))
}

/** The adapter on `store` (the page's by default; tests pass their own). */
export function createTileColour(store: () => ColourRefStore = colourRefStore): TileAdapter {
  return (link) => {
    const releases = new WeakMap<object, () => void>()
    // Shared by every tile: the weight for the eye that draws them.
    const weight: THREE.IUniform<number> = { value: 0 }
    const eye = link.haze.frame.uGroundHazeEyeLocal
    const lastEye = new THREE.Vector3(NaN, NaN, NaN)
    const updateWeight = () => {
      if (lastEye.equals(eye.value)) return
      lastEye.copy(eye.value)
      weight.value = colourEyeWeight(eye.value, link.seaLevel)
    }
    return {
      patch: {
        onBeforeCompile(shader) {
          Object.assign(shader.uniforms, {
            uColourDay: link.maps.day,
            uColourRef: { value: noReference() },
            uColourGlobeU: { value: new THREE.Vector4(0, 0, 0, 0) },
            uColourGlobeV: { value: new THREE.Vector4(0, 0, 0, 0) },
            uColourRefV: { value: new THREE.Vector4(0, 0, 0, 0) },
            uColourW: weight,
          })
          let fragment = surfaceInject(shader.fragmentShader, 'fragmentHead', FRAGMENT_HEAD)
          fragment = injectAfterChunk(fragment, 'map_fragment', ALBEDO_BODY, WHAT)
          // The sky fill, then the evening out (the later injection lands first).
          fragment = injectAfterChunk(fragment, 'lights_fragment_end', RELIEF_BODY, WHAT)
          fragment = injectAfterChunk(fragment, 'lights_fragment_maps', SUN_TINT_BODY, WHAT)
          shader.fragmentShader = injectAfterChunk(fragment, 'lights_fragment_end', LIGHT_BODY, WHAT)
        },
        customProgramCacheKey: () => 'colour-surface',
      },
      onTile(material, mesh, tile) {
        const own: TileColourUniforms = {
          uColourRef: { value: noReference() },
          uColourGlobeU: { value: new THREE.Vector4(0, 0, 0, 0) },
          uColourGlobeV: { value: new THREE.Vector4(0, 0, 0, 0) },
          uColourRefV: { value: new THREE.Vector4(0, 0, 0, 0) },
        }
        const bounds = tileRadianBounds(tile)
        if (!bounds) return own
        const window = colourRefWindow(bounds, tileLevel(tile, bounds.west, bounds.east))
        const fit = fitTileGlobe(mesh, material.map, window)
        if (!fit) return own
        own.uColourGlobeU.value.set(fit.u[0], fit.u[1], fit.refX[0], fit.refX[1])
        own.uColourGlobeV.value.set(fit.v[0], fit.v[1], fit.v[2], 1)
        own.uColourRefV.value.set(fit.refY[0], fit.refY[1], 0, 0)
        // Each draw: the view's weight (each camera's eye is set before
        // anything draws; one value, so computed once per eye), and a late
        // reference's fade.
        let arrivedAt = 0
        const previous = mesh.onBeforeRender
        mesh.onBeforeRender = function (...args) {
          previous.apply(this, args)
          updateWeight()
          if (arrivedAt) own.uColourRefV.value.z = Math.min(1, (performance.now() - arrivedAt) / COLOUR_REF_FADE_MS)
        }
        let atOnce = true
        releases.set(
          own,
          store().request(window, (texture) => {
            own.uColourRef.value = texture
            if (atOnce) own.uColourRefV.value.z = 1
            else arrivedAt = performance.now()
          })
        )
        atOnce = false
        return own
      },
      onDispose(_material, uniforms) {
        releases.get(uniforms)?.()
        releases.delete(uniforms)
      },
    }
  }
}

export const tileColour: TileAdapter = createTileColour()
