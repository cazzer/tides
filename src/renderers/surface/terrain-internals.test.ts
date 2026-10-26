// Pins every 3d-tiles-renderer internal terrain-internals.ts relies on to
// 0.5.3 (tides-zmw.9.2): if any of these fail after a bump, reread the
// library before touching the expectations.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
} from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { GridCache } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js'
import { FrameBudget } from './frame-budget'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import {
  forEachCachedModel,
  GRID_LEVEL_STEP,
  installSurfaceGridCache,
  PINNED_TILES_VERSION,
  protectOverlayBitmaps,
  shareGridBytes,
  quietTilesetVersion,
  FailedTileBackoff,
  RETRY_BACKOFF_MAX_MS,
  retryFailedTiles,
  startFailedTileRetry,
  SurfaceGridCache,
  type SurfaceGridOptions,
  type TerrainPluginInternals,
} from './terrain-internals'
import { decodeTerrariumPadded, type PaddedGrid } from './terrarium'

const LIB = path.resolve(process.cwd(), 'node_modules/3d-tiles-renderer')
const read = (file: string) => readFileSync(path.join(LIB, file), 'utf8')
const built = (pattern: RegExp) =>
  readdirSync(path.join(LIB, 'build'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => read(`build/${f}`))
    .filter((src) => pattern.test(src))

// The library's GridCache constructor makes an OffscreenCanvas (node has none).
class FakeOffscreenCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext() {
    return null
  }
}

describe('3d-tiles-renderer internals (pinned to 0.5.3)', () => {
  it('is 0.5.3, exactly, in node_modules and package.json', () => {
    expect(JSON.parse(read('package.json')).version).toBe(PINNED_TILES_VERSION)
    const app = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
    expect(app.dependencies['3d-tiles-renderer']).toBe(PINNED_TILES_VERSION)
  })

  it('builds the terrain plugin with a replaceable _gridCache and a queue-routed _source.fetchData', () => {
    const [plugins, ...others] = built(/_gridCache/)
    expect(others).toHaveLength(0)
    // the property names survive minification; the class names don't
    expect(plugins).toMatch(/this\._gridCache = new \w+\(this\)/)
    expect(plugins).toContain('this._source.fetchData = ')
    // the plugin only ever locks, gets and releases grids
    const uses = [...plugins.matchAll(/_gridCache\.(\w+)\(/g)].map((m) => m[1])
    expect(new Set(uses)).toEqual(new Set(['lock', 'get', 'release']))
  })

  it('reads the tileset asset only in preprocessTileset, for the version warning', () => {
    const [renderer, ...others] = built(/preprocessTileset\(e, t, n = null\)/)
    expect(others).toHaveLength(0)
    expect([...renderer.matchAll(/\.asset\.[\w.]+/g)].map((m) => m[0])).toEqual(['.asset.version.split'])
    expect(read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')).toContain("asset: { version: '1.1' }")
  })

  it("closes every material texture's ImageBitmap when TilesRenderer drops a tile; the overlay source makes and closes them", () => {
    const [renderer, ...others] = built(/\.image instanceof ImageBitmap && \w\.image\.close\(\), \w\.dispose\(\)/)
    expect(others).toHaveLength(0)
    expect(renderer.match(/\.image instanceof ImageBitmap && \w\.image\.close\(\), \w\.dispose\(\)/g)).toHaveLength(2)
    const src = read('src/three/plugins/images/sources/TiledImageSource.js')
    expect(src).toContain('.then( buffer => this.processBufferToTexture( buffer ) );')
    expect(src).toContain('texture.image.close();')
  })

  it("sums every plugin's calculateBytesUsed into a tile's bytes, three's estimate counting each scene's textures", () => {
    const sum = /\w\.calculateBytesUsed && \(\w \+= \w\.calculateBytesUsed\(\w, \w\.engineData\.scene\) \|\| 0\)/
    expect(built(sum)).toHaveLength(1)
    expect(read('src/three/renderer/tiles/TilesRenderer.js')).toContain('bytesUsed.set( tile, estimateBytesUsed( scene ) );')
  })

  // tides-zmw.9.7 (surface-scale.ts): the tiles' height comes from the GPU
  // (displacementMap x displacementScale, set once per parse and only again
  // by the heightScale setter), the bump from the terrain material's own
  // chunk, the bounds from heightScale at construction; and processTileModel
  // runs before load-model, where the fade plugin wraps the materials.
  it('displaces tiles on the GPU at displacementScale, set at parse and by the setter alone', () => {
    const [plugins, ...others] = built(/\.material\.displacementScale = this\._heightScale/)
    expect(others).toHaveLength(0)
    expect(plugins.match(/\w+\.material\.displacementScale = this\._heightScale, \w+\.material\.bumpScale = this\._heightScale/g)).toHaveLength(2)
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('mesh.material.displacementMap = displacement;')
    expect(src).toContain('surface.getCartographicToPosition( lat, lon, 0, _pos ).sub( _sphere.center );')
    expect(src).toContain('const skirtDepth = tile.geometricError + ( maxHeight - minHeight ) * _heightScale;')
    // surface-scale.ts SURFACE_VERTEX_COUNT is (MESH_SIZE + 1)²
    expect(src).toContain('const MESH_SIZE = 32;')
    expect(src).toContain('const geometry = new SkirtedPlaneGeometry( 1, 1, MESH_SIZE, MESH_SIZE );')
  })

  it("shades the tiles' bump with the terrain material's own gradient, bumpScale times it", () => {
    const [plugins, ...others] = built(/float dBx = bumpScale \*/)
    expect(others).toHaveLength(0)
    expect(plugins).toContain('float dBx = bumpScale * ( gradU * dSTdx.x + gradV * dSTdx.y );')
    expect(plugins).toContain('float dBy = bumpScale * ( gradU * dSTdy.x + gradV * dSTdy.y );')
  })

  it('sizes the bounding volumes from heightScale, up to 9000 m times it', () => {
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('const MAX_ELEVATION = 9000;')
    expect(src).toContain('const maxHeight = MAX_ELEVATION * this.heightScale;')
    expect(src).toContain('const scale = this._heightScale;')
    expect(built(/\w+ = \w+ \* this\.heightScale - \w+, \w+ = \w+ \* this\.heightScale/)).toHaveLength(1)
  })

  it('runs processTileModel in parseTile, before the load-model the fade plugin wraps materials at', () => {
    expect(built(/await this\.invokeAllPlugins\(\(\w\) => \w\.processTileModel && \w\.processTileModel\(/)).toHaveLength(1)
    const base = read('src/core/renderer/tiles/TilesRendererBase.js')
    const parse = base.indexOf('plugin.parseTile && plugin.parseTile( content, parseTile, extension, url, signal )')
    const loaded = base.indexOf("type: 'load-model',")
    expect(parse).toBeGreaterThan(0)
    expect(loaded).toBeGreaterThan(parse)
    const fade = read('src/three/plugins/fade/TilesFadePlugin.js')
    expect(fade).toContain("tiles.addEventListener( 'load-model', this._onLoadModel );")
    expect(fade).toContain('this._fadeMaterialManager.prepareScene( scene );')
    expect(read('src/three/plugins/fade/FadeMaterialManager.js')).toContain(
      'fadeParams.set( material, wrapFadeMaterial( material, material.onBeforeCompile ) );'
    )
  })

  it('writes every bounding region through _updateBoundingVolume, and takes each traversed tile\'s view error through calculateTileViewError', () => {
    const [plugins, ...others] = built(/this\._updateBoundingVolume\(\w\)/)
    expect(others).toHaveLength(0)
    expect(plugins.match(/this\._updateBoundingVolume\(\w\)/g)).toHaveLength(3)
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('tiles.traverse( tile => {\n\n\t\t\tthis._updateBoundingVolume( tile );')
    expect(built(/calculateTileViewErrorWithPlugin\(\w, \w\) \{\s*this\.calculateTileViewError\(\w, \w\)/)).toHaveLength(1)
    expect(read('src/core/renderer/tiles/traverseFunctions.js')).toContain('renderer.calculateTileViewErrorWithPlugin( tile, viewErrorTarget );')
  })

  it('reads grids at every second level (EXTRA_LEVELS 2) down to the deepest, each tile the one at or above its level (tides-zmw.9.21)', () => {
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('const EXTRA_LEVELS = 2;')
    expect(src).toContain('return Math.min( EXTRA_LEVELS * Math.floor( level / EXTRA_LEVELS ), maxSourceLevel );')
    expect(src).toContain('this._maxSourceLevel = EXTRA_LEVELS * Math.floor( maxZoom / EXTRA_LEVELS );')
    expect(src).toContain('let maxLevel = this._maxSourceLevel + EXTRA_LEVELS - 1;')
    expect(GRID_LEVEL_STEP).toBe(2)
    // each tile's content uri is its grid's url; its x, y and level on module symbols, found by description
    expect(src).toContain("const TILE_X = Symbol( 'TILE_X' );\nconst TILE_Y = Symbol( 'TILE_Y' );\nconst TILE_LEVEL = Symbol( 'TILE_LEVEL' );")
    expect(src).toContain('uri: this.getUrl( x, y, level ),')
    expect(src).toContain('[ TILE_X ]: x,\n\t\t\t[ TILE_Y ]: y,\n\t\t\t[ TILE_LEVEL ]: level,')
    // the grid's tile rectangle, normalized, v north (the subview the meshes read)
    expect(src).toContain('const renderBounds = this._tiling.getTileBounds( x, y, level, true );')
    expect(src).toContain("const sourceBounds = this._tiling.getTileBounds( sx, sy, sourceLevel, true );")
  })

  it("bounds a tile's region by its grid's elevation range, which outlives its grid, seeding its children (tides-zmw.9.21)", () => {
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('min = range.min * scale - pad - ( range.max - range.min ) * scale;\n\t\t\tmax = range.max * scale + pad;')
    expect(src).toContain("child[ HEIGHT_RANGE ] = tile[ HEIGHT_RANGE ];")
    // released: the grid, not the range
    expect(src).toContain('this._gridCache.release( ...sourceTile );\n\t\t\tdelete tile[ SOURCE_TILE ];\n\t\t\tdelete tile[ HEIGHT_GRID ];')
    expect(src.match(/delete tile\[ HEIGHT_RANGE \]/g)).toBeNull()
    // and a REPLACE tile none of whose children is in the frustum is hidden (not drawn, kept cached), cascading up
    const traverse = read('src/core/renderer/tiles/traverseFunctions.js')
    expect(traverse).toContain("if ( tile.refine === 'REPLACE' && ! anyChildrenInFrustum && children.length !== 0 ) {\n\n\t\ttile.traversal.inFrustum = false;")
  })

  it('takes the view error from each camera\'s root-frame position and sseDenominator, Infinity at distance 0, on the ellipsoid\'s cartographic conversions (tides-zmw.9.17)', () => {
    const src = read('src/three/renderer/tiles/TilesRenderer.js')
    expect(src).toContain('sseDenominator: - 1, // used if isOrthographic:false\n\t\t\t\tposition: new Vector3(),')
    expect(src).toContain('info.sseDenominator = ( 2 / projection[ 5 ] ) / resolution.height;')
    expect(src).toContain('position.applyMatrix4( group.matrixWorldInverse );')
    expect(src).toContain('distance = boundingVolume.distanceToPoint( info.position );\n\t\t\t\terror = distance === 0 ? Infinity : tile.geometricError / ( distance * sseDenominator );')
    expect(src).toContain('if ( boundingVolume.intersectsFrustum( frustum ) ) {')
    expect(src).toContain('target.error = inViewError;\n\t\t\ttarget.distanceFromCamera = inViewDistance;')
    expect(src).toContain('target.error = maxCameraError;\n\t\t\ttarget.distanceFromCamera = minCameraDistance;')
    expect(read('src/core/renderer/tiles/TilesRendererBase.js')).toContain('this.frameCount ++;')
    const ellipsoid = read('src/three/renderer/math/Ellipsoid.js')
    expect(ellipsoid).toContain('getPositionToCartographic( pos, target ) {')
    expect(ellipsoid).toContain('target.height = Math.sign( heightDelta.dot( pos ) ) * heightDelta.length();')
    expect(ellipsoid).toContain('getCartographicToPosition( lat, lon, height, target ) {')
  })

  it("draws a tile's scene as a child of the group, kept there through its fade out, and lists loaded scenes by engineData.scene (tides-zmw.9.8)", () => {
    const renderer = read('src/three/renderer/tiles/TilesRenderer.js')
    expect(renderer).toContain('const scene = tile.engineData && tile.engineData.scene;\n\t\t\tif ( scene ) {\n\n\t\t\t\tcallback( scene, tile );')
    expect(renderer).toContain('if ( visible ) {\n\n\t\t\t\tgroup.add( scene );\n\n\t\t\t} else {\n\n\t\t\t\tgroup.remove( scene );')
    // An active, hidden scene keeps the group as its parent without being its child.
    expect(renderer).toContain('scene.parent = group;')
    // The fade plugin hides a tile (the built-in setTileVisible) only once its fade out ends.
    expect(read('src/three/plugins/fade/TilesFadePlugin.js')).toContain(
      'tiles.invokeOnePlugin( plugin => plugin !== this && plugin.setTileVisible && plugin.setTileVisible( tile, false ) );'
    )
  })

  it("keeps each tile's grid on its material's displacementMap, a clone sharing the cached image, and its uvs into it (tides-zmw.9.8)", () => {
    const src = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(src).toContain('const displacement = grid.clone();\n\t\tmesh.material.displacementMap = displacement;')
    expect(src).toContain('uv.setXY( i, tu, tv );')
    expect(src).toContain('const height = sampleGrid( grid, tu, tv );')
    expect(src).toContain('const MESH_SIZE = 32;')
    // Its region is [west, south, east, north, min, max], radians.
    expect(src).toContain('const region = boundingVolume.region;\n\t\t\tregion[ 4 ] = min;\n\t\t\tregion[ 5 ] = max;')
  })

  it('holds every tile it loads in lruCache.itemList, added on load and spliced out on removal (tides-zmw.9.8)', () => {
    const lru = read('src/core/renderer/utilities/LRUCache.js')
    expect(lru).toContain('this.itemList = [];')
    expect(lru).toContain('itemList.push( item );')
    expect(lru).toContain('const index = itemList.indexOf( item );\n\t\t\titemList.splice( index, 1 );')
    expect(read('src/core/renderer/tiles/TilesRendererBase.js')).toContain('const addedSuccessfully = lruCache.add( tile, t => {')
    // forEachCachedModel reads it as forEachLoadedModel walks the tree.
    const scenes = [new Object3D(), new Object3D()]
    const items = [{ engineData: { scene: scenes[0] } }, { engineData: { scene: null } }, {}, { engineData: { scene: scenes[1] } }]
    const seen: unknown[] = []
    forEachCachedModel({ lruCache: { itemList: items } } as unknown as TilesRenderer, (scene, tile) => seen.push(scene, tile))
    expect(seen).toEqual([scenes[0], items[0], scenes[1], items[3]])
  })

  it('keeps stitchNeighbors on the source GridCache', () => {
    expect(typeof GridCache.prototype.stitchNeighbors).toBe('function')
    const src = read('src/three/plugins/images/terrain-rgb/GridCache.js')
    expect(src).toContain('const tiling = this.plugin._source.tiling;')
    expect(src).toContain('fillBorder( neighbor, grid, - dx, - dy );')
  })

  // tides-zmw.9.20 (retryFailedTiles): how a tile fails, stays failed in the
  // LRU cache, is evicted back to UNLOADED and requested again, and why the
  // library's own reset can't be used on the terrain plugin's tree.
  it('keeps a failed tile in the LRU cache at FAILED (-1) until evicted back to UNLOADED (0), and requests only what the cache admits', () => {
    const constants = read('src/core/renderer/constants.js')
    expect(constants).toContain('export const FAILED = - 1;')
    expect(constants).toContain('export const UNLOADED = 0;')
    const base = read('src/core/renderer/tiles/TilesRendererBase.js')
    expect(base).toContain('stats.failed ++;')
    expect(base).toContain('tile.internal.loadingState = FAILED;\n\t\t\t\t\tloadingTiles.delete( tile );\n\t\t\t\t\tlruCache.setLoaded( tile, true );')
    expect(built(/\.internal\.loadingState = -1, \w\.delete\(\w\), \w\.setLoaded\(\w, !0\)/)).toHaveLength(1)
    // requestTileContents: only from UNLOADED, and only once the cache takes the tile
    expect(base).toContain('if ( tile.internal.loadingState !== UNLOADED ) {\n\n\t\t\treturn;')
    expect(base).toContain('const addedSuccessfully = lruCache.add( tile, t => {')
    expect(base).toContain('if ( ! addedSuccessfully ) {\n\n\t\t\treturn;')
    // the eviction callback puts any state back to UNLOADED, leaving stats.failed alone
    const evict = base.slice(base.indexOf('const addedSuccessfully = lruCache.add( tile, t => {'), base.indexOf('if ( ! addedSuccessfully ) {'))
    expect(evict).toContain('t.internal.loadingState = UNLOADED;')
    expect(evict).not.toContain('failed')
    expect(built(/if \(\w\.add\(\w, \(\w\) => \{\s*\w\.abort\(\), \w \? \w\.children\.length = 0 : this\.invokeAllPlugins\(/)).toHaveLength(1)
    expect(built(/\w\.internal\.loadingState === 4 && \w\.loaded--, \w\.internal\.loadingState = 0, \w\.remove\(\w\), \w\.remove\(\w\), \w\.delete\(\w\);\s*\}\)\) return/)).toHaveLength(1)
    // a root that failed loads again once UNLOADED
    expect(base).toContain('if ( this.rootLoadingState === UNLOADED ) {')
    const lru = read('src/core/renderer/utilities/LRUCache.js')
    expect(lru).toContain('if ( itemSet.has( item ) ) {\n\n\t\t\treturn false;')
    expect(lru).toContain('this.itemList = [];')
    expect(lru).toContain('callbacks.get( item )( item );\n\n\t\t\tconst index = itemList.indexOf( item );\n\t\t\titemList.splice( index, 1 );')
  })

  it("resets failed tiles over the whole tree by tile.internal, which the terrain plugin's unprocessed children lack, and leaves them in the cache", () => {
    const base = read('src/core/renderer/tiles/TilesRendererBase.js')
    const reset = base.slice(base.indexOf('\tresetFailedTiles() {'), base.indexOf('calculateTileViewErrorWithPlugin( tile, target ) {'))
    expect(reset).toContain('this.traverse( tile => {\n\n\t\t\tif ( tile.internal.loadingState === FAILED ) {')
    expect(reset).toContain('}, null, false );')
    expect(reset).not.toContain('lruCache')
    expect(base).toContain('\t\t\tif ( ensureFullyProcessed ) {\n\n\t\t\t\tthis.ensureChildrenArePreprocessed( tile, true );')
    const plugin = read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')
    expect(plugin).toContain('if ( level < maxLevel && tile.parent !== null ) {\n\n\t\t\tthis.expandChildren( tile );')
    expect(plugin).toContain('tile.children.push( child );')
  })

  it('decodes as the library does: rows south first, edge texels copied into the border', async () => {
    // The library's own decode (GridCache.fetchItem's module-local
    // readImageData) over a fake canvas holding the image as it draws it,
    // flipped on load; ours reads the unflipped pixels.
    const w = 5
    const h = 4
    const topDown = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37 + 11) % 256)
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) flipped.set(topDown.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    const terrarium = TerrariumMeshPlugin.prototype as unknown as { decodeElevation(r: number, g: number, b: number): number }
    const plugin = new (class {
      decodeElevation = terrarium.decodeElevation
      _source = {
        fetchItem: async () => ({ image: { width: w, height: h } }),
        disposeItem: () => {},
        tiling: { getLevel: () => ({ tileCountX: 1 }), flipY: true },
      }
    })()
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    try {
      const cache = new GridCache(plugin)
      ;(cache as unknown as { canvas: unknown }).canvas = { getContext: () => ({ drawImage() {}, clearRect() {}, getImageData: () => ({ data: flipped }) }) }
      const theirs = (await GridCache.prototype.fetchItem.call(cache, [0, 0, 0], new AbortController().signal)) as DataTexture
      const ours = decodeTerrariumPadded(topDown, w, h)
      expect([theirs.image.width, theirs.image.height]).toEqual([ours.width, ours.height])
      expect(Array.from(theirs.image.data as unknown as Float32Array)).toEqual(Array.from(ours.data))
      expect([theirs.format, theirs.type]).toEqual([RedFormat, FloatType])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/** A plugin wired as loadRootTileset leaves it, with fetch and window stubbed. */
async function loadedPlugin(quiet = true) {
  const terrain = new TerrariumMeshPlugin({ url: 'https://tiles.example/{z}/{x}/{y}.webp', tileDimension: 4, maxZoom: 8 })
  const tiles = new TilesRenderer()
  if (quiet) quietTilesetVersion(tiles)
  tiles.registerPlugin(terrain)
  await (terrain as unknown as { loadRootTileset(): Promise<unknown> }).loadRootTileset()
  return { terrain, tiles }
}

function options(over: Partial<SurfaceGridOptions> = {}): SurfaceGridOptions & { budget: FrameBudget } {
  const budget = new FrameBudget(Infinity)
  return {
    filter: 'nearest',
    decode: async () => ({ data: new Float32Array(36).fill(7), width: 6, height: 6 }),
    budget,
    retryDelays: [0, 0],
    ...over,
  } as SurfaceGridOptions & { budget: FrameBudget }
}

/** Lets the budget's waiters through until `pending` settles (grids above lock on the way). */
async function drain(budget: FrameBudget, pending: unknown) {
  let settled = false
  Promise.resolve(pending).then(
    () => (settled = true),
    () => (settled = true)
  )
  for (let n = 0; !settled && n < 1000; n++) {
    budget.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Resolves once the budget has someone waiting, then lets them through. */
async function release(budget: FrameBudget) {
  await vi.waitFor(() => expect(budget.pending).toBeGreaterThan(0))
  budget.tick()
}

describe('SurfaceGridCache (tides-zmw.9.2)', () => {
  const fetches: string[] = []
  let answer: (url: string, init?: RequestInit) => Promise<Response>

  beforeEach(() => {
    fetches.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
    // the library's queues schedule their runs on animation frames
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      fetches.push(url)
      return answer(url, init)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes over the plugin cache, and the plugin routes its fetches through the tiles queue', async () => {
    const { terrain, tiles } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    expect((terrain as unknown as TerrainPluginInternals)._gridCache).toBe(cache)
    const add = vi.spyOn(tiles.downloadQueue, 'add')
    answer = async () => new Response(null, { status: 404 })
    const grid = cache.lock(1, 1, 1)
    await release(opts.budget)
    await grid
    expect(add).toHaveBeenCalledTimes(1)
    expect(fetches).toEqual(['https://tiles.example/1/1/1.webp'])
  })

  it('makes a 404 a flat, full-size sea-level grid and cancels its body', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    const cancel = vi.fn(async () => {})
    answer = async () => {
      const res = new Response('Not Found', { status: 404 })
      vi.spyOn(res.body!, 'cancel').mockImplementation(cancel)
      return res
    }
    const pending = cache.lock(1, 0, 1)
    await release(opts.budget)
    const grid = (await pending) as DataTexture
    expect([grid.image.width, grid.image.height]).toEqual([6, 6]) // tileDimension 4 + border
    expect((grid.image.data as unknown as Float32Array).every((v) => v === 0)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cache.flatTiles).toBe(1)
  })

  it('asks nothing under a tile that answered no data over open water', async () => {
    const { terrain } = await loadedPlugin()
    // sea level in the grids above z4, none at z4
    const opts = options({ decode: async () => ({ data: new Float32Array(36), width: 6, height: 6 }) })
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async (url) => new Response(url.includes('/4/') ? null : new Uint8Array([1]), { status: url.includes('/4/') ? 404 : 200 })
    // held by its tiles, as the traversal loads a parent before its children
    const above = cache.lock(1, 1, 2)
    await drain(opts.budget, above)
    const parent = cache.lock(6, 5, 4)
    await drain(opts.budget, parent)
    // the "no data" reads the grid above, which holds nothing over the sea there
    expect(fetches).toEqual(['https://tiles.example/2/1/1.webp', 'https://tiles.example/4/6/5.webp'])
    const child = cache.lock(25, 21, 6)
    await drain(opts.budget, child)
    expect(fetches).toHaveLength(2)
    expect(cache.flatTiles).toBe(2)
    expect(cache.cappedTiles).toBe(0)
    expect(cache.coverageEnd.size).toBe(0)
    expect(cache.coverageLevel(25, 21, 6)).toBe(-1)
    // a sibling of the parent is still asked for
    const sibling = cache.lock(7, 5, 4)
    await drain(opts.budget, sibling)
    expect(fetches).toHaveLength(3)
    expect(cache.flatTiles).toBe(3)
  })

  it('makes a "no data" with none above it open water, every grid up to the root asked once', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(null, { status: 404 })
    const tile = cache.lock(6, 5, 4)
    await drain(opts.budget, tile)
    expect(fetches).toEqual(['https://tiles.example/4/6/5.webp', 'https://tiles.example/2/1/1.webp', 'https://tiles.example/0/0/0.webp'])
    expect(cache.flatTiles).toBe(3)
    expect(cache.coverageEnd.size).toBe(0)
  })

  describe('past the coverage end (tides-zmw.9.21)', () => {
    // A tilted plane of ground, which bilinear reads reproduce exactly.
    const plane = (i: number, j: number) => 1000 + 100 * i + 10 * j
    const planeGrid = async (): Promise<PaddedGrid> => {
      const data = new Float32Array(36)
      for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) data[j * 6 + i] = plane(i, j)
      return { data, width: 6, height: 6 }
    }
    // Data down to z4 (z2 above it), none at z6 and deeper.
    const coverage = (deepest: number) => async (url: string) => {
      const z = Number(url.split('/')[3])
      return z > deepest ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1]), { status: 200 })
    }
    const tiling = (terrain: TerrariumMeshPlugin) =>
      (terrain as unknown as { _tiling: { getTileBounds(x: number, y: number, l: number, n?: boolean): number[] } })._tiling

    it("draws a 404 under a data grid from that grid's ground, where the plugin read it, and records the coverage end", async () => {
      const { terrain } = await loadedPlugin()
      const opts = options({ decode: planeGrid })
      const cache = installSurfaceGridCache(terrain, opts)
      answer = coverage(4)
      const parent = cache.lock(2, 2, 4)
      await drain(opts.budget, parent)
      const [w, s, e, n] = tiling(terrain).getTileBounds(9, 9, 6, false)
      const points = [0.1, 0.35, 0.5, 0.8].flatMap((a) => [0.15, 0.5, 0.9].map((b) => [s + (n - s) * a, w + (e - w) * b]))
      // the parent's read (no z6 grid yet), then the child's
      const fromParent = points.map(([lat, lon]) => terrain.sampleCartographicElevation(lat, lon)!)
      const child = cache.lock(9, 9, 6)
      await drain(opts.budget, child)
      const grid = (await child) as DataTexture
      expect([grid.image.width, grid.image.height]).toEqual([6, 6])
      const fromChild = points.map(([lat, lon]) => terrain.sampleCartographicElevation(lat, lon)!)
      for (let k = 0; k < points.length; k++) expect(fromChild[k]).toBeCloseTo(fromParent[k], 3)
      expect(new Set(fromChild).size).toBeGreaterThan(1)
      expect(fetches).toEqual(['https://tiles.example/4/2/2.webp', 'https://tiles.example/6/9/9.webp'])
      expect(cache.flatTiles).toBe(0)
      expect(cache.cappedTiles).toBe(1)
      expect([...cache.coverageEnd]).toEqual([['6/9/9', 4]])
      expect(cache.coverageLevel(9, 9, 6)).toBe(4)
      expect(cache.coverageLevel(36, 37, 8)).toBe(4) // under it
      expect(cache.coverageLevel(2, 2, 4)).toBe(-1) // data of its own
      // the parent lent its grid and was given it back
      cache.release(2, 2, 4)
      await Promise.resolve()
      expect(cache.get(2, 2, 4)).toBeNull()
    })

    it('draws a tile under a coverage end from the same data grid, asking nothing', async () => {
      const { terrain } = await loadedPlugin()
      const opts = options({ decode: planeGrid })
      const cache = installSurfaceGridCache(terrain, opts)
      answer = coverage(4)
      const parent = cache.lock(2, 2, 4)
      await drain(opts.budget, parent)
      const child = cache.lock(9, 9, 6)
      await drain(opts.budget, child)
      const [w, s, e, n] = tiling(terrain).getTileBounds(37, 38, 8, false)
      const at = [(s + n) / 2 + (n - s) * 0.2, (w + e) / 2 - (e - w) * 0.3]
      const fromChild = terrain.sampleCartographicElevation(at[0], at[1])!
      const grandchild = cache.lock(37, 38, 8)
      await drain(opts.budget, grandchild)
      expect(terrain.sampleCartographicElevation(at[0], at[1])).toBeCloseTo(fromChild, 3)
      expect(fetches).toHaveLength(2)
      expect(cache.cappedTiles).toBe(2)
      expect(cache.coverageEnd.size).toBe(1) // only answers are recorded
    })

    it('fetches the data grid above when no tile holds it, and lets it go after', async () => {
      const { terrain } = await loadedPlugin()
      const opts = options({ decode: planeGrid })
      const cache = installSurfaceGridCache(terrain, opts)
      answer = coverage(4)
      const child = cache.lock(9, 9, 6)
      await drain(opts.budget, child)
      expect(fetches).toEqual(['https://tiles.example/6/9/9.webp', 'https://tiles.example/4/2/2.webp'])
      expect(cache.cappedTiles).toBe(1)
      await Promise.resolve()
      expect(cache.get(2, 2, 4)).toBeNull()
      expect(cache.count).toBe(1)
    })

    it('keeps a 404 flat where the data above holds no ground over the sea there (a coast)', async () => {
      const { terrain } = await loadedPlugin()
      // land only in the parent's westmost texel column
      const coast = async (): Promise<PaddedGrid> => {
        const data = new Float32Array(36)
        for (let j = 0; j < 6; j++) data[j * 6] = data[j * 6 + 1] = 300
        return { data, width: 6, height: 6 }
      }
      const opts = options({ decode: coast })
      const cache = installSurfaceGridCache(terrain, opts)
      answer = coverage(4)
      const sea = cache.lock(11, 9, 6) // the parent's east quarter
      await drain(opts.budget, sea)
      expect(((await sea) as DataTexture).image.data.every((v: number) => v === 0)).toBe(true)
      expect(cache.flatTiles).toBe(1)
      expect(cache.coverageEnd.size).toBe(0)
      // and its subtree is open water, asked for and resampled no more
      const under = cache.lock(44, 37, 8)
      await drain(opts.budget, under)
      expect(fetches).toHaveLength(2)
      expect(cache.flatTiles).toBe(2)
      const land = cache.lock(8, 9, 6) // the west quarter, over the land
      await drain(opts.budget, land)
      expect(cache.cappedTiles).toBe(1)
      expect(cache.coverageLevel(8, 9, 6)).toBe(4)
    })

    it('lets the data grid go when aborted while waiting for a turn', async () => {
      const { terrain } = await loadedPlugin()
      const opts = options({ decode: planeGrid })
      const cache = installSurfaceGridCache(terrain, opts)
      answer = coverage(4)
      const parent = cache.lock(2, 2, 4)
      await drain(opts.budget, parent)
      const abort = new AbortController()
      const child = cache.fetchItem([9, 9, 6], abort.signal)
      await vi.waitFor(() => expect(opts.budget.pending).toBe(1))
      abort.abort(new DOMException('gone', 'AbortError'))
      await expect(child).rejects.toMatchObject({ name: 'AbortError' })
      cache.release(2, 2, 4)
      await Promise.resolve()
      expect(cache.get(2, 2, 4)).toBeNull()
      expect(cache.count).toBe(0)
    })
  })

  it.each([
    ['linear', LinearFilter],
    ['nearest', NearestFilter],
  ] as const)('decodes a 200 with the injected decoder, %s-filtered, uploaded and stitched', async (filter, three) => {
    const { terrain } = await loadedPlugin()
    const decoded: ArrayBuffer[] = []
    const upload = vi.fn()
    let n = 0
    const opts = options({
      filter,
      upload,
      decode: async (buffer): Promise<PaddedGrid> => {
        decoded.push(buffer)
        n++
        return { data: new Float32Array(36).fill(n * 100), width: 6, height: 6 }
      },
    })
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 })
    const a = cache.lock(2, 2, 4)
    await release(opts.budget)
    const left = (await a) as DataTexture
    const b = cache.lock(3, 2, 4)
    await release(opts.budget)
    const right = (await b) as DataTexture
    expect(decoded.map((buf) => Array.from(new Uint8Array(buf)))).toEqual([
      [9, 8, 7],
      [9, 8, 7],
    ])
    for (const grid of [left, right]) {
      expect([grid.minFilter, grid.magFilter]).toEqual([three, three])
      expect([grid.format, grid.type]).toEqual([RedFormat, FloatType])
    }
    expect(upload.mock.calls.map((c) => c[0])).toEqual([left, right])
    // the library's stitch: left's east border holds right's west edge, and back
    const at = (g: DataTexture, x: number, y: number) => (g.image.data as unknown as Float32Array)[y * 6 + x]
    expect(at(left, 5, 2)).toBe(200)
    expect(at(right, 0, 2)).toBe(100)
    expect(cache.flatTiles).toBe(0)
  })

  it('fails a tile on any other bad status, cancelling the body', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options())
    const res = new Response('no', { status: 403 })
    const cancel = vi.spyOn(res.body!, 'cancel')
    answer = async () => res
    await expect(cache.lock(1, 1, 2)).rejects.toThrow(/2\/1\/1 answered 403/)
    expect(cancel).toHaveBeenCalled()
    expect(fetches).toHaveLength(1) // not transient: no retry
  })

  it('ends in an AbortError when aborted while downloading or waiting for a turn', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = (_url, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
    const downloading = new AbortController()
    const a = cache.fetchItem([1, 1, 2], downloading.signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    downloading.abort(new DOMException('gone', 'AbortError'))
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })

    answer = async () => new Response(null, { status: 404 })
    const waiting = new AbortController()
    const b = cache.fetchItem([1, 1, 1], waiting.signal)
    await vi.waitFor(() => expect(opts.budget.pending).toBe(1))
    waiting.abort(new DOMException('gone', 'AbortError'))
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    expect(opts.budget.pending).toBe(0)
  })

  it('disposes a finished grid the cache drops unread', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(null, { status: 404 })
    const signal = new AbortController()
    const pending = cache.fetchItem([1, 1, 1], signal.signal)
    await release(opts.budget)
    const grid = await pending
    const dispose = vi.spyOn(grid, 'dispose')
    signal.abort()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('retries a network error or 5xx, then takes the answer', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    let n = 0
    answer = async () => {
      n++
      if (n === 1) throw new TypeError('Failed to fetch')
      if (n === 2) return new Response('busy', { status: 503 })
      return new Response(null, { status: 404 })
    }
    const pending = cache.lock(1, 1, 1)
    await release(opts.budget)
    await pending
    expect(fetches).toHaveLength(3)
    expect(cache.flatTiles).toBe(1)

    fetches.length = 0
    answer = async () => new Response('busy', { status: 503 })
    await expect(cache.lock(1, 1, 2)).rejects.toThrow(/answered 503/)
    expect(fetches).toHaveLength(3)
  })

  it('stops retrying at an abort', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options({ retryDelays: [60000] }))
    answer = async () => {
      throw new TypeError('Failed to fetch')
    }
    const abort = new AbortController()
    const pending = cache.fetchItem([1, 1, 2], abort.signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetches).toHaveLength(1)
  })

  it('forgets a grid that failed for good, so the next lock fetches it again', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response('no', { status: 403 })
    const first = cache.lock(1, 1, 1)
    const again = cache.lock(1, 1, 1) // a second tile reading the same grid
    await expect(first).rejects.toThrow(/answered 403/)
    await expect(again).rejects.toThrow(/answered 403/)
    await vi.waitFor(() => expect(cache.get(1, 1, 1)).toBeNull())
    expect(cache.count).toBe(0)
    answer = async () => new Response(null, { status: 404 })
    const retry = cache.lock(1, 1, 1)
    await release(opts.budget)
    await retry
    expect(fetches).toHaveLength(2)
    expect(cache.count).toBe(1)
  })

  it('keeps an aborted grid entry (the cache removed it itself)', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options())
    answer = (_url, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
    const pending = cache.lock(1, 1, 2)
    cache.release(1, 1, 2)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cache.count).toBe(0)
  })

  it('stops fetches, retries and turns in flight on shutDown', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options({ retryDelays: [60000] })
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => {
      throw new TypeError('Failed to fetch')
    }
    const retrying = cache.fetchItem([1, 1, 2], new AbortController().signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    answer = async () => new Response(null, { status: 404 })
    const waiting = cache.fetchItem([1, 1, 1], new AbortController().signal)
    await vi.waitFor(() => expect(opts.budget.pending).toBe(1))
    cache.shutDown()
    await expect(retrying).rejects.toMatchObject({ name: 'AbortError' })
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(cache.fetchItem([3, 3, 2], new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetches).toHaveLength(2)
  })

  it('refuses a plugin that is not the 0.5.3 Terrarium one', () => {
    expect(() => installSurfaceGridCache({ name: 'X' } as unknown as TerrariumMeshPlugin, options())).toThrow()
    expect(new SurfaceGridCache({ name: 'TERRARIUM_MESH_PLUGIN', _gridCache: null, _source: null, tileDimension: 4 }, options()))
      .toBeInstanceOf(GridCache)
  })
})

interface TestTile {
  internal?: { loadingState: number }
  children: TestTile[]
  engineData?: { scene: unknown }
}

interface TilesInternals {
  rootTileset: { root: TestTile } | null
  rootLoadingState: number
  stats: { failed: number; loaded: number; inCache: number }
  lruCache: { has(tile: unknown): boolean }
  ensureChildrenArePreprocessed(tile: TestTile, forceImmediate: boolean): void
  requestTileContents(tile: TestTile): unknown
}

describe('retryFailedTiles (tides-zmw.9.20)', () => {
  const FAILED = -1
  const UNLOADED = 0
  const LOADED = 4
  let answer: () => Promise<Response>

  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    vi.stubGlobal('fetch', () => answer())
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The plugin's tree as a first traversal leaves it: root, its z0 tile preprocessed, the z0's children not. */
  async function failedTile() {
    const { terrain, tiles } = await loadedPlugin()
    const opts = options()
    installSurfaceGridCache(terrain, opts)
    const t = tiles as unknown as TilesInternals
    t.rootTileset = (terrain as unknown as { getTileset(): { root: TestTile } }).getTileset()
    t.rootLoadingState = LOADED
    t.ensureChildrenArePreprocessed(t.rootTileset.root, true)
    const tile = t.rootTileset.root.children[0]
    expect(tile.internal).toBeDefined()
    expect(tile.children.length).toBeGreaterThan(0)
    expect(tile.children.every((child) => child.internal === undefined)).toBe(true)
    // The real load, through the queues and the plugin's parse, failing on a 503.
    answer = async () => new Response('down', { status: 503 })
    t.requestTileContents(tile)
    await vi.waitFor(() => expect(tile.internal!.loadingState).toBe(FAILED))
    expect(t.stats.failed).toBe(1)
    expect(t.lruCache.has(tile)).toBe(true)
    return { tiles, t, tile, opts }
  }

  it("throws in the library's reset on this tree (the bug), and the reset tile can't be requested again", async () => {
    const { tiles, t, tile } = await failedTile()
    expect(() => tiles.resetFailedTiles()).toThrow(TypeError)
    // even where it gets through: UNLOADED but still cached, so a request is refused
    tile.internal!.loadingState = UNLOADED
    t.requestTileContents(tile)
    expect(tile.internal!.loadingState).toBe(UNLOADED)
  })

  it('evicts each failed tile, so the next request loads it once the network is back', async () => {
    const { tiles, t, tile, opts } = await failedTile()
    const inCache = t.stats.inCache
    expect(retryFailedTiles(tiles)).toBe(1)
    expect(tile.internal!.loadingState).toBe(UNLOADED)
    expect(t.lruCache.has(tile)).toBe(false)
    expect(t.stats.failed).toBe(0)
    expect(t.stats.inCache).toBe(inCache - 1)
    // nothing left to do
    expect(retryFailedTiles(tiles)).toBe(0)
    // the network back (an ocean 404: a flat grid), the traversal's next request
    answer = async () => new Response(null, { status: 404 })
    t.requestTileContents(tile)
    await release(opts.budget)
    await vi.waitFor(() => expect(tile.internal!.loadingState).toBe(LOADED))
    expect(tile.engineData!.scene).toBeTruthy()
    expect(t.stats.loaded).toBe(1)
  })

  it('resets a failed root, skips cached entries without internal, and does nothing while none failed', () => {
    const remove = vi.fn(() => true)
    const failed = { internal: { loadingState: FAILED } }
    const tiles = {
      rootLoadingState: FAILED,
      stats: { failed: 0 },
      lruCache: { itemList: [{}, { internal: { loadingState: LOADED } }, failed], remove },
    }
    expect(retryFailedTiles(tiles as unknown as TilesRenderer)).toBe(0)
    expect(tiles.rootLoadingState).toBe(UNLOADED)
    expect(remove).not.toHaveBeenCalled()
    tiles.stats.failed = 3 // counted, then evicted by the cache before the retry
    expect(retryFailedTiles(tiles as unknown as TilesRenderer)).toBe(1)
    expect(remove.mock.calls).toEqual([[failed]])
    expect(tiles.stats.failed).toBe(0)
  })
})

/** Tiles that fail again as soon as they're retried: remove() logs when, and the caller counts them failed again. */
function failingTiles(count: number) {
  const FAILED = -1
  const items: object[] = Array.from({ length: count }, () => ({ internal: { loadingState: FAILED } }))
  const removed: { tile: object; at: number }[] = []
  const tiles = {
    rootLoadingState: 4,
    stats: { failed: count },
    lruCache: { itemList: items, remove: (tile: object) => removed.push({ tile, at: Date.now() }) },
    group: { userData: {} as Record<string, unknown> },
  }
  return { tiles, items, removed, asTiles: tiles as unknown as TilesRenderer }
}

describe('failed tile backoff (tides-zmw.9.20)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries a tile that keeps failing at once, then 10 s, 20 s, 40 s on, up to 5 min apart', () => {
    const { asTiles, tiles, removed } = failingTiles(1)
    const backoff = new FailedTileBackoff(10_000)
    const retriedAt: number[] = []
    for (let s = 0; s <= 1000; s += 10) {
      const reset = retryFailedTiles(asTiles, backoff, s * 1000)
      if (reset) retriedAt.push(s)
      tiles.stats.failed += reset // failed again
    }
    expect(retriedAt).toEqual([0, 10, 30, 70, 150, 310, 610, 910])
    expect(RETRY_BACKOFF_MAX_MS).toBe(300_000)
    expect(removed).toHaveLength(retriedAt.length)
  })

  it('leaves stats.failed at the tiles still waiting, and starts over for a tile failing long after', () => {
    const { asTiles, tiles, items } = failingTiles(1)
    const backoff = new FailedTileBackoff(10_000)
    expect(retryFailedTiles(asTiles, backoff, 0)).toBe(1)
    tiles.stats.failed = 1 // it failed again
    items.push({ internal: { loadingState: -1 } }) // and a new one failed
    tiles.stats.failed = 2
    expect(retryFailedTiles(asTiles, backoff, 5000)).toBe(1) // only the new one
    expect(tiles.stats.failed).toBe(1)
    // the first tile loaded, then failed again an hour on: due at once, the next 10 s later
    items.length = 1
    tiles.stats.failed = 1
    expect(retryFailedTiles(asTiles, backoff, 3_600_000)).toBe(1)
    tiles.stats.failed = 1
    expect(retryFailedTiles(asTiles, backoff, 3_605_000)).toBe(0)
    expect(retryFailedTiles(asTiles, backoff, 3_610_000)).toBe(1)
  })

  it('retries on its interval by backoff, every tile at once on online, and stops', () => {
    vi.useFakeTimers({ now: 0 })
    const { asTiles, tiles, removed } = failingTiles(1)
    const target = new EventTarget()
    const stop = startFailedTileRetry(asTiles, 10_000, target)
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 10_000) {
        const before = removed.length
        vi.advanceTimersByTime(10_000)
        tiles.stats.failed += removed.length - before // failed again
      }
    }
    run(100_000)
    expect(removed.map((r) => r.at / 1000)).toEqual([10, 20, 40, 80])
    target.dispatchEvent(new Event('online'))
    tiles.stats.failed += 1
    run(40_000)
    // at once, then the schedule from the start
    expect(removed.map((r) => r.at / 1000)).toEqual([10, 20, 40, 80, 100, 110, 130])
    expect(tiles.group.userData.retriedTiles).toBe(7)
    stop()
    target.dispatchEvent(new Event('online'))
    run(600_000)
    expect(removed).toHaveLength(7)
  })

  it('says a throw once and keeps the page clear of it', () => {
    vi.useFakeTimers({ now: 0 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tiles = {
      rootLoadingState: 4,
      stats: {
        get failed(): number {
          throw new TypeError('broken')
        },
      },
    }
    const stop = startFailedTileRetry(tiles as unknown as TilesRenderer, 10_000, null)
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('quietTilesetVersion (tides-zmw.9.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("stops the renderer's 1.1 warning for the plugin's synthetic tileset", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadedPlugin(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/versions at 1.1 or higher/)
    warn.mockClear()
    const { terrain } = await loadedPlugin(true)
    expect(warn).not.toHaveBeenCalled()
    // the tileset the plugin hands back is untouched
    const tileset = (terrain as unknown as { getTileset(): { asset: { version: string } } }).getTileset()
    expect(tileset.asset.version).toBe('1.1')
  })
})

describe('protectOverlayBitmaps (tides-zmw.9.2)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("lets only the overlay's cache close the bitmaps it makes", async () => {
    const realClose = vi.fn()
    class FakeImageBitmap {
      width = 1
      height = 1
      close() {
        realClose()
      }
    }
    vi.stubGlobal('ImageBitmap', FakeImageBitmap)
    vi.stubGlobal('createImageBitmap', async () => new FakeImageBitmap())
    const overlay = new SurfaceImageryOverlay()
    protectOverlayBitmaps(overlay)
    const source = (overlay as unknown as {
      imageSource: { processBufferToTexture(b: ArrayBuffer): Promise<DataTexture>; disposeItem(t: DataTexture): void }
    }).imageSource
    const texture = await source.processBufferToTexture(new ArrayBuffer(4))
    const bitmap = texture.image as unknown as FakeImageBitmap
    expect(bitmap).toBeInstanceOf(FakeImageBitmap)
    // TilesRenderer's dispose of a tile: image.close() on a clone's shared bitmap
    ;(texture.clone().image as unknown as FakeImageBitmap).close()
    expect(realClose).not.toHaveBeenCalled()
    source.disposeItem(texture)
    expect(realClose).toHaveBeenCalledTimes(1)
  })
})

describe('shareGridBytes (tides-zmw.9.2)', () => {
  it("charges a tile half its grid on top of three's whole-grid estimate", () => {
    const tiles = new TilesRenderer()
    shareGridBytes(tiles)
    const grid = new DataTexture(new Float32Array(10 * 10), 10, 10, RedFormat, FloatType)
    const material = new MeshLambertMaterial()
    material.displacementMap = grid.clone()
    material.bumpMap = material.displacementMap
    const scene = new Group().add(new Mesh(new BufferGeometry(), material))
    const getBytesUsed = (tiles as unknown as { getBytesUsed(tile: unknown): number }).getBytesUsed
    // three counts the grid once per scene (400 bytes); the hook takes back half
    expect(getBytesUsed.call(tiles, { engineData: { scene } })).toBeCloseTo(400 / 2, 6)
  })
})
