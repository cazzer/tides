import { describe, expect, it } from 'vitest'
import { surfaceGrabRotateSpeed } from './camera'

describe('surfaceGrabRotateSpeed', () => {
  it('turns the globe by the cursor travel over the radius when close', () => {
    const worldPerPixel = 1 / 100
    const domHeight = 842
    const radius = 2.95
    const speed = surfaceGrabRotateSpeed(worldPerPixel, domHeight, radius)
    const radPerPixel = (2 * Math.PI * speed) / domHeight
    expect(radPerPixel).toBeCloseTo(worldPerPixel / radius, 12)
  })

  it('keeps the default speed when far away', () => {
    expect(surfaceGrabRotateSpeed(1 / 10, 842, 2.95)).toBe(1)
  })
})
