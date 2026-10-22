import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { planetSurfaceMaterial, setPlanetDetail } from './planetMaterials'

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
