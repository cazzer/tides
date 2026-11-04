// The date's sea ice on the streamed tiles (tides-5oz, tides-6ru.2): NSIDC's
// 2025 grids, as the globe's ground (../seaIceGround.ts) and the seasons
// tour's shell (../../demo/SeaIceGlobe.tsx) draw it, so a close zoom or a
// low flight keeps the date's ice where the imagery and the day map show the
// Arctic Ocean iced all year, at any height the tiles draw.
//
// The grids are two layers of the sea's texture array (../seaIceLayers.ts:
// R and G the cover on the weekly frames either side of the date, B the sea,
// A the day map's all-year ice), the uWaterSea the glint already binds: no
// texture unit of its own (the program has none to spare). One tap of it at
// the fragment's place on the grid (../seaIceLayers.ts SEA_ICE_TAP_GLSL, the
// ground's too: the north's above the equator, the south's below, none off
// the grid), at level 0 (25 km cells: never minified at tile heights), and
// one of the tile's elevation grid (bumpMap), so the ice lies on the sea
// only: the DEM's 0 m draws the coast to its texel, ANDed with the grid's
// sea (B), which keeps the ice off a lake or the land at sea level a cell
// from any coast.
//
// As the ground (../seaIceLayers.ts seaIceOver, the same maths, so no seam
// where they meet): the alpha is the sea times the most of the cover and the
// all-year ice, and the colour the ice's where the cover is, open water's
// where only the all-year ice is (the day map's ice repainted as the sea it
// is that week). The water's glint and body give way under it, and it is lit
// as the ground, after the colour feature has graded the imagery.
//
// Placement: the block, colour and all, runs after three's
// normal_fragment_maps, so after the glint has set specularStrength (at the
// base's specular anchor) and before the water's body (just before
// emissivemap_fragment) reads it; only the alpha stays live past it, as on
// the ground (the colour laid there too, before its detail). It comes after
// the glint in TILE_FEATURES so that, composed with it, it finds the array
// already declared and declares nothing of its own.
//
// Switched by one uniform (one program, no variant): uTileIce, per tile, the
// ice on (seaIceSurface.on, while the globe shows it) times the tile's gate
// from its bounding region (regionMayHoldIce, refreshed when the gate
// changes), set as the tile draws; off, the block is skipped and the colour
// left exactly as it was.
import {
  ICE_LINEAR,
  ICE_SEA,
  OCEAN_LINEAR,
  regionMayHoldIce,
  SEA_ICE_OVER_GLSL,
  SEA_ICE_TAP_GLSL,
  SEA_ICE_TAP_HEAD,
  seaIceOver,
  seaIceSurface,
  uploadSeaIceFrames,
} from '../seaIceLayers'
import { WATER_SEA_UNIFORM } from '../waterClimate'
import { injectAfterChunk, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile ice'

export { ICE_LINEAR, ICE_SEA, OCEAN_LINEAR }

const HEAD = /* glsl */ `
uniform float uSeaIceMix;
uniform float uTileIce;
float seaIceAlpha = 0.0;
${SEA_ICE_TAP_HEAD}
`

const BODY = /* glsl */ `
if (uTileIce > 0.5) {
  ${SEA_ICE_TAP_GLSL('surfaceUp')}
  #ifdef USE_BUMPMAP
    float seaIceElevation = textureLod(bumpMap, vBumpMapUv, 0.0).x;
  #else
    float seaIceElevation = 1.0e4;
  #endif
  ${SEA_ICE_OVER_GLSL({ elevation: 'seaIceElevation' })}
  specularStrength *= 1.0 - seaIceAlpha;
}
`

/** The adapter's GLSL (the test checks it). */
export const TILE_ICE_GLSL = { head: HEAD, body: BODY }

/**
 * The GLSL's alpha and colour (linear) for a texel of the layer (0..1
 * channels), the blend `mix` and ground at `elevation` metres, while on:
 * the ground's (seaIceOver).
 */
export const iceOnTile = seaIceOver

type Region = { boundingVolume?: { region?: readonly number[] } }

export const tileIce: TileAdapter = (link) => {
  const uniforms = {
    uWaterSea: link.water.uniforms.uWaterSea,
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
        const fragment = surfaceInject(shader.fragmentShader, 'fragmentHead', head)
        shader.fragmentShader = injectAfterChunk(fragment, 'normal_fragment_maps', BODY, WHAT)
      },
      customProgramCacheKey: () => 'sea-ice-surface',
    },
    onTile(_material, mesh, tile) {
      const region = (tile as Region).boundingVolume?.region
      const gateOf = () => (region && !regionMayHoldIce(region) ? 0 : 1)
      let gate = gateOf()
      const tileIce = { value: 0 }
      let revision = seaIceSurface.revision
      // Before three binds the tile's uniforms and textures: the gate kept
      // up with the ice's, this frame's weekly frames written if a tile
      // that may hold ice draws, and the block on while the ice is.
      const previous = mesh.onBeforeRender
      mesh.onBeforeRender = function (...args) {
        previous.apply(this, args)
        if (revision !== seaIceSurface.revision) {
          revision = seaIceSurface.revision
          gate = gateOf()
        }
        if (gate > 0) uploadSeaIceFrames()
        tileIce.value = gate * seaIceSurface.on.value
      }
      return { uTileIce: tileIce }
    },
  }
}
