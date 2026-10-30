// Stand-ins for the streamed tiles' flight programs (tides-tvr.7.7): the
// first close zoom's descent (or the ship's) reaches the tiles with flight
// detail on, and the first tile to draw links the tiles' full program
// (Phong with every feature, tile-material.ts), 130 to 370 ms a frame where
// the driver links at first use. The warm-ups can't reach the tiles
// themselves: their group is out of coldWork (createSurfaceTiles.ts,
// userData.warmup false), and the tiles that would draw it don't exist
// until the descent loads them. So the ground lists these as probes
// (ship-warmup.ts WarmProbe, EarthRenderer's groundWarmProbes), built on
// the flight state's link: three shares a program between materials by
// cache key, so the first tile finds it linked.
//
// A probe is a tile as the tileset makes it: the terrain plugin's Lambert
// (an imagery map, one elevation grid as both displacement and bump), the
// composer's material on it (TileComposer.material, the same builder as
// prepare), then the fade plugin's wrapper as FadeMaterialManager's
// prepareMaterial applies it. The fade keys two programs, FEATURE_FADE 1
// while a tile fades in or out and 0 once it's settled, and a descent
// draws both at once, so there is a probe for each. A tile's own uniforms
// (onTile's) change no text or key, so the probe leaves them out.
//
// In the lazy surface chunk, with the composer and the library's material:
// loaded at the warm-ups' first idle look at the ground (tileWarmProbes.ts),
// never at page load.
import * as THREE from 'three'
import { TerrainLambertMaterial } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import type { WarmProbe } from '../../ship/ship-warmup'
import type { GlobeLink } from './surface-link'
import { TILE_FEATURES } from './tile-features'
import { createTileComposer } from './tile-material'

export interface TileProbes {
  /** FEATURE_FADE 1, then 0. */
  probes: WarmProbe[]
  /** Frees the probes' materials, maps and geometry. */
  dispose(): void
}

/** The tiles' programs on `link` as probes, one per fade variant. */
export function createTileProbes(link: GlobeLink): TileProbes {
  const composer = createTileComposer(link, TILE_FEATURES)
  // Three keys no geometry's size, only its attributes (a tile's: position,
  // normal, uv); one quad for both.
  const geometry = new SkirtedPlaneGeometry(1, 1, 1, 1)
  const owned: { dispose(): void }[] = [geometry]
  const probes = [1, 0].map((fade): WarmProbe => {
    // As the terrain plugin leaves a tile (TerrainRGBMeshPlugin): the
    // overlay's map, the grid as both displacement and bump.
    const terrain = new TerrainLambertMaterial()
    const grid = new THREE.DataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType)
    terrain.map = new THREE.Texture()
    terrain.displacementMap = grid
    terrain.bumpMap = grid
    const material = composer.material(terrain)
    terrain.dispose()
    // As FadeMaterialManager.prepareMaterial wraps it, and as setFade sets
    // the define.
    wrapFadeMaterial(material, material.onBeforeCompile)
    material.defines!.FEATURE_FADE = fade
    owned.push(material, terrain.map, grid)
    // Skipped once disposed: a warm-up's queue may still hold the probe
    // after a new link replaced it, and compiling a disposed material would
    // take a program nothing frees.
    return { object: new THREE.Mesh(geometry, material), prepare: () => !disposed }
  })
  let disposed = false
  return {
    probes,
    dispose: () => {
      disposed = true
      owned.forEach((item) => item.dispose())
    },
  }
}
