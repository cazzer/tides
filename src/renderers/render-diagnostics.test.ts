import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logContextLoss, nonFiniteCamera, nonFiniteObject, watchForNonFinite } from './render-diagnostics'

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

describe('nonFiniteCamera', () => {
  it('passes a finite camera and names a bad position or orientation', () => {
    const { camera } = world()
    expect(nonFiniteCamera(camera)).toBeNull()
    camera.position.y = Infinity
    expect(nonFiniteCamera(camera)).toMatch(/^camera position/)
    camera.position.y = 0
    camera.quaternion.w = NaN
    expect(nonFiniteCamera(camera)).toMatch(/^camera quaternion/)
  })
})

describe('nonFiniteObject', () => {
  it('passes a finite scene', () => {
    expect(nonFiniteObject(world().scene)).toBeNull()
  })

  it('names a nested offender by its path', () => {
    const { scene, mesh } = world()
    mesh.position.z = -Infinity
    expect(nonFiniteObject(scene)).toBe('Scene > Group sun > Mesh position 0,0,-Infinity')
  })
})

describe('watchForNonFinite', () => {
  it('checks each scene once a frame, reports the first offender once, and uninstalls', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const draw = vi.fn()
    const gl = { render: draw } as unknown as THREE.WebGLRenderer
    let frame = 0
    const uninstall = watchForNonFinite(gl, () => frame)
    const { scene, sun, camera } = world()

    // The Sun's CubeCamera draws the same scene six more times a frame; only
    // the first draw of each frame walks the scene.
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

  it('checks the camera on every draw, after the scene was walked with another camera', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const gl = { render: vi.fn() } as unknown as THREE.WebGLRenderer
    watchForNonFinite(gl, () => 0)
    const { scene, camera } = world()
    const cubeFace = new THREE.PerspectiveCamera()

    gl.render(scene, cubeFace)
    camera.quaternion.x = NaN
    gl.render(scene, camera)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toMatch(/non-finite camera quaternion/)
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
