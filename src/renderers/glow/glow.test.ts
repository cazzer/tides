import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  GLOW_LEVELS,
  glowCompositeRect,
  glowLevelSizes,
  glowTargetSize,
  resolveGlow,
  sphereScreenBox,
  viewViewport,
} from './glow'

describe('resolveGlow', () => {
  it('is on for the high tier and off for the low tier by default', () => {
    expect(resolveGlow('', 'high')).toBe(true)
    expect(resolveGlow('', 'low')).toBe(false)
  })
  it('lets ?glow= force it either way', () => {
    expect(resolveGlow('?glow=0', 'high')).toBe(false)
    expect(resolveGlow('?glow=1', 'low')).toBe(true)
    expect(resolveGlow('?glow=maybe', 'low')).toBe(false)
  })
})

describe('glowTargetSize', () => {
  it('is half the View, rounded up, at least 1 px', () => {
    expect(glowTargetSize({ width: 3024, height: 1720 })).toEqual({ width: 1512, height: 860 })
    expect(glowTargetSize({ width: 781, height: 3 })).toEqual({ width: 391, height: 2 })
    expect(glowTargetSize({ width: 0, height: 0 })).toEqual({ width: 1, height: 1 })
  })
})

describe('glowLevelSizes', () => {
  it('halves from half the target, up to the level count', () => {
    const sizes = glowLevelSizes({ width: 1512, height: 860 })
    expect(sizes).toHaveLength(GLOW_LEVELS)
    expect(sizes[0]).toEqual({ width: 756, height: 430 })
    expect(sizes[1]).toEqual({ width: 378, height: 215 })
    expect(sizes[4]).toEqual({ width: 48, height: 27 })
  })
  it('stops before a side drops under the minimum', () => {
    expect(glowLevelSizes({ width: 40, height: 20 })).toEqual([
      { width: 20, height: 10 },
      { width: 10, height: 5 },
    ])
    expect(glowLevelSizes({ width: 6, height: 6 })).toEqual([])
  })
})

describe('viewViewport', () => {
  const canvas = { left: 0, top: 0, width: 1440, height: 900 }
  it('measures the bottom from the canvas foot, as drei does', () => {
    expect(viewViewport(canvas, { left: 0, top: 0, width: 960, height: 900 })).toEqual({
      left: 0,
      bottom: 0,
      width: 960,
      height: 900,
    })
    expect(viewViewport(canvas, { left: 960, top: 0, width: 480, height: 450 })).toEqual({
      left: 960,
      bottom: 450,
      width: 480,
      height: 450,
    })
  })
  it('allows for a canvas that is offset on the page', () => {
    expect(viewViewport({ left: 10, top: 20, width: 100, height: 100 }, { left: 10, top: 70, width: 100, height: 50 })).toEqual({
      left: 0,
      bottom: 0,
      width: 100,
      height: 50,
    })
  })
  it('is null for an empty or off-canvas View', () => {
    expect(viewViewport(canvas, { left: 0, top: 0, width: 0, height: 900 })).toBeNull()
    expect(viewViewport(canvas, { left: 1500, top: 0, width: 100, height: 100 })).toBeNull()
    expect(viewViewport(canvas, { left: 0, top: 950, width: 100, height: 100 })).toBeNull()
  })
})

describe('sphereScreenBox', () => {
  const camera = new THREE.PerspectiveCamera(50, 390 / 643, 0.1, 1000)
  camera.updateProjectionMatrix()
  const view = { width: 390, height: 643 }
  const project = (p: THREE.Vector3) => {
    const ndc = p.clone().applyMatrix4(camera.projectionMatrix)
    return { x: (ndc.x * 0.5 + 0.5) * view.width, y: (ndc.y * 0.5 + 0.5) * view.height }
  }
  // The silhouette: every surface point's projection, sampled densely.
  const silhouette = (centre: THREE.Vector3, radius: number) => {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    for (let i = 0; i <= 180; i++)
      for (let j = 0; j < 360; j++) {
        const th = (i * Math.PI) / 180
        const ph = (j * Math.PI) / 180
        const p = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)).multiplyScalar(radius).add(centre)
        const s = project(p)
        b.x0 = Math.min(b.x0, s.x)
        b.x1 = Math.max(b.x1, s.x)
        b.y0 = Math.min(b.y0, s.y)
        b.y1 = Math.max(b.y1, s.y)
      }
    return b
  }

  it('bounds the projected sphere tightly, on and off axis', () => {
    for (const [x, y, z, r] of [
      [0, 0, -10, 1],
      [6, -3, -10, 2],
      [-9, 7, -8, 3],
      [2, 1, -3.2, 3],
    ]) {
      const centre = new THREE.Vector3(x, y, z)
      const box = { x0: 0, y0: 0, x1: 0, y1: 0 }
      expect(sphereScreenBox(centre, r, camera.projectionMatrix.elements, view, box)).toBe(true)
      const s = silhouette(centre, r)
      // Contains every sampled point and is no more than a sampling step wider.
      const slack = Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.002 + 0.01
      expect(box.x0).toBeLessThanOrEqual(s.x0 + 1e-6)
      expect(box.y0).toBeLessThanOrEqual(s.y0 + 1e-6)
      expect(box.x1).toBeGreaterThanOrEqual(s.x1 - 1e-6)
      expect(box.y1).toBeGreaterThanOrEqual(s.y1 - 1e-6)
      expect(s.x0 - box.x0).toBeLessThan(slack)
      expect(box.x1 - s.x1).toBeLessThan(slack)
      expect(s.y0 - box.y0).toBeLessThan(slack)
      expect(box.y1 - s.y1).toBeLessThan(slack)
    }
  })
  it('is unbounded once the sphere reaches the eye plane', () => {
    const box = { x0: 0, y0: 0, x1: 0, y1: 0 }
    expect(sphereScreenBox({ x: 0, y: 0, z: -1 }, 1, camera.projectionMatrix.elements, view, box)).toBe(false)
    expect(sphereScreenBox({ x: 0, y: 0, z: 5 }, 1, camera.projectionMatrix.elements, view, box)).toBe(false)
  })
})

describe('glowCompositeRect', () => {
  const viewport = { left: 10, bottom: 20, width: 390, height: 643 }
  const rect = (box: Parameters<typeof glowCompositeRect>[0], margin: number) => {
    const out = { left: 0, bottom: 0, width: 0, height: 0 }
    return glowCompositeRect(box, margin, viewport, out) ? out : null
  }
  it('grows the box by the margin, clamped to the View', () => {
    expect(rect({ x0: 100.5, y0: 200, x1: 150, y1: 260.2 }, 50)).toEqual({ left: 60, bottom: 170, width: 150, height: 161 })
    expect(rect({ x0: -500, y0: -10, x1: 900, y1: 700 }, 50)).toEqual(viewport)
    expect(rect('all', 50)).toEqual(viewport)
  })
  it('is empty when the grown box misses the View', () => {
    expect(rect({ x0: -300, y0: 10, x1: -60, y1: 20 }, 50)).toBeNull()
    expect(rect({ x0: 100, y0: 700, x1: 120, y1: 800 }, 50)).toBeNull()
  })
})
