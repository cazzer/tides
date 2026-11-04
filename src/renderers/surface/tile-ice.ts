// The seasons tour's sea ice on the streamed tiles (tides-5oz): the date's
// ice from NSIDC's 2025 grids, as the globe's shell (../../demo/SeaIceGlobe.tsx)
// draws it, so a close zoom keeps the date's ice where the imagery and the
// day map show the Arctic Ocean iced all year, at any height the tiles draw.
//
// The grids are two layers of the sea's texture array (../seaIceLayers.ts:
// R and G the cover on the weekly frames either side of the date, B the sea,
// A the day map's all-year ice), the uWaterSea the glint already binds: no
// texture unit of its own (the program has none to spare). One tap of it at
// the fragment's place on the grid (../../demo/sea-ice.ts SEA_ICE_GRID_GLSL,
// the north's above the equator, the south's below), at level 0 (25 km
// cells: never minified at tile heights), and one of the tile's elevation
// grid (bumpMap), so the ice lies on the sea only: the DEM's 0 m draws the
// coast to its texel, ANDed with the grid's sea (B), which keeps the ice
// off a lake or the land at sea level a cell from any coast.
//
// As the shell: the alpha is the sea times the most of the cover and the
// all-year ice, and the colour the ice's where the cover is, open water's
// where only the all-year ice is (the day map's ice repainted as the sea it
// is that week). The water's glint and body give way under it (the shell
// covers the globe's), and it is lit as the ground, after the colour
// feature has graded the imagery and before the night's lights.
//
// Placement: the block runs after three's normal_fragment_maps, so after the
// glint has set specularStrength (at the base's specular anchor) and before
// the water's body (just before emissivemap_fragment) reads it; the colour
// goes on just after emissivemap_fragment, before the night's. It comes after
// the glint in TILE_FEATURES so that, composed with it, it finds the array
// already declared and declares nothing of its own.
//
// Switched by uniforms only (one program, no variant): uSeaIceOn while the
// tour holds the ice, uTileIce per tile from its bounding region
// (regionMayHoldIce), refreshed when the gate changes; off, the block is
// skipped and the colour left exactly as it was.
import * as THREE from 'three'
import { ICE_SRGB, OCEAN_SRGB, SEA_ICE_GRID_GLSL } from '../../demo/sea-ice'
import { regionMayHoldIce, SEA_ICE_LAYER, SEA_ICE_LAYER_SIZE, seaIceSurface, uploadSeaIceFrames } from '../seaIceLayers'
import { WATER_SEA_UNIFORM } from '../waterClimate'
import { injectAfterChunk, surfaceInject, type TileAdapter } from './tile-material'
import { GLINT_SEA_LEVEL } from './tile-glint'

const WHAT = 'tile ice'

/** The grid's sea (B) over which the ice may lie: a cell past the coast. */
export const ICE_SEA = [0.2, 0.6] as const

const f = (x: number) => x.toFixed(6)

const linear = (srgb: readonly number[]) => new THREE.Color().setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace)
const glslColour = (c: THREE.Color) => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`

/** The ice's and the repainted sea's colours, linear, as the shell's uniforms take them. */
export const ICE_LINEAR = linear(ICE_SRGB)
export const OCEAN_LINEAR = linear(OCEAN_SRGB)

const HEAD = /* glsl */ `
uniform float uSeaIceOn;
uniform float uSeaIceMix;
uniform float uTileIce;
float seaIceAlpha = 0.0;
vec3 seaIceAlbedo = vec3(0.0);
${SEA_ICE_GRID_GLSL('seaIceCells')}
`

const BODY = /* glsl */ `
if (uSeaIceOn > 0.0 && uTileIce > 0.5) {
  vec4 seaIceTexel = textureLod(uWaterSea, vec3(seaIceCells(surfaceUp) / ${f(SEA_ICE_LAYER_SIZE)},
    surfaceUp.y >= 0.0 ? ${f(SEA_ICE_LAYER.north)} : ${f(SEA_ICE_LAYER.south)}), 0.0);
  float seaIceCover = mix(seaIceTexel.r, seaIceTexel.g, uSeaIceMix);
  #ifdef USE_BUMPMAP
    float seaIceSea = 1.0 - smoothstep(${f(GLINT_SEA_LEVEL[0])}, ${f(GLINT_SEA_LEVEL[1])}, abs(textureLod(bumpMap, vBumpMapUv, 0.0).x));
  #else
    float seaIceSea = 0.0;
  #endif
  seaIceSea *= smoothstep(${f(ICE_SEA[0])}, ${f(ICE_SEA[1])}, seaIceTexel.b);
  float seaIceAny = max(seaIceCover, seaIceTexel.a);
  seaIceAlpha = uSeaIceOn * seaIceSea * seaIceAny;
  seaIceAlbedo = mix(${glslColour(OCEAN_LINEAR)}, ${glslColour(ICE_LINEAR)}, seaIceCover / max(seaIceAny, 1e-3));
  specularStrength *= 1.0 - seaIceAlpha;
}
`

const COLOUR = /* glsl */ `
if (seaIceAlpha > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, seaIceAlbedo, seaIceAlpha);
`

/** The adapter's GLSL (the test checks it). */
export const TILE_ICE_GLSL = { head: HEAD, body: BODY, colour: COLOUR }

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * The GLSL's alpha and colour (linear) for a texel of the layer (0..1
 * channels), the blend `mix` and ground at `elevation` metres, while on.
 */
export function iceOnTile(texel: readonly number[], mix: number, elevation: number): { alpha: number; albedo: THREE.Color } {
  const [r, g, b, a] = texel
  const cover = r + (g - r) * mix
  const sea = (1 - smoothstep(GLINT_SEA_LEVEL[0], GLINT_SEA_LEVEL[1], Math.abs(elevation))) * smoothstep(ICE_SEA[0], ICE_SEA[1], b)
  const any = Math.max(cover, a)
  return { alpha: sea * any, albedo: OCEAN_LINEAR.clone().lerp(ICE_LINEAR, cover / Math.max(any, 1e-3)) }
}

type Region = { boundingVolume?: { region?: readonly number[] } }

export const tileIce: TileAdapter = (link) => {
  const uniforms = {
    uWaterSea: link.water.uniforms.uWaterSea,
    uSeaIceOn: seaIceSurface.on,
    uSeaIceMix: seaIceSurface.mix,
    // The warm-ups' probe (no onTile) skips the block.
    uTileIce: { value: 0 },
  }
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        // Composed after the glint, the array is declared: one declaration.
        const head = shader.fragmentShader.includes(WATER_SEA_UNIFORM) ? HEAD : `${WATER_SEA_UNIFORM}\n${HEAD}`
        let fragment = surfaceInject(shader.fragmentShader, 'fragmentHead', head)
        fragment = injectAfterChunk(fragment, 'normal_fragment_maps', BODY, WHAT)
        shader.fragmentShader = injectAfterChunk(fragment, 'emissivemap_fragment', COLOUR, WHAT)
      },
      customProgramCacheKey: () => 'sea-ice-surface',
    },
    onTile(_material, mesh, tile) {
      const region = (tile as Region).boundingVolume?.region
      const gate = () => (region && !regionMayHoldIce(region) ? 0 : 1)
      const tileIce = { value: gate() }
      let revision = seaIceSurface.revision
      // Before three binds the tile's uniforms and textures: the gate kept
      // up with the ice's, and this frame's weekly frames written if a tile
      // that may hold ice draws.
      const previous = mesh.onBeforeRender
      mesh.onBeforeRender = function (...args) {
        previous.apply(this, args)
        if (revision !== seaIceSurface.revision) {
          revision = seaIceSurface.revision
          tileIce.value = gate()
        }
        if (tileIce.value > 0.5) uploadSeaIceFrames()
      }
      return { uTileIce: tileIce }
    },
  }
}
