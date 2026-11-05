import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { shownOnly } from './compile-view'

function mesh(name: string, userData: Record<string, unknown> = {}) {
  const material = new THREE.MeshBasicMaterial()
  material.userData = userData
  const object = new THREE.Mesh(new THREE.BufferGeometry(), material)
  object.name = name
  return object
}

// A scene with the gate's root in it, and a sibling of the root outside it.
function tree() {
  const scene = new THREE.Scene()
  const root = new THREE.Group()
  root.name = 'root'
  const later = mesh('later', { compileLater: true })
  const laterChild = mesh('laterChild')
  later.add(laterChild)
  const hidden = mesh('hidden')
  hidden.visible = false
  hidden.add(mesh('underHidden'))
  const compileHidden = mesh('compileHidden')
  compileHidden.visible = false
  compileHidden.userData.compileHidden = true
  root.add(later, hidden, compileHidden, mesh('shown'))
  scene.add(root, mesh('sibling'))
  return { scene, root }
}

function names(view: THREE.Object3D) {
  const seen: string[] = []
  view.traverse((object) => seen.push(object.name))
  return seen
}

describe('shownOnly', () => {
  it('takes only the gate root and down, shown or compileHidden, leaving out what compiles later but not its children', () => {
    const { root } = tree()
    let deferred = 0
    const view = shownOnly(root, false, () => deferred++)
    expect(names(view)).toEqual(['root', 'laterChild', 'compileHidden', 'shown'])
    expect(deferred).toBe(1)
  })

  it('takes what compiles later too in the last round', () => {
    const { root } = tree()
    let deferred = 0
    expect(names(shownOnly(root, true, () => deferred++))).toEqual(['root', 'later', 'laterChild', 'compileHidden', 'shown'])
    expect(deferred).toBe(0)
  })

  it('adds no lights or visible objects of its own', () => {
    const { root } = tree()
    const seen: THREE.Object3D[] = []
    shownOnly(root).traverseVisible((object) => seen.push(object))
    expect(seen).toEqual([])
  })
})
