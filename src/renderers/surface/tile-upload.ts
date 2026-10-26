// Each new tile's textures uploaded ahead of its first draw, when the frame
// budget has time and bytes to spare (tides-zmw.9.25). A tile draws a clone
// of its elevation grid, which shares the grid's upload; stitching
// (terrain-internals.ts) writes edge texels into loaded neighbours' grids,
// so the grid a new tile reads has often changed since its last upload, and
// its first draw re-uploads it (1 MB of float texels), with its imagery.
// Left to the render, a burst of tiles coming into view together (a dozen
// or more once the stream keeps up, surface-queues.ts) uploaded them all in
// one frame: 50-120 ms.
//
// Never in the tile's way: processTileModel returns at once (the tile loads
// and its parse slot frees as before), and the upload waits in the budget's
// last lane (after grids and bakes, only with time left, at most
// UPLOAD_BYTES_PER_FRAME a frame, frame-budget.ts). A tile its draw got to
// first (visible), or that isn't wanted (not used by the last traversal)
// uploads nothing: its draw, if it ever comes, does what's left. An evicted
// tile's job is dropped at once (disposeTile), letting its model go.
import type * as THREE from 'three'
import type { FrameBudget } from './frame-budget'

interface TileLike {
  traversal?: { used?: boolean; lastFrameVisited?: number }
  engineData?: { scene?: THREE.Object3D | null }
}

interface TilesLike {
  visibleTiles: Set<unknown>
  frameCount: number
}

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

/** What uploading the texture sends in full. */
export function textureBytes(texture: THREE.Texture): number {
  const image = texture.image as { data?: ArrayBufferView; width?: number; height?: number } | null
  if (!image) return 0
  if (image.data) return image.data.byteLength
  return (image.width ?? 0) * (image.height ?? 0) * 4
}

/** An upload function that remembers which texture data it has sent (by three's Source and its version). */
export interface TrackedUpload {
  upload: (texture: THREE.Texture) => void
  /** Whether the texture's data is as it was when this last uploaded it (else, or never: false). */
  isCurrent: (texture: THREE.Texture) => boolean
}

/**
 * Wraps `upload` to remember each Source's version as it sends it: a clone
 * shares its grid's Source, so a tile whose grid was uploaded and not
 * stitched since has nothing to send. Uploads three makes at a draw aren't
 * seen (such a texture counts as not current: at most a no-op upload).
 */
export function trackUploads(upload: (texture: THREE.Texture) => void): TrackedUpload {
  const sent = new WeakMap<object, number>()
  return {
    upload(texture) {
      upload(texture)
      sent.set(texture.source, texture.source.version)
    },
    isCurrent: (texture) => sent.get(texture.source) === texture.source.version,
  }
}

/**
 * A 3d-tiles-renderer plugin: each loaded tile's textures are queued as an
 * upload job in the budget's upload lane; processTileModel doesn't wait.
 */
export function createTileUploadPlugin(budget: Pick<FrameBudget, 'run'>, { upload, isCurrent }: TrackedUpload) {
  let tiles: TilesLike | null = null
  const jobs = new WeakMap<object, AbortController>()
  const drop = (tile: object) => {
    jobs.get(tile)?.abort(new DOMException('tile gone', 'AbortError'))
    jobs.delete(tile)
  }
  return {
    name: 'SURFACE_TILE_UPLOAD',
    init(renderer: TilesLike) {
      tiles = renderer
    },
    processTileModel(scene: THREE.Object3D, tile: TileLike): void {
      drop(tile)
      const job = new AbortController()
      jobs.set(tile, job)
      // what is left to send, or nothing: not this load's model any more,
      // drawn already, or not wanted (the traversal read is last frame's:
      // the budget ticks before this frame's update)
      const pending = (): THREE.Texture[] => {
        const wanted = !!tile?.traversal?.used && tile.traversal.lastFrameVisited === tiles?.frameCount
        if (tile?.engineData?.scene !== scene || !wanted || tiles?.visibleTiles.has(tile)) return []
        return tileTextures(scene).filter((texture) => !isCurrent(texture))
      }
      budget
        .run(
          () => {
            for (const texture of pending()) upload(texture)
            if (jobs.get(tile) === job) jobs.delete(tile)
          },
          job.signal,
          'upload',
          () => pending().reduce((bytes, texture) => bytes + textureBytes(texture), 0)
        )
        .catch(() => {})
    },
    /** Called by the library as a tile's content is dropped (eviction): its job goes too. */
    disposeTile(tile: object) {
      drop(tile)
    },
  }
}
