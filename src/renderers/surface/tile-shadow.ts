// Terrain cast shadows on the streamed tiles (tides-zmw.9.15), in two layers
// on the live terrain scale:
//
// (a) The globe's, for the handover: groundShadow.ts's horizon-map shadows
//     and sky occlusion, its own GLSL by rename, on the globe's horizon
//     uniforms (the link's), per tile vertex rather than per pixel. Its map
//     has 39 km texels and a tile vertex stands 0.1 to 5 km from the next
//     wherever a tile draws, so the vertex loses nothing the map holds, and
//     per pixel it cost +0.6 to 0.8 ms at 1080p (headless burst; skipped by
//     a uniform branch, still +0.12): here it is one vec2 varying. At the
//     vertex it reads the map at the vertex's own globe coordinate (no
//     antimeridian jump: nothing is interpolated but the result), at mip 0
//     (a pixel never spans its texel here), and without the globe's
//     footprint fade (0 here: that fades the shadows out where a pixel spans
//     a texel, the system view). The globe scales the map's tangents by its
//     displacementScale, the live scale's terrainDisplacement(); here that
//     is uTerrainScale (the tiles' own height scale, the same uniform
//     object) times terrainDisplacement(1), so both stand on the scale of the
//     frame. It carries the long shadows of whole ranges, and through the
//     dissolve band the tiles shade as the globe pixels between them.
// (b) The tiles' own, for detail: each elevation grid's horizon map
//     (terrarium.ts bakeTileHorizon, baked in the decode worker at true
//     scale, ~4 grid texels a texel, every grid searching the same 12 km),
//     found by the grid's texture source (terrain-internals.ts
//     gridHorizon()), bound per tile in onTile as a clone (the GPU copy is
//     shared, and lives until its last tile and the grid are gone) and read
//     at the bump's uv (vBumpMapUv: the grid's, so no varying of its own).
//     The Sun against the horizon toward it, interpolated between the two
//     directions either side as the globe does (sunAzimuth()), with the
//     globe's soft edge (in tangent) and its "a step or less never shadows",
//     the tangents times uTerrainScale. Per pixel it is one or two taps and
//     a division: the map's code decodes without trigonometry, and what is
//     the same across a tile is worked out per tile on the CPU, read by
//     three as uniforms at the tile's draw (tileSun()): the Sun's two
//     directions (which layer, what weights), and whether the Sun can be
//     under the grid's highest horizon anywhere on the tile at all (off when
//     not, and at night). It eases in with the tiles' share of the ground
//     (uSurfaceOpacity) across the dissolve band, so the globe pixels the
//     screen-door leaves (which have only (a)) and the tile pixels converge,
//     and there is no step at either end.
//
// sunLit = min(a, b): one shadow, the deeper (a product would darken twice
// where both see the same ridge). It dims the direct light only, as the
// globe's; (a)'s sky occlusion (groundHorizonSky, which the colour slot's
// sky fill reads after GROUND_HORIZON, as on the globe) dims the ambient.
// Grids with no horizon (open water, flat ground, the main-thread decode
// fallback) bind none: uTileHorizonOn 0, (a) alone.
import * as THREE from 'three'
import { HORIZON_SOFTNESS } from '../../earth-horizon'
import { surfaceOpacityUniform, terrainDisplacement, terrainScaleUniform } from '../../terrain-scale'
import { GROUND_SHADOW_GLSL } from '../groundShadow'
import type { GlobeLink } from './surface-link'
import { SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import { gridHorizon } from './terrain-internals'
import { TILE_HORIZON_CODE_MAX, TILE_HORIZON_GAIN, tileHorizonTangent } from './terrarium'
import { injectAfterChunk, renameInSnippet, SURFACE_GROUND_FROM_ECEF, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile shadow'
const f = (x: number) => x.toFixed(6)

/** The statement of the globe's body that starts with `head`, to its semicolon. */
function statement(body: string, head: string): string {
  const at = body.indexOf(head)
  if (at < 0) throw new Error(`${WHAT}: snippet has no ${head}`)
  return body.slice(at, body.indexOf(';', at) + 1)
}

/** (a)'s heads: the globe's uniforms (its scale is uTerrainScale's, which the scale's patch declares), and the varying. */
function vertexHead(seaLevel: number): string {
  return `${renameInSnippet(GROUND_SHADOW_GLSL.fragmentHead, 'uniform float uGroundShadowScale;', '', WHAT, 1)}
const float SURFACE_SHADOW_RADIUS = ${seaLevel.toFixed(9)};
varying vec2 vSurfaceShadow;
`
}

const FRAGMENT_HEAD = /* glsl */ `
uniform vec3 uGroundShadowSun;
uniform sampler2DArray uTileHorizon;
uniform float uTileHorizonOn;
uniform vec4 uTileSunA;
uniform vec4 uTileSunB;
uniform vec2 uTileSunLayers;
varying vec2 vSurfaceShadow;
`

/** (a): the globe's light body at the tile's vertex, its sunLit and sky into vSurfaceShadow. */
function globeVertexBody(): string {
  const g = GROUND_SHADOW_GLSL.lightBody
  let s = g
  // The tiles take no specular map (their imagery is the map, when it came).
  s = renameInSnippet(s, '#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0', '#if NUM_DIR_LIGHTS > 0', WHAT, 1)
  // The fragment stage defines it, for the colour slot.
  s = renameInSnippet(s, '#define GROUND_HORIZON\n', '', WHAT, 1)
  // No screen footprint at a vertex (and no fade for it here: above).
  s = renameInSnippet(s, statement(g, 'float footprint ='), 'float footprint = 0.0;', WHAT, 1)
  s = renameInSnippet(s, 'vec3 eye = normalize(vViewPosition);', '', WHAT, 1)
  s = renameInSnippet(s, 'vGroundDetailPos', '(surfaceUp * SURFACE_SHADOW_RADIUS)', WHAT, 2)
  for (const layer of ['0.0', '1.0']) {
    s = renameInSnippet(s, `texture(uGroundHorizon, vec3(vMapUv, ${layer}))`, `textureLod(uGroundHorizon, vec3(surfaceShadowUv, ${layer}), 0.0)`, WHAT, 1)
  }
  s = renameInSnippet(s, 'vMapUv', 'surfaceShadowUv', WHAT, 1)
  s = renameInSnippet(s, 'uGroundShadowScale', `(uTerrainScale * ${terrainDisplacement(1).toExponential(9)})`, WHAT, 1)
  s = renameInSnippet(s, 'reflectedLight.directDiffuse *= sunLit;', 'vSurfaceShadow.x = sunLit;', WHAT, 1)
  s = renameInSnippet(s, 'reflectedLight.directSpecular *= sunLit;', '', WHAT, 1)
  s = renameInSnippet(s, 'reflectedLight.indirectDiffuse *= groundHorizonSky;', 'vSurfaceShadow.y = groundHorizonSky;', WHAT, 1)
  return `vSurfaceShadow = vec2(1.0);
{
  // the globe map's coordinate of this vertex (SphereGeometry's uv)
  vec2 surfaceShadowUv = vec2(0.5 + atan(-surfaceUp.z, surfaceUp.x) * RECIPROCAL_PI2, 0.5 + asin(clamp(surfaceUp.y, -1.0, 1.0)) * RECIPROCAL_PI);
${s}
}
`
}

// (b), and the multiplies. The code is c = t / (t + 1/GAIN) (terrarium.ts),
// so t = c / ((1 - c) GAIN); the soft edge, HORIZON_SOFTNESS in elevation,
// is that over cos² in tangent.
const FINE_BODY = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
#define GROUND_HORIZON
float groundHorizonSky = vSurfaceShadow.y;
{
  float surfaceSunLit = vSurfaceShadow.x;
#ifdef USE_BUMPMAP
  if (uTileHorizonOn > 0.5) {
    float code = dot(uTileSunA, textureLod(uTileHorizon, vec3(vBumpMapUv, uTileSunLayers.x), 0.0));
    if (uTileSunLayers.y >= 0.0) code += dot(uTileSunB, textureLod(uTileHorizon, vec3(vBumpMapUv, uTileSunLayers.y), 0.0));
    code = min(code, ${f(TILE_HORIZON_CODE_MAX)});
    float need = uTerrainScale * code / ((1.0 - code) * ${f(TILE_HORIZON_GAIN)});
    float sinSun = dot(normalize(uGroundShadowSun), surfaceUp);
    float cos2 = max(1.0 - sinSun * sinSun, 1e-4);
    float soft = ${f(HORIZON_SOFTNESS)} / cos2;
    // One step of the code, on the live scale: less never shadows.
    float quantum = uTerrainScale * ${f(1 / 254 / TILE_HORIZON_GAIN)};
    float fine = mix(1.0,
      smoothstep(-soft, soft, sinSun * inversesqrt(cos2) - need),
      smoothstep(quantum, quantum + ${f(HORIZON_SOFTNESS)}, need));
    surfaceSunLit = min(surfaceSunLit, mix(1.0, fine, uSurfaceOpacity));
  }
#endif
  reflectedLight.directDiffuse *= surfaceSunLit;
  reflectedLight.directSpecular *= surfaceSunLit;
  reflectedLight.indirectDiffuse *= groundHorizonSky;
}
#endif
`

/** The adapter's GLSL for a sea level (the test checks it against the globe's). */
export function tileShadowGlsl(seaLevel: number) {
  return { vertexHead: vertexHead(seaLevel), vertexBody: globeVertexBody(), fragmentHead: FRAGMENT_HEAD, fragmentBody: FINE_BODY }
}

/** What (b) reads per tile, from the Sun at its centre (tileSun()). */
export interface TileSun {
  /** 1 where the Sun can be under the grid's highest horizon on the tile. */
  on: number
  /** The Sun's two directions: weights in layer layers.x (a), layer layers.y (b; -1: none). */
  a: THREE.Vector4
  b: THREE.Vector4
  layers: THREE.Vector2
}

const DEG = Math.PI / 180

/**
 * (b)'s per-tile values for a tile centred at `up` (the ground's frame, unit)
 * spanning `angularRadius` (radians), its grid's highest horizon `maxTangent`
 * (true scale), for the Sun `sun` (the ground's frame), the live `scale` and
 * the tiles' `opacity`. The Sun's azimuth and the two directions' weights
 * are the globe's (sunAzimuth(): 360° · d / 8 clockwise from north, layer 0
 * N, NE, E, SE); across a tile they move a fraction of a degree, against
 * the directions' 45°.
 */
export function tileSun(
  up: THREE.Vector3,
  angularRadius: number,
  maxTangent: number,
  sun: THREE.Vector3,
  scale: number,
  opacity: number,
  target: TileSun = { on: 0, a: new THREE.Vector4(), b: new THREE.Vector4(), layers: new THREE.Vector2() }
): TileSun {
  const s = sun.clone().normalize()
  const elevation = Math.asin(THREE.MathUtils.clamp(s.dot(up), -1, 1))
  const top = Math.atan(scale * maxTangent)
  // Somewhere on the tile the Sun is under its highest horizon (with the
  // soft edge), and it is up there (6° down: no direct light left).
  target.on = opacity > 0 && elevation + angularRadius > -6 * DEG && elevation - angularRadius - HORIZON_SOFTNESS < top ? 1 : 0
  const east = new THREE.Vector3(0, 1, 0).cross(up).normalize()
  const north = up.clone().cross(east)
  const x = s.dot(east)
  const y = s.dot(north)
  let bin = x * x + y * y > 1e-12 ? (Math.atan2(x, y) * 8) / (2 * Math.PI) : 0
  if (bin < 0) bin += 8
  const d0 = Math.floor(bin) % 8
  const d1 = (d0 + 1) % 8
  const t = bin - Math.floor(bin)
  const w0 = 1 - t
  const l0 = d0 >> 2
  const l1 = d1 >> 2
  target.a.set(0, 0, 0, 0)
  target.b.set(0, 0, 0, 0)
  target.a.setComponent(d0 & 3, w0)
  if (l1 === l0) {
    target.a.setComponent(d1 & 3, target.a.getComponent(d1 & 3) + t)
    target.layers.set(l0, -1)
  } else {
    target.b.setComponent(d1 & 3, t)
    target.layers.set(l0, l1)
  }
  return target
}

let placeholder: THREE.DataArrayTexture | null = null
/** No horizon: what a tile without its grid's map reads (shared, never freed). */
function noHorizon(): THREE.DataArrayTexture {
  if (!placeholder) {
    placeholder = new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2)
    placeholder.format = THREE.RGBAFormat
    placeholder.type = THREE.UnsignedByteType
    placeholder.needsUpdate = true
  }
  return placeholder
}

/**
 * The tile's (b) uniforms: its grid's map (a clone), and tileSun()'s values
 * as getters, worked out again whenever three reads them (each draw of the
 * tile) after the Sun, the scale or the opacity moved.
 */
function tileUniforms(link: GlobeLink, mesh: THREE.Mesh, horizon: THREE.DataArrayTexture): Record<string, THREE.IUniform> {
  const up = mesh.position.clone().applyMatrix3(SURFACE_GROUND_FROM_ECEF).normalize()
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
  const angularRadius = (mesh.geometry.boundingSphere?.radius ?? 0) / SURFACE_ELLIPSOID_RADIUS
  const maxTangent = tileHorizonTangent((horizon.userData.maxCode as number | undefined) ?? 255)
  const state: TileSun = { on: 0, a: new THREE.Vector4(), b: new THREE.Vector4(), layers: new THREE.Vector2() }
  const seen = new THREE.Vector4(NaN)
  let seenOpacity = NaN
  const fresh = () => {
    const sun = link.sunDir.value
    const scale = terrainScaleUniform.value
    const opacity = surfaceOpacityUniform.value
    if (seen.x !== sun.x || seen.y !== sun.y || seen.z !== sun.z || seen.w !== scale || seenOpacity !== opacity) {
      seen.set(sun.x, sun.y, sun.z, scale)
      seenOpacity = opacity
      tileSun(up, angularRadius, maxTangent, sun, scale, opacity, state)
    }
    return state
  }
  return {
    uTileHorizon: { value: horizon.clone() },
    uTileHorizonOn: {
      get value() {
        return fresh().on
      },
    },
    uTileSunA: {
      get value() {
        return fresh().a
      },
    },
    uTileSunB: {
      get value() {
        return fresh().b
      },
    },
    uTileSunLayers: {
      get value() {
        return fresh().layers
      },
    },
  }
}

export const tileShadow: TileAdapter = (link) => {
  const glsl = tileShadowGlsl(link.seaLevel)
  return {
    patch: {
      onBeforeCompile(shader) {
        shader.uniforms.uGroundShadowSun = link.sunDir
        shader.uniforms.uGroundHorizon = link.horizon.map
        shader.uniforms.uGroundHorizonCode = link.horizon.code
        shader.uniforms.uTileHorizon = { value: noHorizon() }
        shader.uniforms.uTileHorizonOn = { value: 0 }
        shader.uniforms.uTileSunA = { value: new THREE.Vector4() }
        shader.uniforms.uTileSunB = { value: new THREE.Vector4() }
        shader.uniforms.uTileSunLayers = { value: new THREE.Vector2(0, -1) }
        shader.vertexShader = surfaceInject(surfaceInject(shader.vertexShader, 'vertexHead', glsl.vertexHead), 'vertexBody', glsl.vertexBody)
        shader.fragmentShader = injectAfterChunk(
          surfaceInject(shader.fragmentShader, 'fragmentHead', glsl.fragmentHead),
          'lights_fragment_end',
          glsl.fragmentBody,
          WHAT
        )
      },
      customProgramCacheKey: () => 'shadow-surface',
    },
    onTile(material, mesh) {
      const horizon = gridHorizon(material.displacementMap)
      if (!horizon) return
      return tileUniforms(link, mesh, horizon)
    },
    onDispose(_material, uniforms) {
      ;(uniforms.uTileHorizon?.value as THREE.Texture | undefined)?.dispose()
    },
  }
}
