import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  BAND_DETAIL_OCTAVES,
  DETAIL_FLOW_CYCLES,
  DETAIL_FLOW_OFFSET,
  DETAIL_FLOW_PERIOD,
  DETAIL_FLOW_RATE,
  bandFlowPhases,
  bandFlowRate,
  detailFlowTime,
  planetAtmosphereMaterial,
  planetSurfaceMaterial,
  setPlanetDetail,
} from './planetMaterials'
import { moonDetailPatch } from './moonDetail'

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

  it('gives the bands 8 octaves on high, 2 on low, others as before', () => {
    const high = planetSurfaceMaterial(sun, { map, flowingBands: true, lowQuality: false }).defines
    expect([high.PLANET_BAND_OCTAVES, high.PLANET_DETAIL_OCTAVES]).toEqual([BAND_DETAIL_OCTAVES, 5])
    expect(BAND_DETAIL_OCTAVES).toBe(8)
    const low = planetSurfaceMaterial(sun, { map, flowingBands: true, lowQuality: true }).defines
    expect([low.PLANET_BAND_OCTAVES, low.PLANET_DETAIL_OCTAVES]).toEqual([2, 2])
    // The same for every globe of a tier, so it adds no program.
    expect(planetSurfaceMaterial(sun, { lowQuality: false }).defines.PLANET_BAND_OCTAVES).toBe(8)
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
      phases.forEach((phase, i) => {
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
    // The half-period phase, at full weight here, keeps its cycle and age.
    expect(after[1].cycle).toBe(before[1].cycle)
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
    expect(material.blending).toBe(THREE.AdditiveBlending)
    expect(material.defines.HAZE_COVER).toBeUndefined()
  })
})
