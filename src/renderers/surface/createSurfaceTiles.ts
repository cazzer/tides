// Builds the streamed surface (tides-zmw.9.1): a 3d-tiles-renderer
// TilesRenderer fed by Mapterhorn's Terrarium-encoded elevation tiles, meshed
// on the client and draped with SurfaceImageryOverlay, in Earth's local frame
// (surface-frame.ts). SurfaceTiles owns the instance's life; this module owns
// its recipe, kept out of the component so it reads as one place.
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import { applySurfaceBumpScale, applySurfaceFrame, SURFACE_ELLIPSOID_RADIUS } from './surface-frame'

/** Mapterhorn's global terrain (Copernicus GLO-30 and national DEMs), 512 px WebP Terrarium. */
export const MAPTERHORN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
export const MAPTERHORN_TILE_SIZE = 512
/** Mapterhorn's deepest level everywhere it has data (~2.4 m/px at the equator). */
export const MAPTERHORN_MAX_ZOOM = 16

export interface SurfaceTiles {
  tiles: TilesRenderer
  terrain: TerrariumMeshPlugin
  overlay: SurfaceImageryOverlay
  dispose(): void
}

export function createSurfaceTiles(): SurfaceTiles {
  const overlay = new SurfaceImageryOverlay()
  const terrain = new TerrariumMeshPlugin({
    url: MAPTERHORN_URL,
    tileDimension: MAPTERHORN_TILE_SIZE,
    maxZoom: MAPTERHORN_MAX_ZOOM,
    // True scale for now: the globe's RELIEF exaggeration reaches the tiles
    // with the shared terrain scale (tides-zmw.9.7).
    heightScale: 1,
    overlay,
    applyOverlayTexture: true,
  })
  const tiles = new TilesRenderer()
  // A sphere like the app's globe, not WGS84, so a lat/lon lands where the
  // globe's map has it. registerPlugin sets errorTarget to 1 (the plugin's
  // recommended settings), the spike's measured choice; speed-dependent
  // targets are tides-zmw.9.2's.
  tiles.ellipsoid.radius.setScalar(SURFACE_ELLIPSOID_RADIUS)
  tiles.registerPlugin(terrain)
  applySurfaceFrame(tiles.group)
  tiles.group.name = 'surface-tiles'
  tiles.group.userData.tiles = tiles

  // Earth's mesh takes pointer events (OrbitingBody's onPointerDown), and R3F
  // raycasts its children too: the group's own raycast would hit-test every
  // loaded tile against a CPU-displaced copy of its mesh on each pointer
  // event. Returning false skips the tiles and everything under them, which
  // is what the scene did before they existed.
  tiles.group.raycast = () => false

  // The plugin has set each tile's bump scale by the time it reports the
  // model loaded; put it in scene units (see applySurfaceBumpScale).
  tiles.addEventListener('load-model', ({ scene }) => applySurfaceBumpScale(scene, terrain.heightScale))

  // Ocean tiles 404 at Mapterhorn and some imagery fails; until tides-zmw.9.2
  // fills them, say so once rather than once a tile.
  let loadErrors = 0
  tiles.addEventListener('load-error', (event) => {
    loadErrors++
    tiles.group.userData.loadErrors = loadErrors
    if (loadErrors === 1) console.warn('surface tiles: a tile failed to load (more are counted in userData.loadErrors)', event.url)
  })

  return {
    tiles,
    terrain,
    overlay,
    // tiles.dispose() unregisters the terrain plugin, which releases every
    // loaded tile's grid and overlay texture; in-flight parses release theirs
    // as they abort. The overlay's caches are reference counted, so they
    // empty themselves (disposing each texture and aborting its download) a
    // microtask later. Don't also dispose the overlay's caches: the library's
    // DataCache.dispose throws on an entry already released and awaiting that
    // microtask, and a throw in an effect cleanup unmounts the whole app.
    dispose() {
      tiles.dispose()
    },
  }
}
