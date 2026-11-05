import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { auroraCurtain, CURTAIN_ROWS, CURTAIN_WIDTH } from './auroraCurtain'

// A renderer that records what it draws and where.
function mockRenderer(extensions = ['EXT_color_buffer_float']) {
  let bound: THREE.WebGLRenderTarget | null = null
  const draws: (THREE.WebGLRenderTarget | null)[] = []
  const domElement = new EventTarget()
  const gl = {
    domElement,
    extensions: { has: (name: string) => extensions.includes(name) },
    getRenderTarget: () => bound,
    setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) => {
      bound = t
    }),
    render: vi.fn(() => {
      draws.push(bound)
    }),
  } as unknown as THREE.WebGLRenderer
  return { gl, draws, domElement, bind: (t: THREE.WebGLRenderTarget | null) => (bound = t), bound: () => bound }
}

describe('auroraCurtain', () => {
  it('bakes once per distinct time, however many Views ask', () => {
    const { gl, draws } = mockRenderer()
    const main = auroraCurtain(gl)!
    const moon = auroraCurtain(gl)!
    expect(moon).toBe(main)
    main.bake(1.5)
    moon.bake(1.5)
    expect(draws).toHaveLength(1)
    moon.bake(1.6)
    main.bake(1.6)
    expect(draws).toHaveLength(2)
  })

  it('draws into its own target and puts the previous one back', () => {
    const { gl, draws, bind, bound } = mockRenderer()
    const curtain = auroraCurtain(gl)!
    const previous = new THREE.WebGLRenderTarget(4, 4)
    bind(previous)
    curtain.bake(2)
    expect(draws[0]?.texture).toBe(curtain.texture)
    expect(bound()).toBe(previous)
  })

  it('bakes again after the context is lost', () => {
    const { gl, draws, domElement } = mockRenderer()
    const curtain = auroraCurtain(gl)!
    curtain.bake(3)
    curtain.bake(3)
    expect(draws).toHaveLength(1)
    domElement.dispatchEvent(new Event('webglcontextlost'))
    curtain.bake(3)
    expect(draws).toHaveLength(2)
  })

  it('is null without a float colour buffer', () => {
    expect(auroraCurtain(mockRenderer([]).gl)).toBeNull()
    expect(auroraCurtain(mockRenderer(['EXT_color_buffer_half_float']).gl)).not.toBeNull()
  })

  it('is a linear half-float table that wraps around the pole', () => {
    const { gl, draws } = mockRenderer()
    auroraCurtain(gl)!.bake(0)
    const target = draws[0]!
    expect([target.width, target.height]).toEqual([CURTAIN_WIDTH, 2 * CURTAIN_ROWS])
    const t = target.texture
    expect(t.type).toBe(THREE.HalfFloatType)
    expect(t.format).toBe(THREE.RGBAFormat)
    expect([t.minFilter, t.magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter])
    expect(t.generateMipmaps).toBe(false)
    expect([t.wrapS, t.wrapT]).toEqual([THREE.RepeatWrapping, THREE.ClampToEdgeWrapping])
    expect(target.depthBuffer).toBe(false)
  })
})
