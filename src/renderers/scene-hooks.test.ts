import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { addSceneBeforeRender } from './scene-hooks'

const renderer = {} as THREE.WebGLRenderer
const camera = new THREE.PerspectiveCamera()

// What three does as it starts to draw `scene`.
const draw = (scene: THREE.Scene) => scene.onBeforeRender(renderer, scene, camera, null as never, null as never, null)

describe('addSceneBeforeRender', () => {
  it('calls the callbacks in the order they were added, with the camera drawn for', () => {
    const scene = new THREE.Scene()
    const calls: string[] = []
    const removes = ['a', 'b', 'c'].map((name) =>
      addSceneBeforeRender(scene, (r, c) => {
        expect(r).toBe(renderer)
        expect(c).toBe(camera)
        calls.push(name)
      })
    )
    draw(scene)
    expect(calls).toEqual(['a', 'b', 'c'])
    removes.forEach((remove) => remove())
  })

  it('keeps the others whatever order they are removed in', () => {
    const scene = new THREE.Scene()
    const calls: string[] = []
    const removeA = addSceneBeforeRender(scene, () => calls.push('a'))
    const removeB = addSceneBeforeRender(scene, () => calls.push('b'))
    const removeC = addSceneBeforeRender(scene, () => calls.push('c'))
    // The first added goes first: with hand chaining this put the scene's
    // own callback back over b's and c's.
    removeA()
    draw(scene)
    expect(calls).toEqual(['b', 'c'])
    calls.length = 0
    removeC()
    draw(scene)
    expect(calls).toEqual(['b'])
    // A removal twice is one.
    removeC()
    calls.length = 0
    draw(scene)
    expect(calls).toEqual(['b'])
    removeB()
  })

  it("takes the dispatcher off once the last goes, giving the scene's own back, and puts one on afresh", () => {
    const scene = new THREE.Scene()
    const own = scene.onBeforeRender
    const remove = addSceneBeforeRender(scene, () => {})
    expect(scene.onBeforeRender).not.toBe(own)
    remove()
    expect(scene.onBeforeRender).toBe(own)
    const calls: string[] = []
    const again = addSceneBeforeRender(scene, () => calls.push('again'))
    draw(scene)
    expect(calls).toEqual(['again'])
    again()
    expect(scene.onBeforeRender).toBe(own)
  })

  it('calls through to what the scene had before, and keeps scenes apart', () => {
    const scene = new THREE.Scene()
    const other = new THREE.Scene()
    const calls: string[] = []
    scene.onBeforeRender = () => calls.push('own')
    const remove = addSceneBeforeRender(scene, () => calls.push('added'))
    const removeOther = addSceneBeforeRender(other, () => calls.push('other'))
    draw(scene)
    expect(calls).toEqual(['own', 'added'])
    remove()
    removeOther()
  })
})
