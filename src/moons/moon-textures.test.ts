import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MOON_KEYS } from './moon-keys'
import { moonTextureUrl } from './moon-textures'

describe('moon surface maps', () => {
  it('has a 1k map for every moon', () => {
    for (const key of MOON_KEYS) expect(moonTextureUrl(key, true)).toMatch(new RegExp(`${key}-1k\\.jpg`))
  })

  it('picks the 2k map unless low quality, where there is one', () => {
    expect(moonTextureUrl('ganymede', false)).toMatch(/ganymede-2k\.jpg/)
    expect(moonTextureUrl('ganymede', true)).toMatch(/ganymede-1k\.jpg/)
    // Voyager's Uranian maps are too coarse for a 2k one.
    expect(moonTextureUrl('ariel', false)).toMatch(/ariel-1k\.jpg/)
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
