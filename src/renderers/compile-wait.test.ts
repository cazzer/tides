import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { compileAndWait } from './compile-wait'

// The parts of WebGLRenderer compileAndWait uses: compile() hands back the
// materials it started, each with a program that links when told to, and
// dispose() drops a material's properties as three's onMaterialDispose does.
function fakeRenderer({ parallel = true } = {}) {
  const properties = new WeakMap<object, { currentProgram?: { isReady(): boolean } }>()
  const linkedSet = new Set<THREE.Material>()
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]
  for (const material of materials) material.addEventListener('dispose', () => properties.delete(material))
  const renderer = {
    compile: vi.fn(() => {
      for (const material of materials) properties.set(material, { currentProgram: { isReady: () => linkedSet.has(material) } })
      return new Set(materials)
    }),
    properties: {
      has: (object: object) => properties.has(object),
      get: (object: object) => {
        if (!properties.has(object)) properties.set(object, {})
        return properties.get(object)!
      },
    },
    extensions: { has: (name: string) => parallel && name === 'KHR_parallel_shader_compile' },
  }
  const link = (...which: THREE.Material[]) => which.forEach((material) => linkedSet.add(material))
  return { renderer: renderer as unknown as THREE.WebGLRenderer, compile: renderer.compile, materials, link }
}

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera()

describe('compileAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Settled state, without awaiting a promise that may never settle.
  function track(promise: Promise<void>) {
    const state = { settled: false, error: undefined as unknown }
    promise.then(
      () => (state.settled = true),
      (error: unknown) => {
        state.settled = true
        state.error = error
      }
    )
    return state
  }

  it('compiles against the target scene and resolves once every program has linked', async () => {
    const { renderer, compile, materials, link } = fakeRenderer()
    const state = track(compileAndWait(renderer, scene, camera, scene))
    expect(compile).toHaveBeenCalledWith(scene, camera, scene)
    link(materials[0], materials[1])
    await vi.advanceTimersByTimeAsync(50)
    expect(state.settled).toBe(false)
    link(materials[2])
    await vi.advanceTimersByTimeAsync(10)
    expect(state).toEqual({ settled: true, error: undefined })
  })

  it('resolves at once when every program is already linked', async () => {
    const { renderer, materials, link } = fakeRenderer()
    link(...materials)
    const state = track(compileAndWait(renderer, scene, camera))
    await Promise.resolve()
    expect(state.settled).toBe(true)
  })

  it('counts a material disposed mid-poll as done, without throwing', async () => {
    const { renderer, materials, link } = fakeRenderer()
    const state = track(compileAndWait(renderer, scene, camera))
    await vi.advanceTimersByTimeAsync(10)
    // Disposed while its program is still linking: three's poll then read
    // undefined.isReady() from a timer and never settled.
    materials[1].dispose()
    link(materials[0], materials[2])
    await vi.advanceTimersByTimeAsync(10)
    expect(state).toEqual({ settled: true, error: undefined })
  })

  it('still waits on a material disposed and then given a new, unlinked program', async () => {
    const { renderer, materials, link } = fakeRenderer()
    const state = track(compileAndWait(renderer, scene, camera))
    materials[0].dispose()
    // Drawn again before the next check: three builds it a fresh program.
    let relinked = false
    renderer.properties.get(materials[0]).currentProgram = { isReady: () => relinked }
    link(...materials)
    await vi.advanceTimersByTimeAsync(50)
    expect(state.settled).toBe(false)
    relinked = true
    await vi.advanceTimersByTimeAsync(10)
    expect(state).toEqual({ settled: true, error: undefined })
  })

  it('warns in development when compile() leaves a live material without a program', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renderer, compile, materials } = fakeRenderer()
    compile.mockImplementation(() => {
      renderer.properties.get(materials[0])
      return new Set(materials.slice(0, 1))
    })
    void compileAndWait(renderer, scene, camera)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('counts a material whose properties hold no program as done', async () => {
    const { renderer, materials, link } = fakeRenderer()
    const state = track(compileAndWait(renderer, scene, camera))
    materials[0].dispose()
    // Something read the disposed material's properties back (get() makes an empty entry).
    renderer.properties.get(materials[0])
    link(materials[1], materials[2])
    await vi.advanceTimersByTimeAsync(10)
    expect(state).toEqual({ settled: true, error: undefined })
  })

  it('waits a tick before the first check without the extension', async () => {
    const { renderer, materials, link } = fakeRenderer({ parallel: false })
    link(...materials)
    const state = track(compileAndWait(renderer, scene, camera))
    await Promise.resolve()
    expect(state.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(state.settled).toBe(true)
  })

  it('rejects when a check throws, rather than hanging', async () => {
    const { renderer, materials } = fakeRenderer()
    const state = track(compileAndWait(renderer, scene, camera))
    const failure = new Error('context lost')
    renderer.properties.get(materials[0]).currentProgram = {
      isReady: () => {
        throw failure
      },
    }
    await vi.advanceTimersByTimeAsync(10)
    expect(state).toEqual({ settled: true, error: failure })
  })

  it('throws synchronously when compile does, as compileAsync does', () => {
    const { renderer, compile } = fakeRenderer()
    compile.mockImplementation(() => {
      throw new Error('bad shader')
    })
    expect(() => compileAndWait(renderer, scene, camera)).toThrow('bad shader')
  })
})
