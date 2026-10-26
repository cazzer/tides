import * as THREE from 'three'
// three's own state cache, to check the probe's depth functions reach GL as built.
import { WebGLState as ThreeWebGLState } from 'three/src/renderers/webgl/WebGLState.js'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyDepthProbe,
  createProbeMaterials,
  DEPTH_PROBE_BASE,
  DEPTH_PROBE_COLUMN,
  DEPTH_PROBE_WIDTH,
  describeDepthPrecision,
  inEffect,
  parseDepthInfo,
  probeDepthPrecision,
  type ProbeRenderer,
  reversedFloatDepth,
} from './depth-precision'

/** A probe strip's bottom row where columns k = base..lastPass are red. */
function row(lastPass: number, width = DEPTH_PROBE_WIDTH, extraPasses: number[] = []) {
  const bytes = new Uint8Array(4 * width)
  for (let x = 0; x < width; x++) {
    const k = DEPTH_PROBE_BASE + Math.floor(x / DEPTH_PROBE_COLUMN)
    if (k <= lastPass || extraPasses.includes(k)) bytes[4 * x] = 255
    bytes[4 * x + 3] = 255
  }
  return bytes
}

describe('classifyDepthProbe', () => {
  it('calls a buffer that holds 2^-63 float', () => {
    expect(classifyDepthProbe(row(63), DEPTH_PROBE_WIDTH)).toEqual({ kind: 'float', bits: 32, maxPassK: 63 })
  })

  it('calls passes stopping at 24 or 25, or 23 on a truncating driver, unorm 24', () => {
    for (const k of [23, 24, 25]) {
      expect(classifyDepthProbe(row(k), DEPTH_PROBE_WIDTH)).toEqual({ kind: 'unorm', bits: 24, maxPassK: k })
    }
  })

  it('calls passes stopping at 16 unorm 16', () => {
    expect(classifyDepthProbe(row(16), DEPTH_PROBE_WIDTH)).toEqual({ kind: 'unorm', bits: 16, maxPassK: 16 })
  })

  it('calls no pass, or a pass after a miss, unknown', () => {
    expect(classifyDepthProbe(row(DEPTH_PROBE_BASE - 1), DEPTH_PROBE_WIDTH).kind).toBe('unknown')
    expect(classifyDepthProbe(row(24, DEPTH_PROBE_WIDTH, [40]), DEPTH_PROBE_WIDTH).kind).toBe('unknown')
  })

  it('reads only the columns a narrow strip has', () => {
    // 100 px: columns k = 8..32, all passing, is enough to call float.
    expect(classifyDepthProbe(row(63, 100), 100)).toEqual({ kind: 'float', bits: 32, maxPassK: 32 })
    // 60 px: k = 8..22 all pass, which can't tell unorm 24 from float.
    expect(classifyDepthProbe(row(63, 60), 60)).toEqual({ kind: 'unknown', bits: 0, maxPassK: 22 })
    // ...but a stop inside them still reads.
    expect(classifyDepthProbe(row(16, 60), 60)).toEqual({ kind: 'unorm', bits: 16, maxPassK: 16 })
  })
})

/** A WebGL2 context that records depthFunc calls and answers the rest blandly. */
function recordingGl() {
  const depthFuncs: number[] = []
  const constants: Record<string, number> = {
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203,
    GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
  }
  let next = 0x9000
  const gl: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(target: Record<string | symbol, unknown>, name) {
        if (name in target) return target[name]
        if (typeof name === 'string' && /^[A-Z0-9_]+$/.test(name)) {
          target[name] = constants[name] ?? next++
          return target[name]
        }
        if (name === 'depthFunc') return (f: number) => depthFuncs.push(f)
        if (name === 'getParameter') {
          return (p: number) =>
            p === gl.VERSION ? 'WebGL 2.0' : p === gl.SCISSOR_BOX || p === gl.VIEWPORT ? [0, 0, 1, 1] : 16
        }
        return () => ({})
      },
    },
  )
  const clipControl = { LOWER_LEFT_EXT: 1, ZERO_TO_ONE_EXT: 2, NEGATIVE_ONE_TO_ONE_EXT: 3, clipControlEXT: vi.fn() }
  const extensions = { get: () => clipControl, has: () => true }
  return { gl, extensions, depthFuncs, constants }
}

// @types/three lags r180's state (setReversed, setMaterial's optional args).
type DepthState = {
  buffers: { depth: { setReversed(reversed: boolean): void } }
  setMaterial(material: THREE.Material): void
}
const WebGLState = ThreeWebGLState as unknown as new (gl: unknown, extensions: unknown) => DepthState

describe('inEffect', () => {
  for (const reversed of [false, true]) {
    it(`makes three test ALWAYS then GREATER (${reversed ? 'reversed' : 'standard'} depth)`, () => {
      const { gl, extensions, depthFuncs, constants } = recordingGl()
      const state = new WebGLState(gl, extensions)
      state.buffers.depth.setReversed(reversed)
      const { floor, step } = createProbeMaterials(reversed)
      state.setMaterial(floor)
      state.setMaterial(step)
      expect(depthFuncs.slice(-2)).toEqual([constants.ALWAYS, constants.GREATER])
    })
  }

  it('passes functions through on standard depth', () => {
    expect(inEffect(THREE.GreaterDepth, false)).toBe(THREE.GreaterDepth)
    expect(inEffect(THREE.GreaterDepth, true)).toBe(THREE.LessDepth)
    expect(inEffect(THREE.AlwaysDepth, true)).toBe(THREE.NeverDepth)
  })
})

/** A renderer that keeps the state the probe must restore, and records the rest. */
function fakeRenderer({ reversed = true, pixels = row(63), ratio = 2 } = {}) {
  const viewport = new THREE.Vector4(0, 0, 400, 300)
  const scissor = new THREE.Vector4(10, 20, 30, 40)
  const outer = new THREE.WebGLRenderTarget(8, 8)
  const calls: string[] = []
  const materials: THREE.Material[] = []
  const geometries: THREE.BufferGeometry[] = []
  const context = {
    RGBA: 1,
    UNSIGNED_BYTE: 2,
    clearDepth: vi.fn(),
    readPixels: vi.fn((x: number, y: number, w: number, h: number, f: number, t: number, out: Uint8Array) => {
      calls.push(`readPixels ${w}x${h}`)
      out.set(pixels.subarray(0, out.length))
    }),
  }
  let target: THREE.WebGLRenderTarget | null = outer
  let scissorTest = true
  const renderer = {
    autoClear: true,
    state: { buffers: { depth: { getReversed: () => reversed, setClear: vi.fn() } } },
    getContext: () => context,
    getPixelRatio: () => ratio,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600),
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t
      calls.push(`target ${t === outer ? 'outer' : t ? 'probe' : 'null'}`)
    },
    getViewport: (v: THREE.Vector4) => v.copy(viewport),
    setViewport: (x: number | THREE.Vector4, y?: number, w?: number, h?: number) => {
      if (typeof x === 'number') viewport.set(x, y!, w!, h!)
      else viewport.copy(x)
    },
    getScissor: (v: THREE.Vector4) => v.copy(scissor),
    setScissor: (x: number | THREE.Vector4, y?: number, w?: number, h?: number) => {
      if (typeof x === 'number') scissor.set(x, y!, w!, h!)
      else scissor.copy(x)
    },
    getScissorTest: () => scissorTest,
    setScissorTest: (on: boolean) => {
      scissorTest = on
    },
    render: (scene: THREE.Scene) => {
      calls.push(`render autoClear=${renderer.autoClear} viewport=${viewport.toArray()}`)
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          materials.push(o.material)
          geometries.push(o.geometry)
        }
      })
    },
    clear: (c: boolean, d: boolean, s: boolean) => calls.push(`clear ${c} ${d} ${s} scissor=${scissor.toArray()}`),
    readRenderTargetPixels: vi.fn((t: unknown, x: number, y: number, w: number, h: number, out: Uint8Array) => {
      calls.push(`readRenderTargetPixels ${w}x${h}`)
      out.set(pixels.subarray(0, out.length))
    }),
  }
  return { renderer, context, calls, materials, geometries, outer, viewport, scissor, getScissorTest: () => scissorTest }
}

describe('probeDepthPrecision', () => {
  it('draws the strip on the default framebuffer, reads it, wipes it and restores state', () => {
    const fake = fakeRenderer()
    const dispose = vi.spyOn(THREE.Material.prototype, 'dispose')
    const disposeGeometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const result = probeDepthPrecision(fake.renderer as unknown as ProbeRenderer)

    expect(result).toMatchObject({ kind: 'float', bits: 32, maxPassK: 63 })
    expect(result.ms).toBeGreaterThanOrEqual(0)
    // 224 device px at pixel ratio 2 is a 112 x 2 CSS-px viewport.
    expect(fake.calls).toEqual([
      'target null',
      'render autoClear=false viewport=0,0,112,2',
      `readPixels ${DEPTH_PROBE_WIDTH}x1`,
      'clear true true true scissor=0,0,112,2',
      'target outer',
    ])
    expect(fake.viewport.toArray()).toEqual([0, 0, 400, 300])
    expect(fake.scissor.toArray()).toEqual([10, 20, 30, 40])
    expect(fake.getScissorTest()).toBe(true)
    expect(fake.renderer.autoClear).toBe(true)
    // The depth clear value is three's to keep (its reversed-Z cache).
    expect(fake.renderer.state.buffers.depth.setClear).not.toHaveBeenCalled()
    expect(fake.context.clearDepth).not.toHaveBeenCalled()
    for (const m of fake.materials) expect(dispose.mock.contexts).toContain(m)
    for (const g of new Set(fake.geometries)) expect(disposeGeometry.mock.contexts).toContain(g)
    dispose.mockRestore()
    disposeGeometry.mockRestore()
  })

  it('reads a render target through three and leaves the screen alone', () => {
    const fake = fakeRenderer({ pixels: row(16) })
    const target = new THREE.WebGLRenderTarget(DEPTH_PROBE_WIDTH, 4)
    const result = probeDepthPrecision(fake.renderer as unknown as ProbeRenderer, target)
    expect(result).toMatchObject({ kind: 'unorm', bits: 16, maxPassK: 16 })
    expect(fake.calls).toEqual([
      'target probe',
      'render autoClear=false viewport=0,0,400,300',
      `readRenderTargetPixels ${DEPTH_PROBE_WIDTH}x1`,
      'target outer',
    ])
  })

  it('restores state when the draw throws', () => {
    const fake = fakeRenderer()
    fake.renderer.render = () => {
      throw new Error('lost')
    }
    expect(() => probeDepthPrecision(fake.renderer as unknown as ProbeRenderer)).toThrow('lost')
    expect(fake.renderer.autoClear).toBe(true)
    expect(fake.viewport.toArray()).toEqual([0, 0, 400, 300])
    expect(fake.renderer.getRenderTarget()).toBe(fake.outer)
  })
})

describe('reversedFloatDepth', () => {
  const precision = (kind: 'float' | 'unorm' | 'unknown') => ({ kind, bits: 0, maxPassK: 0, ms: 0 })
  const gl = (reversedDepthBuffer: boolean) => ({ capabilities: { reversedDepthBuffer } })
  it('needs reversed-Z and a float buffer', () => {
    expect(reversedFloatDepth(gl(true), null)).toBe(false)
    expect(reversedFloatDepth(gl(true), precision('float'))).toBe(true)
    expect(reversedFloatDepth(gl(true), precision('unorm'))).toBe(false)
    expect(reversedFloatDepth(gl(true), precision('unknown'))).toBe(false)
    expect(reversedFloatDepth(gl(false), precision('float'))).toBe(false)
  })
})

describe('describeDepthPrecision', () => {
  it('names the verdict for the log', () => {
    expect(describeDepthPrecision(null)).toBe('not probed')
    expect(describeDepthPrecision({ kind: 'float', bits: 32, maxPassK: 63, ms: 1 })).toBe('float (k>=63)')
    expect(describeDepthPrecision({ kind: 'unorm', bits: 24, maxPassK: 24, ms: 1 })).toBe('unorm 24 (k=24)')
  })
})

describe('parseDepthInfo', () => {
  it('turns on only for ?depth=info', () => {
    expect(parseDepthInfo('?depth=info')).toBe(true)
    expect(parseDepthInfo('?ship=1&depth=info')).toBe(true)
    for (const s of ['', '?depth=1', '?depth=INFO', '?depth', '?info=depth']) expect(parseDepthInfo(s)).toBe(false)
  })
})
