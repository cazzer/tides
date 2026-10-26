import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer, MARCH_STEPS } from './cloudShaders'
import { FIXED_TERRAIN_GLSL, LIVE_TERRAIN_GLSL, liveTerrain } from './cloudTerrainScale'
import { TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY, TRUE_TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { RELIEF } from '../relief'
import { TERRAIN_BLEND, TERRAIN_SCALE_UNIFORM_GLSL, terrainDisplacement, terrainScaleUniform } from '../terrain-scale'

vi.mock('../ship/reduced-motion', () => ({ prefersReducedMotion: vi.fn(() => false) }))

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

const count = (source: string, part: string) => source.split(part).length - 1

// The lines of `source` the GLSL preprocessor keeps, as far as #ifndef
// guards go: other conditionals are kept whole, only so their #endif pairs.
function preprocessed(source: string): string[] {
  const defined = new Set<string>()
  const skipping: boolean[] = []
  const kept: string[] = []
  for (const line of source.split('\n')) {
    const [directive, name] = line.trim().split(/\s+/)
    const skip = skipping.includes(true)
    if (directive === '#ifndef') skipping.push(defined.has(name))
    else if (directive === '#if' || directive === '#ifdef') skipping.push(false)
    else if (directive === '#endif') skipping.pop()
    else if (!skip) {
      if (directive === '#define') defined.add(name)
      kept.push(line)
    }
  }
  return kept
}

function build(flat: boolean, live?: boolean) {
  const eclipse = createEclipseShadow('earth')
  const clouds = createCloudLayer(eclipse, flat, live)
  const patch = composePatches(eclipse.material, clouds.groundPatch)
  const shader = phongShader()
  patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
  return { clouds, patch, shader }
}

describe('the cloud GLSL on the live terrain scale (tides-zmw.9.6)', () => {
  it('reads the full relief as FIELD writes it, or the live scale times true scale', () => {
    expect(FIXED_TERRAIN_GLSL).toBe(`#define TERRAIN_DISPLACEMENT ${TERRAIN_DISPLACEMENT.toFixed(6)}`)
    expect(LIVE_TERRAIN_GLSL).toBe(
      TERRAIN_SCALE_UNIFORM_GLSL + '#define TERRAIN_DISPLACEMENT (uTerrainScale * 0.003000)'
    )
    expect(TERRAIN_SCALE_UNIFORM_GLSL).toBe(
      '#ifndef TERRAIN_SCALE_DECLARED\n#define TERRAIN_SCALE_DECLARED\nuniform float uTerrainScale;\n#endif\n'
    )
    expect(TRUE_TERRAIN_DISPLACEMENT.toFixed(6)).toBe('0.003000')
  })

  it('is off by default outside a browser', () => {
    expect(TERRAIN_BLEND).toBe(false)
    const { clouds, patch, shader } = build(false)
    expect(clouds.material.fragmentShader).toContain(FIXED_TERRAIN_GLSL)
    expect(shader.fragmentShader).toContain(FIXED_TERRAIN_GLSL)
    expect(patch.customProgramCacheKey()).toBe('eclipse-shadow+cloud-shadow')
    clouds.dispose()
  })

  for (const flat of [false, true]) {
    const key = flat ? 'cloud-shadow-flat' : 'cloud-shadow'

    it(`leaves the programs as FIELD writes them when off (${key})`, () => {
      const { clouds, patch, shader } = build(flat, false)
      for (const source of [clouds.material.vertexShader, clouds.material.fragmentShader, shader.fragmentShader]) {
        expect(count(source, FIXED_TERRAIN_GLSL)).toBe(1)
        expect(source).not.toContain('uTerrainScale')
      }
      expect(patch.customProgramCacheKey()).toBe(`eclipse-shadow+${key}`)
      clouds.dispose()
    })

    it(`puts every FIELD copy on the live scale when on (${key})`, () => {
      const { clouds, patch, shader } = build(flat, true)
      // The vertex shader's copy is the FOG_EASE program's (cloudFogInside).
      for (const source of [clouds.material.vertexShader, clouds.material.fragmentShader, shader.fragmentShader]) {
        expect(source).not.toContain(FIXED_TERRAIN_GLSL)
        expect(count(source, LIVE_TERRAIN_GLSL)).toBe(1)
        expect(count(source, '#define TERRAIN_DISPLACEMENT')).toBe(1)
      }
      // The march's bounds stay at the full relief.
      expect(clouds.material.fragmentShader).toContain(
        `#define TERRAIN_TOP ${(TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY).toFixed(6)}`
      )
      expect(clouds.material.fragmentShader).toContain(`#define MARCH_STEPS ${MARCH_STEPS}`)
      expect(patch.customProgramCacheKey()).toBe(`eclipse-shadow+${key}-live`)
      // One uniform object: the ground's scale, the shell's and the ground's
      // cloud shadow read the same value in the same frame.
      expect(clouds.uniforms.uTerrainScale).toBe(terrainScaleUniform)
      expect(clouds.material.uniforms.uTerrainScale).toBe(terrainScaleUniform)
      expect(shader.uniforms.uTerrainScale).toBe(terrainScaleUniform)
      clouds.dispose()
    })
  }

  it('declares uTerrainScale once, however many patches on one program declare it (tides-zmw.9.7 / 9.12)', () => {
    const decl = 'uniform float uTerrainScale;'
    // The tiles' own declaration, then the cloud shadow's live FIELD.
    const composed = TERRAIN_SCALE_UNIFORM_GLSL + 'void tiles() {}\n' + LIVE_TERRAIN_GLSL + '\nvoid main() {}'
    expect(count(composed, decl)).toBe(2)
    expect(preprocessed(composed).filter((line) => line.trim() === decl)).toHaveLength(1)
    expect(preprocessed(composed)).toContain('void main() {}')
    // And on the ground patch as built, alongside such a declaration.
    const { clouds, shader } = build(false, true)
    expect(preprocessed(TERRAIN_SCALE_UNIFORM_GLSL + shader.fragmentShader).filter((line) => line.trim() === decl))
      .toHaveLength(1)
    clouds.dispose()
  })

  it('throws on a shader without FIELD’s line, rather than leave the clouds on the full relief', () => {
    expect(() => liveTerrain('void main() {}', true)).toThrow(/no #define TERRAIN_DISPLACEMENT/)
    expect(() => liveTerrain('void main() {}', false)).toThrow(/no #define TERRAIN_DISPLACEMENT/)
    const reformatted = FIXED_TERRAIN_GLSL.replace(' ', '  ')
    expect(() => liveTerrain(reformatted, true)).toThrow()
  })

  it('gives the ground’s displacementScale to within a float32 ulp at every scale', () => {
    const f32 = Math.fround
    for (let s = 1; s <= 25; s += 0.25) {
      const shell = f32(f32(s) * f32(TRUE_TERRAIN_DISPLACEMENT))
      const ground = f32(terrainDisplacement(s))
      const ulp = 2 ** (Math.floor(Math.log2(ground)) - 23)
      expect(Math.abs(shell - ground)).toBeLessThanOrEqual(ulp)
    }
    // Exactly at the page's relief, as FIELD writes it.
    expect(f32(f32(RELIEF) * f32(TRUE_TERRAIN_DISPLACEMENT))).toBeCloseTo(f32(TERRAIN_DISPLACEMENT), 8)
  })
})
