import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FrameBudget } from './frame-budget'
import { createTileUploadPlugin } from './tile-upload'

function tileScene() {
  const material = new THREE.MeshPhongMaterial()
  material.displacementMap = new THREE.DataTexture(new Float32Array(4), 2, 2)
  material.map = new THREE.Texture()
  const scene = new THREE.Group()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material))
  return { scene, material }
}

describe('createTileUploadPlugin (tides-zmw.9.25)', () => {
  it("uploads a tile's elevation clone and imagery in a budget turn, not before", async () => {
    const budget = new FrameBudget(Infinity)
    const uploaded: THREE.Texture[] = []
    const plugin = createTileUploadPlugin(budget, (texture) => uploaded.push(texture))
    const { scene, material } = tileScene()
    let done = false
    const processed = plugin.processTileModel(scene, { internal: { loadingState: 3 } }).then(() => (done = true))
    await Promise.resolve()
    expect(uploaded).toEqual([])
    expect(done).toBe(false)
    budget.tick()
    await processed
    expect(uploaded).toEqual([material.displacementMap, material.map])
  })

  it('waits in the grids lane, behind grids already queued and ahead of bakes', async () => {
    const budget = new FrameBudget(Infinity)
    const order: string[] = []
    const plugin = createTileUploadPlugin(budget, () => order.push('tile'))
    budget.run(() => order.push('bake'), undefined, 'bake')
    budget.run(() => order.push('grid'))
    const processed = plugin.processTileModel(new THREE.Group().add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshPhongMaterial({ map: new THREE.Texture() }))), {})
    budget.tick()
    await processed
    expect(order).toEqual(['grid', 'tile', 'bake'])
  })

  it('uploads nothing for a tile evicted while it waited', async () => {
    const budget = new FrameBudget(Infinity)
    const uploaded: THREE.Texture[] = []
    const plugin = createTileUploadPlugin(budget, (texture) => uploaded.push(texture))
    const tile = { internal: { loadingState: 3 } }
    const processed = plugin.processTileModel(tileScene().scene, tile)
    tile.internal.loadingState = 0
    budget.tick()
    await processed
    expect(uploaded).toEqual([])
  })
})
