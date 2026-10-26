import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FrameBudget } from './frame-budget'
import { createTileUploadPlugin, textureBytes, trackUploads } from './tile-upload'

function tileScene() {
  const material = new THREE.MeshPhongMaterial()
  material.displacementMap = new THREE.DataTexture(new Float32Array(4), 2, 2)
  material.map = new THREE.Texture({ width: 4, height: 2 } as unknown as ImageBitmap)
  const scene = new THREE.Group()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material))
  return { scene, material }
}

/** A loaded tile as the plugin reads it, used by the renderer's last traversal (frame 7). */
function loaded(scene: THREE.Object3D) {
  return { traversal: { used: true, lastFrameVisited: 7 }, engineData: { scene } }
}

function setup() {
  const budget = new FrameBudget(Infinity)
  const uploaded: THREE.Texture[] = []
  const tracked = trackUploads((texture) => uploaded.push(texture))
  const tiles = { visibleTiles: new Set<unknown>(), frameCount: 7 }
  const plugin = createTileUploadPlugin(budget, tracked)
  plugin.init(tiles)
  return { budget, uploaded, tracked, tiles, plugin }
}

describe('createTileUploadPlugin (tides-zmw.9.25)', () => {
  it("never holds the tile up: queues its elevation clone and imagery for the budget's upload lane", () => {
    const { budget, uploaded, plugin } = setup()
    const { scene, material } = tileScene()
    expect(plugin.processTileModel(scene, loaded(scene))).toBeUndefined()
    expect(uploaded).toEqual([])
    budget.tick()
    expect(uploaded).toEqual([material.displacementMap, material.map])
    expect(budget.stats.uploadBytes).toBe(16 + 4 * 2 * 4)
  })

  it('runs after the grids and bakes queued', () => {
    const budget = new FrameBudget(Infinity)
    const order: string[] = []
    const scene = new THREE.Group().add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshPhongMaterial({ map: new THREE.Texture() })))
    const plugin = createTileUploadPlugin(budget, trackUploads(() => order.push('tile')))
    plugin.init({ visibleTiles: new Set(), frameCount: 7 })
    plugin.processTileModel(scene, loaded(scene))
    budget.run(() => order.push('bake'), undefined, 'bake')
    budget.run(() => order.push('grid'))
    budget.tick()
    expect(order).toEqual(['grid', 'bake', 'tile'])
  })

  it('sends (and counts) only what has changed since it was last sent', () => {
    const { budget, uploaded, tracked, plugin } = setup()
    const { scene, material } = tileScene()
    // the grid uploaded as it was made (its clone shares the data)
    const grid = material.displacementMap!
    tracked.upload(grid)
    uploaded.length = 0
    plugin.processTileModel(scene, loaded(scene))
    budget.tick()
    expect(uploaded).toEqual([material.map])
    expect(budget.stats.uploadBytes).toBe(4 * 2 * 4)
    // stitched since: sent again
    grid.needsUpdate = true
    const again = tileScene().scene
    ;((again.children[0] as THREE.Mesh).material as THREE.MeshPhongMaterial).displacementMap = grid
    plugin.processTileModel(again, loaded(again))
    budget.tick()
    expect(uploaded).toContain(grid)
  })

  it('uploads nothing for a tile its draw got to first, one not wanted, or one no longer this load', () => {
    const { budget, uploaded, tiles, plugin } = setup()
    const drawn = tileScene().scene
    const drawnTile = loaded(drawn)
    tiles.visibleTiles.add(drawnTile)
    plugin.processTileModel(drawn, drawnTile)
    const unused = tileScene().scene
    plugin.processTileModel(unused, { ...loaded(unused), traversal: { used: true, lastFrameVisited: 3 } })
    const replaced = tileScene().scene
    const replacedTile = loaded(replaced)
    plugin.processTileModel(replaced, replacedTile)
    replacedTile.engineData.scene = tileScene().scene
    budget.tick()
    expect(uploaded).toEqual([])
    expect(budget.stats.uploadBytes).toBe(0)
  })

  it("drops an evicted tile's job at once (disposeTile), freeing its place and its model", () => {
    const { budget, uploaded, plugin } = setup()
    const { scene } = tileScene()
    const tile = loaded(scene)
    plugin.processTileModel(scene, tile)
    expect(budget.pending).toBe(1)
    plugin.disposeTile(tile)
    expect(budget.pending).toBe(0)
    // loaded again: only the new load's job
    plugin.processTileModel(scene, tile)
    plugin.processTileModel(scene, tile)
    expect(budget.pending).toBe(1)
    budget.tick()
    expect(uploaded).toHaveLength(2)
  })

  it('counts a texture at its full size', () => {
    expect(textureBytes(new THREE.DataTexture(new Float32Array(514 * 514), 514, 514))).toBe(514 * 514 * 4)
    expect(textureBytes(new THREE.Texture({ width: 256, height: 256 } as unknown as ImageBitmap))).toBe(256 * 256 * 4)
    expect(textureBytes(new THREE.Texture())).toBe(0)
  })
})
