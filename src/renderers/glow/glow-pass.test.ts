import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { GLOW_LAYER, glowCompositeRect } from './glow'
import { sourcesBox } from './glow-pass'
import type { GlowSource } from './glowSources'

const view = { width: 390, height: 643 }
const viewport = { left: 0, bottom: 201, ...view }

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, view.width / view.height, 0.1, 1000)
  c.updateProjectionMatrix()
  c.updateMatrixWorld()
  return c
}

// A sphere stand-in on GLOW_LAYER at `at`.
function standIn(at: [number, number, number], radius = 1, mesh: THREE.Object3D = new THREE.Mesh(new THREE.SphereGeometry(radius))) {
  mesh.layers.set(GLOW_LAYER)
  mesh.position.set(...at)
  mesh.updateMatrixWorld()
  return mesh
}

const source = (object: THREE.Object3D, emits = true): GlowSource => ({ object, order: 0, emits })

describe('sourcesBox', () => {
  it('bounds the emitting sources and leaves the occluders out', () => {
    const sun = source(standIn([0, 0, -10]))
    const alone = { ...(sourcesBox([sun], camera(), view) as object) }
    const withOccluder = sourcesBox([source(standIn([6, 4, -10]), false), sun], camera(), view)
    expect(withOccluder).toEqual(alone)
    expect(sourcesBox([source(standIn([6, 4, -10]), false)], camera(), view)).toBeNull()
  })

  it('is the whole View for a camera that is not perspective', () => {
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    expect(sourcesBox([source(standIn([0, 0, -10]))], ortho, view)).toBe('all')
  })

  it('is the whole View for a drawn object no bounding sphere bounds', () => {
    const instanced = new THREE.InstancedMesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial(), 2)
    expect(sourcesBox([source(standIn([0, 0, -10], 1, instanced))], camera(), view)).toBe('all')
    const points = new THREE.Points(new THREE.BufferGeometry())
    expect(sourcesBox([source(standIn([0, 0, -10], 1, points))], camera(), view)).toBe('all')
  })

  it('skips what the glow camera does not draw: groups, other layers, hidden meshes', () => {
    const group = new THREE.Group()
    group.layers.set(GLOW_LAYER)
    const hidden = standIn([0, 0, -10])
    hidden.visible = false
    const offLayer = new THREE.Mesh(new THREE.SphereGeometry(1))
    group.add(hidden, offLayer)
    group.updateMatrixWorld()
    expect(sourcesBox([source(group)], camera(), view)).toBeNull()
  })

  it('gives a box that misses the View, so the pass skips the frame', () => {
    // Far off to the right: past the View and the reach.
    const box = sourcesBox([source(standIn([40, 0, -10]))], camera(), view)
    expect(box).not.toBeNull()
    expect(box).not.toBe('all')
    const out = { left: 0, bottom: 0, width: 0, height: 0 }
    expect(glowCompositeRect(box!, 128, viewport, out)).toBe(false)
  })
})
