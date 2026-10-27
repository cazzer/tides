import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import depthGlsl from './depth.glsl'
import shellVertex from './shell/vertex.glsl'
import clipDepthGlsl from './clip-depth.glsl'

// depth.glsl's helpers (tides-zmw.9.3), ported in float32 as the GPU runs
// them (the first test pins the lines they copy). P is column-major as GLSL
// and three store it: P[2][2] = m[10], P[3][2] = m[14].
const f = Math.fround
const near = (m: Float32Array, reversed: boolean) =>
  reversed ? f(m[14] / f(m[10] + 1)) : f(m[14] / f(m[10] - 1))
const fragDepth = (m: Float32Array, reversed: boolean, z: number) => {
  const ndc = f(f(m[14] - f(m[10] * z)) / z)
  return reversed ? ndc : f(0.5 + f(0.5 * ndc))
}

// The projection three draws a perspective camera with, as the GPU gets it.
function projection(n: number, farPlane: number, reversed: boolean): Float32Array {
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, n, farPlane)
  // As WebGLRenderer does on a reversed-depth context's first draw.
  Object.assign(camera, { _reversedDepth: reversed })
  camera.updateProjectionMatrix()
  return new Float32Array(camera.projectionMatrix.elements)
}

const FAR = 8e4

describe('depth.glsl', () => {
  const [reversed, standard] = depthGlsl.split('#else')

  it('ports the helpers as the shader has them, by depth mode', () => {
    expect(depthGlsl).toContain('#ifdef USE_REVERSED_DEPTH_BUFFER')
    expect(reversed).toContain('#define FRAG_DEPTH_NEAREST 1.0')
    expect(reversed).toContain('return P[3][2] / (P[2][2] + 1.0);')
    expect(reversed).toContain('return (P[3][2] - P[2][2] * z) / z;')
    // The standard path is the expressions the call sites had before.
    expect(standard).toContain('#define FRAG_DEPTH_NEAREST 0.0')
    expect(standard).toContain('return P[3][2] / (P[2][2] - 1.0);')
    expect(standard).toContain('return 0.5 + 0.5 * (P[3][2] - P[2][2] * z) / z;')
    for (const half of [reversed, standard]) {
      expect(half).toContain('float viewDepthNear(mat4 P)')
      expect(half).toContain('float viewDepthToFragDepth(mat4 P, float z)')
    }
  })

  it('ports fragDepthOfClip as clip-depth.glsl has it, by depth mode', () => {
    const [clipReversed, clipStandard] = clipDepthGlsl.split('#else')
    expect(clipDepthGlsl).toContain('#ifdef USE_REVERSED_DEPTH_BUFFER')
    expect(clipReversed).toContain('return clip.z / clip.w;')
    expect(clipStandard).toContain('return 0.5 + 0.5 * clip.z / clip.w;')
  })

  // fragDepthOfClip, in float32: clip = P · (0, 0, −z, 1) for a point z in
  // front of the eye.
  const ofClip = (m: Float32Array, reversed: boolean, z: number) => {
    const clipZ = f(f(m[10] * -z) + m[14])
    const clipW = f(f(m[11] * -z) + m[15])
    const ndc = f(clipZ / clipW)
    return reversed ? ndc : f(0.5 + f(0.5 * ndc))
  }

  for (const rev of [false, true]) {
    it(`gives a clip-space point the perspective helper's depth (${rev ? 'reversed' : 'standard'})`, () => {
      for (const n of [1e-6, 1e-3, 0.1]) {
        const m = projection(n, FAR, rev)
        for (const z of [n, 2 * n, 0.01, 1, 384, FAR]) {
          const want = fragDepth(m, rev, z)
          expect(Math.abs(ofClip(m, rev, z) - want)).toBeLessThanOrEqual(Math.max(Math.abs(want), 1e-6) * 1e-6)
        }
      }
    })

    it(`runs linear in view depth for an orthographic camera (${rev ? 'reversed' : 'standard'})`, () => {
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 100)
      Object.assign(camera, { _reversedDepth: rev })
      camera.updateProjectionMatrix()
      const m = new Float32Array(camera.projectionMatrix.elements)
      const near = ofClip(m, rev, 0.5)
      const far = ofClip(m, rev, 100)
      expect(near).toBeCloseTo(rev ? 1 : 0, 6)
      expect(far).toBeCloseTo(rev ? 0 : 1, 6)
      for (const z of [1, 10, 37.5, 80]) {
        expect(ofClip(m, rev, z)).toBeCloseTo(near + ((far - near) * (z - 0.5)) / 99.5, 6)
      }
    })
  }

  for (const n of [1e-6, 1e-3, 0.1]) {
    for (const rev of [false, true]) {
      it(`recovers the near plane and spans it to the far one (near ${n}, ${rev ? 'reversed' : 'standard'})`, () => {
        const m = projection(n, FAR, rev)
        expect(near(m, rev) / n).toBeCloseTo(1, 5)
        expect(fragDepth(m, rev, n)).toBeCloseTo(rev ? 1 : 0, 5)
        expect(fragDepth(m, rev, FAR)).toBeCloseTo(rev ? 0 : 1, 5)
      })
    }

    it(`draws reversed depth as 1 − standard (near ${n})`, () => {
      // In exact maths: float32 standard depth has no precision left far out
      // at a short near, which is what reversed-Z is for.
      const exact = (rev: boolean, z: number) => {
        const m = projection(n, FAR, rev)
        const ndc = (m[14] - m[10] * z) / z
        return rev ? ndc : 0.5 + 0.5 * ndc
      }
      for (const z of [n, 2 * n, 0.01, 1, 100, FAR]) {
        expect(exact(true, z)).toBeCloseTo(1 - exact(false, z), 6)
      }
    })
  }

  it('keeps reversed float32 depth ordered where standard collapses (near 1e-6)', () => {
    const rev = projection(1e-6, FAR, true)
    const std = projection(1e-6, FAR, false)
    // 100 surfaces 0.1% apart from 1, 10 and 384 units out.
    for (const start of [1, 10, 384]) {
      const zs = [...Array(100).keys()].map((k) => start * 1.001 ** k)
      const revDepths = zs.map((z) => fragDepth(rev, true, z))
      expect(new Set(revDepths).size).toBe(100)
      expect(revDepths.every((d, k) => k === 0 || d < revDepths[k - 1])).toBe(true)
      expect(new Set(zs.map((z) => fragDepth(std, false, z))).size).toBeLessThan(10)
    }
  })

  it("serves the shell vertex shader's near plane", () => {
    expect(shellVertex).toContain('float viewDepthNear(mat4 P)')
    expect(shellVertex).toContain('vNear = ortho ? 0.0 : viewDepthNear(projectionMatrix);')
    expect(shellVertex).not.toContain('projectionMatrix[3][2]')
  })
})
