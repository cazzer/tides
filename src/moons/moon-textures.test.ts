import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MOON_KEYS } from './moon-keys'
import { moonTextureUrls } from './moon-textures'

describe('moon surface maps', () => {
  it('has a 1k map for every moon', () => {
    for (const key of MOON_KEYS) expect(moonTextureUrls(key, true).jpeg).toMatch(new RegExp(`${key}-1k\\.jpg`))
  })

  it('pairs each map with its KTX2 of the same size', () => {
    for (const key of MOON_KEYS) {
      for (const low of [true, false]) {
        const { jpeg, ktx2 } = moonTextureUrls(key, low)
        expect(ktx2?.replace(/\.ktx2$/, '.jpg')).toBe(jpeg)
      }
    }
  })

  it('picks the 2k map unless low quality, where there is one', () => {
    expect(moonTextureUrls('ganymede', false).jpeg).toMatch(/ganymede-2k\.jpg/)
    expect(moonTextureUrls('ganymede', true).jpeg).toMatch(/ganymede-1k\.jpg/)
    // Voyager's Uranian maps are too coarse for a 2k one.
    expect(moonTextureUrls('ariel', false).jpeg).toMatch(/ariel-1k\.jpg/)
  })
})

describe('SphereGeometry UVs, which the maps and moonOrientationInto assume', () => {
  it('puts u = 0.5 (longitude 0) at +X, u = 0.75 (90° E) at −Z and v = 1 toward +Y', () => {
    const sphere = new THREE.SphereGeometry(1, 64, 32)
    const { position, uv } = sphere.attributes
    const at = (u: number, v: number) => {
      for (let i = 0; i < uv.count; i++) {
        if (Math.abs(uv.getX(i) - u) < 1e-6 && Math.abs(uv.getY(i) - v) < 1e-6) {
          return new THREE.Vector3().fromBufferAttribute(position, i)
        }
      }
      throw new Error(`no vertex at ${u}, ${v}`)
    }
    expect(at(0.5, 0.5).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-6)
    expect(at(0.75, 0.5).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-6)
    expect(at(0.5, 0.75).y).toBeCloseTo(Math.SQRT1_2, 6)
  })
})
