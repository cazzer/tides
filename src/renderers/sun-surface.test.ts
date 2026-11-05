import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { sunSurface } from './sun-surface'
import { COMPILE_TIMEOUT_MS } from './compile-gate'

// Just what the bake asks of a renderer, recording each draw's target and
// whether three would regenerate its mips after it.
function fakeRenderer({ linked }: { linked: Promise<unknown> }) {
  let target: THREE.WebGLRenderTarget | null = null
  let face = 0
  const renders: { target: THREE.WebGLRenderTarget | null; face: number; mips: boolean }[] = []
  const compiledInto: (THREE.WebGLRenderTarget | null)[] = []
  const renderer = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: false },
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null, nextFace = 0) => {
      target = next
      face = nextFace
    },
    getClearColor: (color: THREE.Color) => color,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    compileAsync: () => {
      compiledInto.push(target)
      return linked
    },
    render: () => {
      renders.push({ target, face, mips: target?.texture.generateMipmaps ?? false })
    },
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, renders, compiledInto }
}

describe('sunSurface', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fills each cube’s mips from its blank faces once, at creation', () => {
    const { renderer, renders } = fakeRenderer({ linked: new Promise(() => {}) })
    const surface = sunSurface(renderer, true)
    expect(renders.map((r) => [r.target?.texture, r.mips])).toEqual([
      [surface.surface, true],
      [surface.corona, true],
      [surface.plasma, true],
    ])
  })

  it('compiles each bake into its own target and bakes nothing until linked', async () => {
    let link!: () => void
    const { renderer, renders, compiledInto } = fakeRenderer({ linked: new Promise<void>((resolve) => (link = resolve)) })
    const surface = sunSurface(renderer, true)
    renders.length = 0
    expect(compiledInto.map((t) => t?.texture)).toEqual([surface.surface, surface.corona, surface.plasma])
    expect(renderer.getRenderTarget()).toBeNull()
    expect(surface.step()).toBe(false)
    expect(renders).toHaveLength(0)
    link()
    await new Promise((resolve) => setTimeout(resolve, 0))
    surface.step()
    expect(renders).toHaveLength(1)
  })

  it('bakes nothing while held', async () => {
    const { renderer, renders } = fakeRenderer({ linked: Promise.resolve() })
    const surface = sunSurface(renderer, true)
    renders.length = 0
    await new Promise((resolve) => setTimeout(resolve, 0))
    const releaseA = surface.hold()
    const releaseB = surface.hold()
    expect(surface.step()).toBe(false)
    releaseA()
    releaseA()
    expect(surface.step()).toBe(false)
    expect(renders).toHaveLength(0)
    releaseB()
    surface.step()
    expect(renders).toHaveLength(1)
  })

  it('bakes 18 faces, regenerating each cube’s mips only after its sixth', async () => {
    const { renderer, renders } = fakeRenderer({ linked: Promise.resolve() })
    const surface = sunSurface(renderer, true)
    renders.length = 0
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(surface.done()).toBe(false)
    let steps = 0
    while (!surface.step()) steps++
    expect(steps).toBe(18)
    expect(surface.done()).toBe(true)
    expect(renders).toHaveLength(18)
    const textures = [surface.surface, surface.corona, surface.plasma]
    renders.forEach((render, i) => {
      expect(render.target?.texture).toBe(textures[Math.floor(i / 6)])
      expect(render.face).toBe(i % 6)
      expect(render.mips).toBe(i % 6 === 5)
    })
    for (const texture of textures) expect(texture.generateMipmaps).toBe(false)
    expect(renderer.getRenderTarget()).toBeNull()
  })

  it('still bakes when linking never reports done', async () => {
    vi.useFakeTimers()
    const { renderer, renders } = fakeRenderer({ linked: new Promise(() => {}) })
    const surface = sunSurface(renderer, true)
    renders.length = 0
    await vi.advanceTimersByTimeAsync(COMPILE_TIMEOUT_MS - 1)
    expect(surface.step()).toBe(false)
    expect(renders).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    surface.step()
    expect(renders).toHaveLength(1)
  })
})
