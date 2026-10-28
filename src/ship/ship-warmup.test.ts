import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { coldWork, compileSide, createWarmed, warmDefinesOnce } from './ship-warmup'

function loaded(): THREE.Texture {
  const texture = new THREE.Texture()
  texture.needsUpdate = true
  return texture
}

const byMaterial = (material: THREE.Material) => material

describe('coldWork', () => {
  test('lists each loaded map and each material once', () => {
    const map = loaded()
    const uniformMap = loaded()
    const scene = new THREE.Scene()
    const basic = new THREE.MeshBasicMaterial({ map })
    const shader = new THREE.ShaderMaterial({ uniforms: { uMap: { value: uniformMap }, uGain: { value: 1 } } })
    const a = new THREE.Mesh(undefined, basic)
    const b = new THREE.Mesh(undefined, [shader, basic])
    scene.add(a, b)
    const warmed = createWarmed()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([
      { texture: map },
      { object: a },
      { texture: uniformMap },
      { object: b },
    ])
    expect(coldWork(scene, warmed, byMaterial)).toEqual([])
  })

  test('skips an object marked warmup false, and everything under it (tides-zmw.9.2)', () => {
    const tile = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ map: loaded() }))
    const tiles = new THREE.Group()
    tiles.userData.warmup = false
    tiles.add(new THREE.Group().add(tile))
    const planet = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial())
    const scene = new THREE.Scene().add(tiles, planet)

    expect(coldWork(scene, createWarmed(), byMaterial)).toEqual([{ object: planet }])
  })

  test('lists an object once however many of its materials are cold', () => {
    const mesh = new THREE.Mesh(undefined, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()])
    const scene = new THREE.Scene().add(mesh)

    expect(coldWork(scene, createWarmed(), byMaterial)).toEqual([{ object: mesh }])
  })

  test('warms a material again once it changes, as when its map arrives', () => {
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const warmed = createWarmed()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ object: mesh }])
    const map = loaded()
    material.map = map
    material.needsUpdate = true
    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ texture: map }, { object: mesh }])
    expect(coldWork(scene, warmed, byMaterial)).toEqual([])
  })

  test('waits for a map to load, and skips render targets and hidden objects', () => {
    const pending = new THREE.Texture()
    const target = new THREE.WebGLRenderTarget(4, 4).texture
    target.needsUpdate = true
    const hiddenMap = loaded()
    const scene = new THREE.Scene()
    const shader = new THREE.ShaderMaterial({ uniforms: { uMap: { value: pending }, uTarget: { value: target } } })
    const shown = new THREE.Mesh(undefined, shader)
    const hidden = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ map: hiddenMap }))
    hidden.visible = false
    scene.add(shown, hidden)
    const warmed = createWarmed()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ object: shown }])
    pending.needsUpdate = true
    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ texture: pending }])
  })

  test('warms a material again under a new key, as after a dispose', () => {
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const warmed = createWarmed()
    let record = {}

    expect(coldWork(scene, warmed, () => record)).toEqual([{ object: mesh }])
    expect(coldWork(scene, warmed, () => record)).toEqual([])
    record = {}
    expect(coldWork(scene, warmed, () => record)).toEqual([{ object: mesh }])
  })

  test('warms the faces a material turns to later, once (tides-01v.8.4)', () => {
    const material = new THREE.ShaderMaterial()
    material.userData.warmSides = [THREE.BackSide]
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const camera = new THREE.PerspectiveCamera()
    const warmed = createWarmed()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ object: mesh }, { object: mesh, side: THREE.BackSide }])
    const compiledSides: THREE.Side[] = []
    const renderer = { compile: () => compiledSides.push(material.side) } as unknown as THREE.WebGLRenderer
    const version = material.version
    compileSide(renderer, mesh, THREE.BackSide, camera, scene, warmed, byMaterial)

    expect(compiledSides).toEqual([THREE.BackSide])
    expect(material.side).toBe(THREE.FrontSide)
    // three must pick the front program again on the next draw.
    expect(material.version).toBeGreaterThan(version)
    expect(coldWork(scene, warmed, byMaterial)).toEqual([])
  })

  test('warms the programs a material turns its defines to, on each side (tides-tvr.4.2)', () => {
    const material = new THREE.ShaderMaterial({ defines: { FOG_EASE: '' } })
    material.userData.warmSides = [THREE.BackSide]
    material.userData.warmDefines = ['CLOUD_TYPED']
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const camera = new THREE.PerspectiveCamera()
    const warmed = createWarmed()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([
      { object: mesh },
      { object: mesh, side: THREE.BackSide },
      { object: mesh, defines: ['CLOUD_TYPED'] },
      { object: mesh, side: THREE.BackSide, defines: ['CLOUD_TYPED'] },
    ])
    const compiled: { side: THREE.Side; defines: string[] }[] = []
    const renderer = {
      compile: () => compiled.push({ side: material.side, defines: Object.keys(material.defines).sort() }),
    } as unknown as THREE.WebGLRenderer
    compileSide(renderer, mesh, undefined, camera, scene, warmed, byMaterial, ['CLOUD_TYPED'])
    compileSide(renderer, mesh, THREE.BackSide, camera, scene, warmed, byMaterial, ['CLOUD_TYPED'])
    expect(compiled).toEqual([
      { side: THREE.FrontSide, defines: ['CLOUD_TYPED', 'FOG_EASE'] },
      { side: THREE.BackSide, defines: ['CLOUD_TYPED', 'FOG_EASE'] },
    ])
    // Turned back, for three to pick the program the draw wants again.
    expect(material.defines).toEqual({ FOG_EASE: '' })
    expect(material.side).toBe(THREE.FrontSide)
    // A material already typed warms its untyped program.
    material.defines.CLOUD_TYPED = ''
    compileSide(renderer, mesh, undefined, camera, scene, warmed, byMaterial, ['CLOUD_TYPED'])
    expect(compiled[2].defines).toEqual(['FOG_EASE'])
    expect(material.defines).toEqual({ FOG_EASE: '', CLOUD_TYPED: '' })
    // In the order it had: three keys a program by its defines in order.
    material.defines = { CLOUD_TYPED: '', FOG_EASE: '' }
    compileSide(renderer, mesh, undefined, camera, scene, warmed, byMaterial, ['CLOUD_TYPED'])
    expect(Object.keys(material.defines)).toEqual(['CLOUD_TYPED', 'FOG_EASE'])
  })

  test('warms the programs a material turns its defines to once, for views without the warm-up (tides-tvr.4.5)', () => {
    const material = new THREE.ShaderMaterial({ defines: { CLOUD_FLAT: '', FOG_EASE: '' } })
    material.userData.warmDefines = ['CLOUD_TYPED']
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const camera = new THREE.PerspectiveCamera()
    const compiled: { side: THREE.Side; defines: string[] }[] = []
    const renderer = {
      compile: () => compiled.push({ side: material.side, defines: Object.keys(material.defines) }),
    } as unknown as THREE.WebGLRenderer
    const done = new WeakSet<object>()
    let record = {}

    warmDefinesOnce(renderer, mesh, camera, scene, done, () => record)
    warmDefinesOnce(renderer, mesh, camera, scene, done, () => record)
    expect(compiled).toEqual([{ side: THREE.FrontSide, defines: ['CLOUD_FLAT', 'FOG_EASE', 'CLOUD_TYPED'] }])
    // Turned back, in their order, for the draw to pick its own program.
    expect(Object.keys(material.defines)).toEqual(['CLOUD_FLAT', 'FOG_EASE'])
    expect(material.side).toBe(THREE.FrontSide)
    // Once more under a new record, as after a dispose drops the programs.
    record = {}
    warmDefinesOnce(renderer, mesh, camera, scene, done, () => record)
    expect(compiled).toHaveLength(2)
    // A material with nothing to turn compiles nothing.
    const plain = new THREE.Mesh(undefined, new THREE.ShaderMaterial())
    warmDefinesOnce(renderer, plain, camera, scene.add(plain), done, byMaterial)
    expect(compiled).toHaveLength(2)
  })
})
