import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findNonFinite, logContextLoss, watchForNonFinite } from './render-diagnostics'

function world() {
  const scene = new THREE.Scene()
  const sun = new THREE.Group()
  sun.name = 'sun'
  const mesh = new THREE.Mesh()
  sun.add(mesh)
  scene.add(sun)
  const camera = new THREE.PerspectiveCamera()
  return { scene, sun, mesh, camera }
}

afterEach(() => vi.restoreAllMocks())

describe('findNonFinite', () => {
  it('passes a finite scene', () => {
    const { scene, camera } = world()
    expect(findNonFinite(scene, camera)).toBeNull()
  })

  it('names the camera first', () => {
    const { scene, mesh, camera } = world()
    mesh.position.x = NaN
    camera.position.y = Infinity
    expect(findNonFinite(scene, camera)).toMatch(/^camera position/)
    camera.position.y = 0
    camera.quaternion.w = NaN
    expect(findNonFinite(scene, camera)).toMatch(/^camera quaternion/)
  })

  it('names a nested offender by its path', () => {
    const { scene, mesh, camera } = world()
    mesh.position.z = -Infinity
    expect(findNonFinite(scene, camera)).toBe('Scene > Group sun > Mesh position 0,0,-Infinity')
  })
})

describe('watchForNonFinite', () => {
  it('reports the first offender once, checks each scene once a frame, and uninstalls', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const draw = vi.fn()
    const gl = { render: draw } as unknown as THREE.WebGLRenderer
    let frame = 0
    const uninstall = watchForNonFinite(gl, () => frame)
    const { scene, sun, camera } = world()

    // The Sun's CubeCamera draws the same scene six more times a frame; only
    // the first draw of each frame is checked.
    gl.render(scene, camera)
    sun.position.y = NaN
    gl.render(scene, camera)
    expect(error).not.toHaveBeenCalled()
    expect(draw).toHaveBeenCalledTimes(2)

    frame++
    gl.render(scene, camera)
    frame++
    gl.render(scene, camera)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toMatch(/non-finite Scene > Group sun position/)
    expect(error.mock.calls[0][1]).toBeInstanceOf(Error)
    expect(draw).toHaveBeenCalledTimes(4)

    uninstall()
    expect(gl.render).toBe(draw)
  })
})

describe('logContextLoss', () => {
  it('logs loss and restoration until uninstalled', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const canvas = new EventTarget() as HTMLCanvasElement
    const uninstall = logContextLoss(canvas)
    canvas.dispatchEvent(new Event('webglcontextlost'))
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(error).toHaveBeenCalledWith('[render] WebGL context lost', '')
    expect(warn).toHaveBeenCalledWith('[render] WebGL context restored')
    uninstall()
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(error).toHaveBeenCalledTimes(1)
  })
})
