import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  BAND_DETAIL_OCTAVES,
  DETAIL_FLOW_CYCLES,
  DETAIL_FLOW_OFFSET,
  DETAIL_FLOW_PERIOD,
  DETAIL_FLOW_RATE,
  HAZE_VEIL_HEIGHTS,
  bandFlowPhases,
  bandFlowRate,
  detailFlowTime,
  hazeVeilWeight,
  planetAtmosphereMaterial,
  planetDeckMaterial,
  planetSurfaceMaterial,
  setPlanetDetail,
} from './planetMaterials'
import { moonDetailPatch } from './moonDetail'
import {
  JUPITER_HAZE_OUTER,
  MARS_HAZE_OUTER,
  NEPTUNE_HAZE_OUTER,
  SATURN_HAZE_OUTER,
  URANUS_HAZE_OUTER,
  VENUS_HAZE_OUTER,
} from './planets/haze-shells'
import { COLLISION_MARGIN } from '../ship/flight'

const sun = { value: new THREE.Vector3(1, 0, 0) }

describe('planet surface detail', () => {
  it('caps the octaves on low quality, textured or not', () => {
    const map = new THREE.Texture()
    expect(planetSurfaceMaterial(sun).defines.PLANET_DETAIL_OCTAVES).toBe(5)
    expect(planetSurfaceMaterial(sun, { map }).defines.PLANET_DETAIL_OCTAVES).toBe(5)
    expect(planetSurfaceMaterial(sun, { lowQuality: true }).defines.PLANET_DETAIL_OCTAVES).toBe(2)
    expect(planetSurfaceMaterial(sun, { map, lowQuality: true }).defines.PLANET_DETAIL_OCTAVES).toBe(2)
  })

  it('gives a moon textured late the program of one built with its map', () => {
    for (const lowQuality of [false, true]) {
      // As MoonBodies' applyMap does; three keys programs by define order.
      const late = planetSurfaceMaterial(sun, { lowQuality })
      late.defines.USE_PLANET_MAP = ''
      const built = planetSurfaceMaterial(sun, { map: new THREE.Texture(), lowQuality })
      expect(Object.entries(late.defines)).toEqual(Object.entries(built.defines))
    }
  })

  it('compiles the noise only with a map', () => {
    const shader = planetSurfaceMaterial(sun).fragmentShader
    const mapStart = shader.indexOf('#ifdef USE_PLANET_MAP')
    expect(mapStart).toBeGreaterThanOrEqual(0)
    expect(shader.indexOf('snoise3(')).toBeGreaterThan(mapStart)
    expect(shader.indexOf('uniform int uDetailStyle')).toBeGreaterThan(mapStart)
    // setPlanetDetail's values.
    expect(shader).toMatch(/#define DETAIL_BANDS 1\n#define DETAIL_ROCK 2\n#define DETAIL_STREAKS 3\n/)
  })

  it('sets and clears the style through uniforms alone', () => {
    const material = planetSurfaceMaterial(sun, { map: new THREE.Texture() })
    const u = material.uniforms
    expect([u.uDetailStyle.value, u.uDetailStrength.value, u.uDetailBump.value]).toEqual([0, 0, 0])
    const defines = { ...material.defines }

    setPlanetDetail(material, { style: 'rock', strength: 0.3, bump: 0.1 })
    expect([u.uDetailStyle.value, u.uDetailStrength.value, u.uDetailBump.value]).toEqual([2, 0.3, 0.1])
    setPlanetDetail(material, { style: 'bands', strength: 0.2 })
    expect([u.uDetailStyle.value, u.uDetailBump.value]).toEqual([1, 0])
    setPlanetDetail(material, { style: 'streaks', strength: 0.1 })
    expect(u.uDetailStyle.value).toBe(3)
    setPlanetDetail(material)
    expect([u.uDetailStyle.value, u.uDetailStrength.value]).toEqual([0, 0])
    expect(material.defines).toEqual(defines)
  })
})

describe('shared detail source', () => {
  it('gives the planets and the Moon the same detail code', () => {
    const planet = planetSurfaceMaterial(sun, { map: new THREE.Texture() }).fragmentShader
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
      vertexShader: THREE.ShaderLib.phong.vertexShader,
      fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    }
    moonDetailPatch(false).onBeforeCompile(
      shader as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer
    )
    // From a function's signature to the line that closes it.
    const fn = (source: string, name: string) => {
      const start = source.indexOf(`${name}(`)
      expect(start).toBeGreaterThanOrEqual(0)
      const end = source.indexOf('\n}\n', start)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }
    for (const name of ['void planetDetailNoise', 'void planetDetail', 'float planetDetailFootprint']) {
      expect(fn(shader.fragmentShader, name)).toBe(fn(planet, name))
    }
    // The Moon's patch doesn't flow, and its bands' octaves (unused) are its own.
    expect(shader.fragmentShader).not.toMatch(/#define PLANET_DETAIL_FLOW\b/)
    expect(shader.fragmentShader).not.toMatch(/#define PLANET_BAND_OCTAVES \d/)
  })
})

describe('band flow (tides-ufyr.8.2)', () => {
  const map = new THREE.Texture()
  const flow = (options: Parameters<typeof planetSurfaceMaterial>[1]) =>
    planetSurfaceMaterial(sun, options).defines.PLANET_DETAIL_FLOW

  it('flows textured band detail on the high tier only', () => {
    expect(flow({ map, flowingBands: true, lowQuality: false })).toBe('')
    expect(flow({ map, flowingBands: true, lowQuality: true })).toBeUndefined()
    // Rock, streaks and moons: no flowingBands.
    expect(flow({ map, lowQuality: false })).toBeUndefined()
    expect(flow({ flowingBands: true, lowQuality: false })).toBeUndefined()
  })

  it('passes the flow constants as GLSL floats', () => {
    const d = planetSurfaceMaterial(sun, { map, flowingBands: true, lowQuality: false }).defines
    for (const [name, value] of [
      ['DETAIL_FLOW_RATE', DETAIL_FLOW_RATE],
      ['DETAIL_FLOW_PERIOD', DETAIL_FLOW_PERIOD],
      ['DETAIL_FLOW_CYCLES', DETAIL_FLOW_CYCLES],
      ['DETAIL_FLOW_OFFSET', DETAIL_FLOW_OFFSET],
    ] as const) {
      expect(d[name]).toMatch(/^\d+(\.\d+)?(e-?\d+)?$/)
      expect(d[name]).toMatch(/[.e]/)
      expect(Number(d[name])).toBe(value)
    }
  })

  it('gives the bands 6 octaves on high, 2 on low, others as before', () => {
    const high = planetSurfaceMaterial(sun, { map, flowingBands: true, lowQuality: false }).defines
    expect([high.PLANET_BAND_OCTAVES, high.PLANET_DETAIL_OCTAVES]).toEqual([BAND_DETAIL_OCTAVES, 5])
    // Finer would terrace: the noise is keyed to the unit sphere.
    expect(BAND_DETAIL_OCTAVES).toBe(6)
    const low = planetSurfaceMaterial(sun, { map, flowingBands: true, lowQuality: true }).defines
    expect([low.PLANET_BAND_OCTAVES, low.PLANET_DETAIL_OCTAVES]).toEqual([2, 2])
    // The same for every globe of a tier, so it adds no program.
    expect(planetSurfaceMaterial(sun, { lowQuality: false }).defines.PLANET_BAND_OCTAVES).toBe(6)
  })

  it('keeps the bands contrast from range, and stops at the first faded octave, NaN too', () => {
    const shader = planetSurfaceMaterial(sun, { map }).fragmentShader
    // Normalised by the first PLANET_DETAIL_OCTAVES' amplitudes, as before
    // the extra octaves; rock and streaks take exactly those.
    expect(shader).toContain('float(min(octaves, PLANET_DETAIL_OCTAVES))')
    expect(shader).toContain('if (!(w > 0.0)) break;')
  })

  it('has a uDetailTime uniform, flowing or not', () => {
    for (const flowingBands of [false, true]) {
      expect(planetSurfaceMaterial(sun, { map, flowingBands }).uniforms.uDetailTime.value).toBe(0)
    }
  })

  it('keeps the flow, and its uniform, inside #ifdef PLANET_DETAIL_FLOW', () => {
    const shader = planetSurfaceMaterial(sun, { map }).fragmentShader
    const start = shader.indexOf('#ifdef PLANET_DETAIL_FLOW')
    const end = shader.indexOf('#endif', start)
    expect(start).toBeGreaterThanOrEqual(0)
    const block = shader.slice(start, end)
    for (const code of ['uniform float uDetailTime', 'vec3 detailFlowTurn(', 'void detailFlowPhase(']) {
      expect(shader.indexOf(code)).toBe(shader.lastIndexOf(code))
      expect(block).toContain(code)
    }
    expect(block).toContain('cos(lat) * cos(6.0 * lat)')
    // bandFlowPhases' key.
    expect(block).toContain('float key = 2.0 * mod(floor(cycles), DETAIL_FLOW_CYCLES) + 2.0 * shift;')
    expect(block).toContain('fract(key * vec3(')
    // planetDetail's call into it is guarded too.
    const entry = shader.slice(shader.indexOf('void planetDetail('))
    const guard = entry.indexOf('#ifdef PLANET_DETAIL_FLOW')
    expect(guard).toBeGreaterThan(0)
    expect(entry.indexOf('detailFlowPhase(')).toBeGreaterThan(guard)
    expect(entry.indexOf('detailFlowPhase(')).toBeLessThan(entry.indexOf('#endif', guard))
  })

  it('blows a prograde equatorial jet, alternating poleward, mirrored across the equator', () => {
    const deg = Math.PI / 180
    expect(bandFlowRate(0)).toBe(DETAIL_FLOW_RATE)
    for (const lat of [15, 45, 75, 90]) {
      expect(bandFlowRate(lat * deg)).toBeCloseTo(0, 12)
      expect(bandFlowRate(-lat * deg)).toBeCloseTo(0, 12)
    }
    expect(bandFlowRate(30 * deg)).toBeLessThan(0)
    expect(bandFlowRate(60 * deg)).toBeGreaterThan(0)
    for (let lat = -90; lat <= 90; lat += 0.5) {
      expect(bandFlowRate(-lat * deg)).toBeCloseTo(bandFlowRate(lat * deg), 15)
      expect(Math.abs(bandFlowRate(lat * deg))).toBeLessThanOrEqual(DETAIL_FLOW_RATE)
    }
  })

  it('crossfades two phases with weights that sum to 1, each restarting unseen', () => {
    const step = 0.01
    let previous = bandFlowPhases(0)
    for (let time = step; time < 3 * DETAIL_FLOW_PERIOD; time += step) {
      const phases = bandFlowPhases(time)
      expect(phases[0].weight + phases[1].weight).toBeCloseTo(1, 9)
      // Never the same offset, though they share a cycle half the time.
      expect(phases[0].key).not.toBe(phases[1].key)
      phases.forEach((phase, i) => {
        expect(phase.key).toBe(2 * phase.cycle + i)
        expect(phase.t).toBeGreaterThanOrEqual(0)
        expect(phase.t).toBeLessThan(DETAIL_FLOW_PERIOD)
        // A restart (t jumps back, a new cycle) only where the weight is ~0.
        if (phase.t < previous[i].t) {
          expect(phase.cycle).not.toBe(previous[i].cycle)
          expect(phase.weight).toBeLessThan(2 * step / DETAIL_FLOW_PERIOD + 1e-9)
        } else {
          expect(phase.cycle).toBe(previous[i].cycle)
        }
      })
      previous = phases
    }
  })

  it('bounds the shear: a phase turns any two latitudes apart by a sliver', () => {
    // The most a phase's noise is turned, and the most two latitudes 1° apart
    // are turned apart, by the end of its period.
    const deg = Math.PI / 180
    let turn = 0
    let shear = 0
    for (let lat = -90; lat < 90; lat += 0.25) {
      turn = Math.max(turn, Math.abs(bandFlowRate(lat * deg)) * DETAIL_FLOW_PERIOD)
      shear = Math.max(
        shear,
        Math.abs(bandFlowRate((lat + 1) * deg) - bandFlowRate(lat * deg)) * DETAIL_FLOW_PERIOD
      )
    }
    expect(turn).toBeLessThanOrEqual(DETAIL_FLOW_RATE * DETAIL_FLOW_PERIOD)
    expect(shear).toBeLessThan(6 * deg * DETAIL_FLOW_RATE * DETAIL_FLOW_PERIOD)
    expect(turn).toBeGreaterThan(0)
  })

  it('wraps the clock to whole cycles, with no jump in either phase', () => {
    const span = DETAIL_FLOW_CYCLES * DETAIL_FLOW_PERIOD
    expect(detailFlowTime(0)).toBe(0)
    expect(detailFlowTime(span + 12.5)).toBeCloseTo(12.5, 9)
    expect(detailFlowTime(5 * span - 0.25)).toBeCloseTo(span - 0.25, 6)
    const before = bandFlowPhases(detailFlowTime(span - 1e-6))
    const after = bandFlowPhases(detailFlowTime(span))
    // The half-period phase, at full weight here, keeps its cycle, offset and age.
    expect(after[1].cycle).toBe(before[1].cycle)
    expect(after[1].key).toBe(before[1].key)
    expect(after[0].key).not.toBe(after[1].key)
    expect(after[1].t).toBeCloseTo(before[1].t, 4)
    expect(after[1].weight).toBeCloseTo(1, 6)
    expect(after[0].weight).toBeCloseTo(0, 6)
  })
})

describe('planet haze material (tides-ufyr.4)', () => {
  it('draws from inside in one pass, its double-sided program warmed, with no sea', () => {
    const material = planetAtmosphereMaterial(sun)
    // Else three draws a transparent double-sided material twice, as two programs.
    expect(material.forceSinglePass).toBe(true)
    expect(material.userData.warmSides).toEqual([THREE.DoubleSide])
    expect(material.uniforms.uSeaLevel.value).toBe(0)
    // pickShellFaces reads the shell's radius from it.
    expect(material.uniforms.uOuter).toBeDefined()
    expect(material.uniforms.uSun).toBe(sun)
    expect(material.defines.HAZE_COVER).toBeUndefined()
  })
})

describe("planet haze veil from inside (tides-ufyr.4.1)", () => {
  // Each planet's haze as its PlanetAtmosphere takes it (planets/*.tsx):
  // surface 1, the outer edge and the scale height, fractions of R.
  const hazes: [string, number, number][] = [
    ['venus', VENUS_HAZE_OUTER, 0.008],
    ['mars', MARS_HAZE_OUTER, 0.007],
    ['jupiter', JUPITER_HAZE_OUTER, 0.004],
    ['saturn', SATURN_HAZE_OUTER, 0.006],
    ['uranus', URANUS_HAZE_OUTER, 0.008],
    ['neptune', NEPTUNE_HAZE_OUTER, 0.008],
  ]

  it("blends premultiplied as the Earth's, its veil's heights a GLSL float", () => {
    const material = planetAtmosphereMaterial(sun)
    expect(material.blending).toBe(THREE.CustomBlending)
    expect(material.blendSrc).toBe(THREE.OneFactor)
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor)
    expect(material.defines.HAZE_COVER).toBeUndefined()
    expect(material.defines.PLANET_HAZE_VEIL_HEIGHTS).toBe(`${HAZE_VEIL_HEIGHTS}.0`)
  })

  it('sets the veil on the encoded colour, the outside alpha 0, all off the Earth program', () => {
    const shader = planetAtmosphereMaterial(sun).fragmentShader
    const encode = shader.indexOf('#include <colorspace_fragment>')
    const alpha = shader.indexOf('gl_FragColor.a = min(veil * max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b), 1.0);')
    expect(encode).toBeGreaterThan(0)
    expect(alpha).toBeGreaterThan(encode)
    // Under #ifndef HAZE_COVER, so the Earth's program compiles none of it.
    expect(shader.lastIndexOf('#ifndef HAZE_COVER', alpha)).toBeGreaterThan(encode)
    expect(shader).toContain('gl_FragColor = vec4(hazeGlow(column, grazing, at, uSun, rd, ro), 0.0);')
    expect(shader).toContain('veil = 1.0 - smoothstep(uSurface + PLANET_HAZE_VEIL_HEIGHTS * H, uOuter, length(ro));')
    for (const at of [shader.indexOf('float veil = 0.0;'), shader.indexOf('veil = 1.0 - smoothstep(')]) {
      const guard = shader.lastIndexOf('#ifndef HAZE_COVER', at)
      expect(guard).toBeGreaterThan(0)
      expect(shader.indexOf('#endif', guard)).toBeGreaterThan(at)
    }
  })

  it("compiles none of it into the Earth's program (HAZE_COVER)", () => {
    // Every code line that reads or writes the veil, or writes the planets'
    // alpha 0, lies in a branch the Earth's HAZE_COVER compiles out.
    const shader = planetAtmosphereMaterial(sun).fragmentShader
    // Per open #if: is the branch we're in compiled out under HAZE_COVER?
    const out: { kind: 'ifndef' | 'ifdef' | 'other'; out: boolean }[] = []
    let seen = 0
    for (const line of shader.split('\n')) {
      const t = line.trim()
      if (t === '#ifndef HAZE_COVER') out.push({ kind: 'ifndef', out: true })
      else if (t === '#ifdef HAZE_COVER') out.push({ kind: 'ifdef', out: false })
      else if (t.startsWith('#if')) out.push({ kind: 'other', out: false })
      else if (t.startsWith('#el')) {
        const top = out[out.length - 1]
        top.out = top.kind === 'ifdef' && t === '#else'
      } else if (t === '#endif') out.pop()
      const code = t.split('//')[0]
      if (/\bveil\b|PLANET_HAZE_VEIL_HEIGHTS|ro\), 0\.0\);$/.test(code)) {
        seen++
        expect(out.some((branch) => branch.out), line).toBe(true)
      }
    }
    expect(out).toHaveLength(0)
    expect(seen).toBe(4)
  })

  it.each(hazes)("veils %s's ground whole at its stop, none at the shell's edge, monotone", (_key, outer, H) => {
    expect(1 + HAZE_VEIL_HEIGHTS * H).toBeLessThan(outer)
    expect(hazeVeilWeight(outer, 1, outer, H)).toBe(0)
    expect(hazeVeilWeight(outer * 1.1, 1, outer, H)).toBe(0)
    expect(hazeVeilWeight(1, 1, outer, H)).toBe(1)
    let last = Infinity
    for (let i = 0; i <= 200; i++) {
      const v = hazeVeilWeight(0.99 + (i / 200) * (outer + 0.01 - 0.99), 1, outer, H)
      expect(v).toBeLessThanOrEqual(last)
      last = v
    }
  })

  it.each(hazes.filter(([key]) => key === 'venus' || key === 'mars'))('veils whole at the %s stop', (_key, outer, H) => {
    for (const r of [COLLISION_MARGIN, 1.0205]) expect(hazeVeilWeight(r, 1, outer, H)).toBe(1)
  })

  it('keeps glow over what is left of the ground under 1, channel by channel', () => {
    // One/OneMinusSrcAlpha with alpha the glow's brightest channel s, over
    // any d ≤ 1: s + d(1 − max s) ≤ 1.
    const steps = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const alpha = Math.max(r, g, b)
      for (const d of steps) {
        for (const s of [r, g, b]) expect(s + d * (1 - alpha)).toBeLessThanOrEqual(1 + 1e-12)
      }
    }
  })
})

describe('planet cloud-deck material (tides-ufyr.8.3)', () => {
  it('blends over the scene from inside in one pass, writing no depth, its double-sided program warmed', () => {
    const material = planetDeckMaterial(sun)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.blending).toBe(THREE.NormalBlending)
    expect(material.forceSinglePass).toBe(true)
    expect(material.userData.warmSides).toEqual([THREE.DoubleSide])
    // pickShellFaces reads the shell's radius from it, and it starts discarding.
    expect(material.uniforms.uOuter).toBeDefined()
    expect(material.uniforms.uDeckFade.value).toBe(0)
    expect(material.uniforms.uSunDir).toBe(sun)
  })

  it('gives every giant one program per tier: the same shaders and defines', () => {
    for (const lowQuality of [false, true]) {
      const [a, b] = [planetDeckMaterial(sun, { lowQuality }), planetDeckMaterial({ value: new THREE.Vector3() }, { lowQuality })]
      expect(a.vertexShader).toBe(b.vertexShader)
      expect(a.fragmentShader).toBe(b.fragmentShader)
      expect(Object.entries(a.defines)).toEqual(Object.entries(b.defines))
    }
  })

  it("takes the globes' band octaves and flow on the high tier only", () => {
    const high = planetDeckMaterial(sun, { lowQuality: false })
    const globe = planetSurfaceMaterial(sun, { map: new THREE.Texture(), flowingBands: true, lowQuality: false })
    const globeDefines = { ...globe.defines }
    delete globeDefines.USE_PLANET_MAP
    const deckDefines = { ...high.defines }
    delete deckDefines.RING_PROFILE_EITHER
    delete deckDefines.MAX_RING_BANDS
    expect(deckDefines).toEqual(globeDefines)
    const low = planetDeckMaterial(sun, { lowQuality: true })
    expect(low.defines.PLANET_DETAIL_FLOW).toBeUndefined()
    expect(low.defines.PLANET_BAND_OCTAVES).toBe(2)
  })

  it('compiles the column without the hazes clamp, and no derivatives', () => {
    const shader = planetDeckMaterial(sun).fragmentShader
    expect(shader).toContain('float deckColumn(float r, float mu, float R, float H)')
    expect(shader).toContain('bool shellBackFace(')
    expect(shader).not.toContain('columnAhead(')
    // Its footprint is uPixelAngle's: main() and deckRadiance(), which it
    // calls, take no derivatives, nor call the detail's footprint helper,
    // which does.
    const radiance = shader.indexOf('vec3 deckRadiance(')
    expect(radiance).toBeGreaterThan(0)
    expect(radiance).toBeLessThan(shader.indexOf('void main()'))
    const own = shader.slice(radiance)
    expect(own).not.toMatch(/dFd[xy]|fwidth|planetDetailFootprint/)
    expect(own).toContain('uPixelAngle')
  })

  it('blends the direct term to the fog daylight before the ring shadow, adding no defines (tides-ufyr.8.3.2)', () => {
    const flow = ['PLANET_DETAIL_FLOW', 'DETAIL_FLOW_RATE', 'DETAIL_FLOW_PERIOD', 'DETAIL_FLOW_CYCLES', 'DETAIL_FLOW_OFFSET']
    for (const lowQuality of [false, true]) {
      const material = planetDeckMaterial(sun, { lowQuality })
      expect(material.uniforms.uDeckLight.value).toBe(0)
      expect(material.uniforms.uDeckInside.value).toBe(0)
      // In deckRadiance, which main calls for the fog and for the layer.
      const radiance = material.fragmentShader.slice(material.fragmentShader.indexOf('vec3 deckRadiance('))
      const blend = radiance.indexOf('direct = mix(direct, deckLight, uDeckInside);')
      expect(blend).toBeGreaterThan(radiance.indexOf('direct *= exp(-max(R - length(at), 0.0) / uSunDepth);'))
      expect(blend).toBeLessThan(radiance.indexOf('uRingOpacity > 0.0'))
      expect(radiance.indexOf('uRingOpacity > 0.0')).toBeLessThan(radiance.indexOf('void main()'))
      expect(Object.keys(material.defines).sort()).toEqual(
        ['PLANET_DETAIL_OCTAVES', 'PLANET_BAND_OCTAVES', ...(lowQuality ? [] : flow), 'RING_PROFILE_EITHER', 'MAX_RING_BANDS'].sort()
      )
    }
  })
})

describe("the cloud deck's layer under the fog (tides-ufyr.4.1)", () => {
  it('starts with no layer, its uniforms 0, adding no defines', () => {
    for (const lowQuality of [false, true]) {
      const material = planetDeckMaterial(sun, { lowQuality })
      for (const name of ['uLayerShow', 'uLayerLevel', 'uLayerSeen', 'uLayerLight']) {
        expect(material.uniforms[name].value, name).toBe(0)
      }
      expect(material.uniforms.uDeckTint.value.toArray()).toEqual([1, 1, 1])
      expect(Object.keys(material.defines)).not.toContain('DECK_LAYER')
    }
  })

  it('lights the fog and the layer through one deckRadiance, the layer only where it shows', () => {
    const shader = planetDeckMaterial(sun).fragmentShader
    const main = shader.slice(shader.indexOf('void main()'))
    expect(shader).toContain('vec3 deckRadiance(vec3 at, float s, vec3 rd, float foreshorten, float detailWeight, float deckLight)')
    // The fog keeps its colour point, giving its detail up to the layer.
    // Its detail is skipped wherever the layer shows: no two detail calls.
    expect(main).toContain('vec3 colour = deckRadiance(ro + rd * s, s, rd, 1.0, uLayerShow > 0.0 ? 0.0 : 1.0, uDeckLight);')
    const gate = main.indexOf('if (uLayerShow > 0.0 && uLayerSeen > 0.0)')
    expect(gate).toBeGreaterThan(0)
    expect(main.indexOf('deckLayerHit(r, mu, uLayerLevel)')).toBeGreaterThan(gate)
    expect(main).toContain('float wL = uLayerShow * exp(-sL / uLayerSeen);')
    expect(main).toContain('if (wL > 1.0 / 512.0)')
    expect(main).toContain('deckRadiance(atL, sL, rd, foreshorten, DECK_LAYER_DETAIL, uLayerLight)')
    // The view's shade by cos(zenith), after the layer, before the write.
    const shade = main.indexOf('colour *= deckViewShade(mu, uDeckInside);')
    expect(shade).toBeGreaterThan(main.indexOf('deckRadiance(atL'))
    expect(shade).toBeLessThan(main.indexOf('gl_FragColor = vec4(colour'))
    // The giant's tint, by uDeckInside alone: none at and over the cloud top.
    expect(shader).toContain('albedo *= mix(vec3(1.0), uDeckTint, uDeckInside);')
    // The detail is skipped at no weight; at full weight as before.
    expect(shader).toContain('if (uDetailStyle != 0 && detailWeight > 0.0)')
    expect(shader).toContain('albedo *= max(0.0, 1.0 + uDetailStrength * detailWeight * d);')
    expect(shader).toContain('float fp = uPixelAngle * max(s, 1e-6 * R) / R / foreshorten;')
  })
})

describe("the cloud deck's ring shadow (tides-ufyr.8.3)", () => {
  it('compiles map and bands both, picked by a uniform, off until a giant sets its rings', () => {
    const material = planetDeckMaterial(sun)
    expect(material.defines.RING_PROFILE_EITHER).toBe('')
    expect(material.defines.MAX_RING_BANDS).toBeGreaterThan(0)
    const u = material.uniforms
    expect(u.uRingOpacity.value).toBe(0)
    expect(u.uRingHasMap.value).toBe(false)
    expect(u.uBands.value).toHaveLength(material.defines.MAX_RING_BANDS as number)
    const shader = material.fragmentShader
    expect(shader).toContain('uRingOpacity > 0.0 && n.y * uSunDir.y < 0.0')
    expect(shader).toContain('uniform bool uRingHasMap;')
    expect(shader).toContain('uniform sampler2D uRingMap;')
    expect(shader).toContain('float ringBandsAlpha(float u)')
  })

  it("leaves the globe's and the rings' own profile as it was", () => {
    const shadowed = planetSurfaceMaterial(sun, { map: new THREE.Texture(), ringMap: new THREE.Texture(), shadowed: true })
    // Its USE_RING_MAP branch, as before; the deck's needs RING_PROFILE_EITHER.
    expect(shadowed.defines.RING_PROFILE_EITHER).toBeUndefined()
    expect(shadowed.fragmentShader).toMatch(/#elif defined\(USE_RING_MAP\)\n\s*return texture2D\(uRingMap, vec2\(u, 0\.5\)\)\.a;/)
  })
})
