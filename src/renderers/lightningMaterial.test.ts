import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { createLightningMaterial } from './lightningMaterial'

const cloud = () => ({
  map: { value: null } as THREE.IUniform<THREE.Texture | null>,
  red: { value: 1 },
  shift: { value: 0.25 },
})

const declared = (name: string) =>
  [
    ...readFileSync(new URL(`../shaders/lightning/${name}`, import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
      .matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm),
  ].map((m) => m[1])

describe('lightning material', () => {
  test("shares the cloud layer's uniforms by identity", () => {
    const c = cloud()
    const material = createLightningMaterial(2, c)
    expect(material.uniforms.uCloudMap).toBe(c.map)
    expect(material.uniforms.uCloudMapRed).toBe(c.red)
    expect(material.uniforms.uCloudShift).toBe(c.shift)
    c.shift.value = 0.5
    expect(material.uniforms.uCloudShift.value).toBe(0.5)
    material.dispose()
  })

  test('additive over the cloud, both faces, depth-tested, not writing depth or tone mapped', () => {
    const material = createLightningMaterial(2, cloud())
    expect(material.side).toBe(THREE.DoubleSide)
    expect(material.blending).toBe(THREE.AdditiveBlending)
    expect(material.transparent).toBe(true)
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.toneMapped).toBe(false)
    expect(material.uniforms.uRadius.value).toBe(2)
    material.dispose()
  })

  test("its uniforms are the shaders' declarations", () => {
    const material = createLightningMaterial(2, cloud())
    const names = new Set([...declared('vertex.glsl'), ...declared('fragment.frag')])
    expect(names.size).toBeGreaterThan(10)
    expect(Object.keys(material.uniforms).sort()).toEqual([...names].sort())
    material.dispose()
  })
})
