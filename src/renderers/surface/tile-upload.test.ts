import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FrameBudget } from './frame-budget'
import { createTileUploadPlugin, textureBytes } from './tile-upload'

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
  const tiles = { visibleTiles: new Set<unknown>(), frameCount: 7 }
  const plugin = createTileUploadPlugin(budget, (texture) => uploaded.push(texture))
  plugin.init(tiles)
  return { budget, uploaded, tiles, plugin }
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
    const { budget, plugin } = setup()
    const order: string[] = []
    const scene = new THREE.Group().add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshPhongMaterial({ map: new THREE.Texture() })))
    const uploading = createTileUploadPlugin(budget, () => order.push('tile'))
    uploading.init({ visibleTiles: new Set(), frameCount: 7 })
    uploading.processTileModel(scene, loaded(scene))
    budget.run(() => order.push('bake'), undefined, 'bake')
    budget.run(() => order.push('grid'))
    budget.tick()
    expect(order).toEqual(['grid', 'bake', 'tile'])
    expect(plugin.name).toBe('SURFACE_TILE_UPLOAD')
  })

  it('uploads nothing for a tile its draw got to first, one not wanted, or one no longer this load', () => {
    const { budget, uploaded, tiles, plugin } = setup()
    const drawn = tileScene().scene
    const drawnTile = loaded(drawn)
    tiles.visibleTiles.add(drawnTile)
    plugin.processTileModel(drawn, drawnTile)
    const unused = tileScene().scene
    plugin.processTileModel(unused, { ...loaded(unused), traversal: { used: true, lastFrameVisited: 3 } })
    const evicted = tileScene().scene
    const evictedTile = loaded(evicted)
    plugin.processTileModel(evicted, evictedTile)
    // evicted and loaded again: a new model
    evictedTile.engineData.scene = tileScene().scene
    budget.tick()
    expect(uploaded).toEqual([])
    expect(budget.stats.uploadBytes).toBe(0)
  })

  it('counts a texture at its full size', () => {
    expect(textureBytes(new THREE.DataTexture(new Float32Array(514 * 514), 514, 514))).toBe(514 * 514 * 4)
    expect(textureBytes(new THREE.Texture({ width: 256, height: 256 } as unknown as ImageBitmap))).toBe(256 * 256 * 4)
    expect(textureBytes(new THREE.Texture())).toBe(0)
  })
})
