// Each finished tile's textures uploaded in the frame budget, before the
// tile shows (tides-zmw.9.25). A tile draws a clone of its elevation grid,
// which shares the grid's upload; stitching (terrain-internals.ts) writes
// edge texels into loaded neighbours' grids, so the grid a new tile reads
// is often changed since its last upload, and its first draw re-uploads it
// (1 MB of float texels), with the tile's imagery. Left to the render, a
// burst of tiles coming into view together (a dozen or more once the
// stream keeps up, surface-queues.ts) uploaded them all in one frame:
// 50-120 ms. Here each tile's uploads are a budget job in the grids' lane,
// so they're timed with the rest of the main-thread work and spread over
// frames, and its first draw finds them done. Nothing is uploaded that the
// first draw wouldn't have.
import type * as THREE from 'three'
import type { FrameBudget } from './frame-budget'

/** The library's loadingState once a tile is evicted (3d-tiles-renderer's UNLOADED). */
const UNLOADED = 0

type TileLike = { internal?: { loadingState?: number } }

/** The textures a tile's first draw would upload: each mesh's elevation clone and imagery. */
function tileTextures(scene: THREE.Object3D): THREE.Texture[] {
  const textures: THREE.Texture[] = []
  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshPhongMaterial | undefined
    if (!material || Array.isArray(material)) return
    if (material.displacementMap) textures.push(material.displacementMap)
    if (material.map) textures.push(material.map)
  })
  return textures
}

/**
 * A 3d-tiles-renderer plugin: processTileModel (awaited before the tile
 * loads) waits for a budget turn and uploads the tile's textures in it.
 * Register after the material plugin; a tile evicted while it waits
 * uploads nothing.
 */
export function createTileUploadPlugin(budget: Pick<FrameBudget, 'run'>, upload: (texture: THREE.Texture) => void) {
  return {
    name: 'SURFACE_TILE_UPLOAD',
    processTileModel(scene: THREE.Object3D, tile: TileLike): Promise<void> {
      return budget.run(() => {
        if (tile?.internal?.loadingState === UNLOADED) return
        for (const texture of tileTextures(scene)) upload(texture)
      })
    },
  }
}
