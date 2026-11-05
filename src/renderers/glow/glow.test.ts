import { describe, expect, it } from 'vitest'
import { GLOW_LEVELS, glowLevelSizes, glowTargetSize, resolveGlow, viewViewport } from './glow'

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
