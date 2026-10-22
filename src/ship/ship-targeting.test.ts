import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Body as FlightBody } from './flight'
import {
  createScreenBody,
  cycleTarget,
  edgePoint,
  pickBody,
  projectBody,
  type ScreenBody,
} from './ship-targeting'

const WIDTH = 800
const HEIGHT = 600

// At the origin looking down −Z, as three's cameras do by default.
function camera() {
  const c = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.01, 1000)
  c.updateMatrixWorld()
  return c
}

function body(key: string, x: number, y: number, z: number, radius = 1): FlightBody {
  return { key, position: new THREE.Vector3(x, y, z), radius }
}

function project(bodies: FlightBody[], cam = camera()): ScreenBody[] {
  return bodies.map((b) => projectBody(b, cam, WIDTH, HEIGHT, createScreenBody()))
}

describe('projectBody', () => {
  it('puts a body on the nose at the centre with its angular size', () => {
    const [s] = project([body('a', 0, 0, -10, 1)])
    expect(s.inFront).toBe(true)
    expect(s.x).toBeCloseTo(WIDTH / 2)
    expect(s.y).toBeCloseTo(HEIGHT / 2)
    // tan(asin(0.1)) / tan(30°) × 300 px
    expect(s.radiusPx).toBeCloseTo((300 * Math.tan(Math.asin(0.1))) / Math.tan(Math.PI / 6))
  })

  it('maps right and up to screen right and up', () => {
    const [s] = project([body('a', 2, 2, -10)])
    expect(s.x).toBeGreaterThan(WIDTH / 2)
    expect(s.y).toBeLessThan(HEIGHT / 2)
    expect(s.dirX).toBeGreaterThan(0)
    expect(s.dirY).toBeLessThan(0)
  })

  it('flags bodies behind the camera', () => {
    const [s] = project([body('a', 0, 0, 10)])
    expect(s.inFront).toBe(false)
  })
})

describe('pickBody', () => {
  it('picks a small far body within the minimum radius', () => {
    const screen = project([body('far', 0, 0, -1000, 1)])
    expect(pickBody(screen, WIDTH / 2 + 20, HEIGHT / 2)).toBe('far')
    expect(pickBody(screen, WIDTH / 2 + 30, HEIGHT / 2)).toBeNull()
  })

  it('picks a large body anywhere on its disc plus slop', () => {
    const screen = project([body('big', 0, 0, -5, 2)])
    const r = screen[0].radiusPx
    expect(pickBody(screen, WIDTH / 2 + r + 10, HEIGHT / 2)).toBe('big')
    expect(pickBody(screen, WIDTH / 2 + r + 14, HEIGHT / 2)).toBeNull()
  })

  it('prefers the nearer body when the tap is on both discs', () => {
    const screen = project([body('back', 0, 0, -50, 10), body('front', 0, 0, -5, 1)])
    expect(pickBody(screen, WIDTH / 2, HEIGHT / 2)).toBe('front')
  })

  it('prefers the body whose edge is nearest the tap', () => {
    // Two dots 30 px apart; a tap 10 px from one picks it.
    const cam = camera()
    const screen = project([body('a', 0, 0, -1000, 0.1), body('b', 0, 0, -1000, 0.1)], cam)
    screen[1].x += 30
    expect(pickBody(screen, WIDTH / 2 + 22, HEIGHT / 2)).toBe('b')
    expect(pickBody(screen, WIDTH / 2 + 8, HEIGHT / 2)).toBe('a')
  })

  it('ignores bodies behind the camera', () => {
    const screen = project([body('behind', 0, 0, 10)])
    expect(pickBody(screen, screen[0].x, screen[0].y)).toBeNull()
  })
})

describe('cycleTarget', () => {
  const bodies = [
    body('wide', 10, 0, -10), // 45° off
    body('centre', 0, 0, -10), // on the nose
    body('behind', 0, 0, 10), // 180°
    body('near', 1, 0, -10), // ~6° off
  ]

  it('starts nearest the centre and steps outward, wrapping', () => {
    const cam = camera()
    const seen: (string | null)[] = []
    let current: string | null = null
    for (let i = 0; i < 5; i++) {
      current = cycleTarget(bodies, cam, current)
      seen.push(current)
    }
    expect(seen).toEqual(['centre', 'near', 'wide', 'behind', 'centre'])
  })

  it('restarts from the centre for an unknown target', () => {
    expect(cycleTarget(bodies, camera(), 'pluto')).toBe('centre')
  })

  it('returns null with no bodies', () => {
    expect(cycleTarget([], camera(), null)).toBeNull()
  })
})

describe('edgePoint', () => {
  const inset = { left: 20, top: 20, right: 780, bottom: 580 }

  it('clamps to the bounds along the direction from their centre', () => {
    expect(edgePoint(1, 0, inset)).toEqual({ x: 780, y: 300, angle: 0 })
    const up = edgePoint(0, -1, inset)
    expect(up.x).toBeCloseTo(400)
    expect(up.y).toBeCloseTo(20)
    expect(up.angle).toBeCloseTo(-Math.PI / 2)
    const corner = edgePoint(1, 1, inset)
    expect(corner.y).toBeCloseTo(580)
    expect(corner.x).toBeCloseTo(680)
  })

  it('keeps below a raised top edge', () => {
    const up = edgePoint(0.2, -1, { ...inset, top: 120 })
    expect(up.y).toBeCloseTo(120)
    expect(up.x).toBeGreaterThan(400)
  })

  it('points down for a target dead astern', () => {
    const p = edgePoint(0, 0, inset)
    expect(p.y).toBeCloseTo(580)
    expect(p.angle).toBeCloseTo(Math.PI / 2)
  })
})
