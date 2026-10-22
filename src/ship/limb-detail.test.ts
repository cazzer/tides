import { afterEach, describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP } from '../cloud-layer'
import { ATMOSPHERE_OUTER } from '../renderers/earth-shells'
import { collisionRadius } from './flight'
import { createShipBodies, EARTH_COLLISION_RADIUS, EARTH_RADIUS } from './ship-bodies'
import { SHIP_FOV } from './ship-session'
import {
  LIMB_SEGMENTS,
  limbFacetPx,
  limbBody,
  disposeLimbSpheres,
  limbSphere,
  retainLimbSphere,
  setLimbBody,
  subscribeLimbBody,
} from './limb-detail'

// The bead's yardstick: a retina laptop, 1600 px tall.
const SCREEN_PX = 1600
// limbFacetPx is at the screen's centre; a 16:10 screen's corner stretches a
// radial step by 1 / cos² of its angle off the axis.
const CORNER = 1 + (1 + 1.6 ** 2) * Math.tan((SHIP_FOV / 2) * (Math.PI / 180)) ** 2
// Headless facets ran up to this much above the estimate (3.3 px vs 2.6 px).
const MEASURED = 1.3
const cornerPx = (eyeOverR: number) =>
  MEASURED * CORNER * limbFacetPx(LIMB_SEGMENTS, eyeOverR, SCREEN_PX, SHIP_FOV)

describe('limbFacetPx', () => {
  it('tracks the facets measured at 1.02 R (headless, 1600 px tall)', () => {
    // Against a 2048×1024 reference, at most 2.8–3.3 px (Mercury, Moon,
    // Mars at 128²) and 15.7 px (Ganymede at 64×32): the estimate runs up to
    // ~1.3× low.
    expect(limbFacetPx([128, 128], 1.02, SCREEN_PX, SHIP_FOV)).toBeCloseTo(2.6, 1)
    expect(limbFacetPx([64, 32], 1.02, SCREEN_PX, SHIP_FOV)).toBeCloseTo(16.1, 1)
  })

  it('falls with the square of the segment count', () => {
    const coarse = limbFacetPx([128, 64], 1.02, SCREEN_PX, SHIP_FOV)
    const fine = limbFacetPx([256, 128], 1.02, SCREEN_PX, SHIP_FOV)
    expect(coarse / fine).toBeCloseTo(4, 1)
  })
})

describe('LIMB_SEGMENTS', () => {
  it('keeps every body’s limb under 1 px at its collision stop, even in a corner', () => {
    for (const body of createShipBodies()) {
      expect(cornerPx(collisionRadius(body) / body.radius), body.key).toBeLessThan(1)
    }
  })

  it('keeps Earth’s outer shells under 1 px too, each in its own radii', () => {
    for (const shell of [
      EARTH_RADIUS + CLOUD_LAYER_TOP,
      EARTH_RADIUS + CLOUD_FLAT_ALTITUDE,
      EARTH_RADIUS * ATMOSPHERE_OUTER,
    ]) {
      expect(cornerPx(EARTH_COLLISION_RADIUS / shell), String(shell)).toBeLessThan(1)
    }
  })
})

describe('the limb body', () => {
  afterEach(() => setLimbBody(null))

  it('tells its listeners only when it changes', () => {
    let calls = 0
    const unsubscribe = subscribeLimbBody(() => calls++)
    setLimbBody('mars')
    setLimbBody('mars')
    expect(limbBody()).toBe('mars')
    expect(calls).toBe(1)
    setLimbBody(null)
    expect(calls).toBe(2)
    unsubscribe()
    setLimbBody('venus')
    expect(calls).toBe(2)
  })
})

describe('the limb spheres', () => {
  afterEach(() => disposeLimbSpheres())

  const watch = (sphere: THREE.BufferGeometry) => {
    const state = { disposed: false }
    sphere.addEventListener('dispose', () => (state.disposed = true))
    return state
  }

  it('builds one LIMB_SEGMENTS sphere per radius and reuses it', () => {
    const sphere = limbSphere(10)
    expect(limbSphere(10)).toBe(sphere)
    expect(sphere.parameters).toMatchObject({ radius: 10, widthSegments: 512, heightSegments: 256 })
  })

  it('never disposes a sphere on screen, however many are cached', () => {
    const shown = limbSphere(1)
    const release = retainLimbSphere(1, shown)
    const watched = watch(shown)
    const others = [2, 3, 4, 5, 6].map((r) => watch(limbSphere(r)))
    const other = retainLimbSphere(7, limbSphere(7))
    other()
    expect(watched.disposed).toBe(false)
    // Five unretained beside the shown one: the oldest three go.
    expect(others.map((o) => o.disposed)).toEqual([true, true, true, false, false])
    release()
  })

  it('disposes the least recently used first', () => {
    const [ten, eleven] = [watch(limbSphere(10)), watch(limbSphere(11))]
    limbSphere(12)
    limbSphere(13)
    limbSphere(10)
    retainLimbSphere(14, limbSphere(14))()
    expect(eleven.disposed).toBe(true)
    expect(ten.disposed).toBe(false)
  })

  it('all go when ship mode ends', () => {
    const sphere = limbSphere(10)
    const watched = watch(sphere)
    disposeLimbSpheres()
    expect(watched.disposed).toBe(true)
    expect(limbSphere(10)).not.toBe(sphere)
  })
})
