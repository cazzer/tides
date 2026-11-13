import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { WebGLAttributes } from 'three/src/renderers/webgl/WebGLAttributes.js'
import { FLASH_LIFETIME_S } from '../lightning'
import { createLightningInstances, DEAD_START_S, MAX_RANGES, REBASE_S } from './lightningInstances'

const ranges = (a: THREE.BufferAttribute) => a.updateRanges.map((r) => [r.start, r.count])

// three's attribute uploads on a fake context: what reaches bufferSubData.
function fakeUploads() {
  const subData: [number, number][] = []
  const gl = {
    ARRAY_BUFFER: 0x8892,
    FLOAT: 0x1406,
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: (_t: number, offsetBytes: number, _a: Float32Array, start = 0, count = 0) =>
      subData.push([offsetBytes / 4, count || start]),
  }
  const attributes = new (WebGLAttributes as unknown as new (gl: unknown) => {
    update(a: THREE.BufferAttribute, type: number): void
  })(gl)
  return { subData, upload: (a: THREE.BufferAttribute) => attributes.update(a, gl.ARRAY_BUFFER) }
}

describe('the lightning ring', () => {
  test('one draw: a quad per slot, every slot unlit at first', () => {
    const ring = createLightningInstances(8)
    expect(ring.geometry.instanceCount).toBe(8)
    expect(ring.geometry.index!.count).toBe(6)
    for (let i = 0; i < 8; i++) expect(ring.flash.array[i * 4]).toBe(DEAD_START_S)
  })

  test("writes a flash into the next slot and uploads only this frame's slots", () => {
    const ring = createLightningInstances(8)
    const t = ring.begin(100)
    expect(t).toBe(100)
    expect(ring.write(0, 1, 0, 0.5, 0.2, 0.7, 30)).toBe(true)
    expect(ring.write(1, 0, 0, 0.25, 0.3, 1, 8)).toBe(true)
    ring.flush()
    expect([...ring.dir.array.slice(0, 8)]).toEqual([0, 1, 0, 0.5, 1, 0, 0, 0.25])
    expect([...ring.flash.array.slice(0, 8)].map((x) => +x.toFixed(4))).toEqual([100, 0.2, 0.7, 30, 100, 0.3, 1, 8])
    expect(ranges(ring.dir)).toEqual([[0, 8]])
    expect(ranges(ring.flash)).toEqual([[0, 8]])
  })

  test('a full ring drops new flashes until the oldest is out', () => {
    const ring = createLightningInstances(4)
    ring.begin(10)
    for (let i = 0; i < 4; i++) expect(ring.write(0, 1, 0, 0, 0.1, 1, 8)).toBe(true)
    expect(ring.write(0, 1, 0, 0, 0.1, 1, 8)).toBe(false)
    ring.flush()
    ring.begin(10 + FLASH_LIFETIME_S - 0.01)
    expect(ring.write(0, 1, 0, 0, 0.1, 1, 8)).toBe(false)
    ring.begin(10 + FLASH_LIFETIME_S + 0.01)
    expect(ring.write(0, 1, 0, 0, 0.1, 1, 8)).toBe(true)
  })

  test('a frame that wraps round the ring uploads two ranges, and three r180 clears them after', () => {
    const ring = createLightningInstances(4)
    const { subData, upload } = fakeUploads()
    // The first upload makes the buffer, whole (the compile gate's draw).
    upload(ring.flash)
    ring.begin(1)
    for (let i = 0; i < 3; i++) ring.write(0, 1, 0, 0, 0.1, 1, 8)
    ring.flush()
    upload(ring.flash)
    ring.begin(2)
    for (let i = 0; i < 3; i++) ring.write(0, 1, 0, 0, 0.1, 1, 8)
    ring.flush()
    expect(ranges(ring.flash)).toEqual([
      [12, 4],
      [0, 8],
    ])
    upload(ring.flash)
    expect(subData).toEqual([
      [0, 12],
      [0, 8],
      [12, 4],
    ])
    expect(ring.flash.updateRanges).toEqual([])
  })

  test('starts are kept near a moving base; a rebase rewrites the ring, lit slots kept', () => {
    const ring = createLightningInstances(4)
    ring.begin(5000)
    ring.write(0, 1, 0, 0, 0.1, 1, 8)
    ring.flush()
    const t = ring.begin(5000 + REBASE_S + 0.2)
    expect(t).toBe(0)
    ring.write(0, 1, 0, 0, 0.1, 1, 8)
    ring.flush()
    // The old flash is long out: unlit. The new one starts at the base.
    expect(ring.flash.array[0]).toBe(DEAD_START_S)
    expect(ring.flash.array[4]).toBe(0)
    // The whole array goes up.
    expect(ring.flash.updateRanges).toEqual([])
    expect(ring.flash.version).toBeGreaterThan(0)
    // A flash lit across the rebase keeps its start, from the new base.
    const across = createLightningInstances(4)
    across.begin(REBASE_S - 0.1)
    across.write(0, 1, 0, 0, 0.1, 1, 8)
    expect(across.begin(REBASE_S + 0.1)).toBe(0)
    expect(across.flash.array[0]).toBeCloseTo(-0.2, 5)
  })

  test('ranges piling up (a View drawing less often) give way to a whole upload', () => {
    const ring = createLightningInstances(64)
    for (let f = 0; f < MAX_RANGES + 2; f++) {
      ring.begin(f)
      ring.write(0, 1, 0, 0, 0.1, 1, 8)
      ring.flush()
    }
    expect(ring.dir.updateRanges.length).toBeLessThanOrEqual(MAX_RANGES)
    expect(ring.dir.updateRanges).toEqual([])
  })
})
