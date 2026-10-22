import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { coldWork } from './ship-warmup'

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
    const warmed = new WeakSet<object>()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([
      { texture: map },
      { object: a },
      { texture: uniformMap },
      { object: b },
    ])
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
    const warmed = new WeakSet<object>()

    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ object: shown }])
    pending.needsUpdate = true
    expect(coldWork(scene, warmed, byMaterial)).toEqual([{ texture: pending }])
  })

  test('warms a material again under a new key, as after a dispose', () => {
    const material = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(undefined, material)
    const scene = new THREE.Scene().add(mesh)
    const warmed = new WeakSet<object>()
    let record = {}

    expect(coldWork(scene, warmed, () => record)).toEqual([{ object: mesh }])
    expect(coldWork(scene, warmed, () => record)).toEqual([])
    record = {}
    expect(coldWork(scene, warmed, () => record)).toEqual([{ object: mesh }])
  })
})
