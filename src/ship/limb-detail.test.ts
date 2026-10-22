import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP } from '../cloud-layer'
import { ATMOSPHERE_OUTER } from '../renderers/earth-shells'
import { collisionRadius, type Body } from './flight'
import { createShipBodies, EARTH_COLLISION_RADIUS, EARTH_RADIUS } from './ship-bodies'
import { FLIGHT_UNITS_PER_AU } from '../flight-scale'
import { SHIP_FOV } from './ship-session'
import {
  LIMB_FACET_PX,
  LIMB_SEGMENTS,
  builtLimbSphere,
  clearLimbView,
  limbFacetPx,
  limbBody,
  disposeLimbSpheres,
  limbSphere,
  requestLimbSphere,
  retainLimbSphere,
  subscribeLimbBody,
  updateLimbView,
  wantsLimbSphere,
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

const body = (key: string, x = 0, radius = 1): Body => ({ key, position: new THREE.Vector3(x, 0, 0), radius })
const eyeAt = (x: number) => new THREE.Vector3(x, 0, 0)
const view = (key: string, bodies: Body[], x: number) => updateLimbView(key, bodies, eyeAt(x), SCREEN_PX, SHIP_FOV)

describe('the limb view', () => {
  afterEach(() => clearLimbView())

  it('tells its listeners only when the gap moves past the hysteresis', () => {
    let calls = 0
    const unsubscribe = subscribeLimbBody(() => calls++)
    const mars = [body('mars')]
    view('mars', mars, 1.5)
    view('mars', mars, 1.51)
    expect(limbBody()).toBe('mars')
    expect(calls).toBe(1)
    view('mars', mars, 1.6)
    expect(calls).toBe(2)
    clearLimbView()
    clearLimbView()
    expect(limbBody()).toBe(null)
    expect(calls).toBe(3)
    unsubscribe()
    view('mars', mars, 1.5)
    expect(calls).toBe(3)
  })

  it('holds the limb body until another is clearly nearer', () => {
    const pair = [body('planet'), body('moon', 10)]
    view('planet', pair, 4.9)
    // Just past the midpoint: the moon is nearest, by 2.5%.
    view('moon', pair, 5.05)
    expect(limbBody()).toBe('planet')
    view('moon', pair, 5.3)
    expect(limbBody()).toBe('moon')
  })

  it('clears with no nearest body', () => {
    view('mars', [body('mars')], 2)
    updateLimbView(null, [body('mars')], eyeAt(2), SCREEN_PX, SHIP_FOV)
    expect(limbBody()).toBe(null)
  })
})

describe('wantsLimbSphere', () => {
  afterEach(() => clearLimbView())
  const base = [128, 128] as const

  it('wants the limb sphere only once the base facets pass LIMB_FACET_PX', () => {
    const earth = [body('earth')]
    for (const x of [1.02, 1.2, 1.4, 1.5, 2, 4]) {
      view('earth', earth, x)
      expect(wantsLimbSphere('earth', 1, base), String(x)).toBe(
        limbFacetPx(base, x, SCREEN_PX, SHIP_FOV) > LIMB_FACET_PX
      )
    }
    view('earth', earth, 1.02)
    expect(wantsLimbSphere('earth', 1, base)).toBe(true)
    view('earth', earth, 4)
    expect(wantsLimbSphere('earth', 1, base)).toBe(false)
  })

  it('wants nothing for other bodies, or for a shell seen from inside', () => {
    view('venus', [body('venus')], 1.02)
    expect(wantsLimbSphere('mars', 1, base)).toBe(false)
    expect(wantsLimbSphere('venus', 1.05, [96, 48])).toBe(false)
    expect(wantsLimbSphere('venus', 1, base)).toBe(true)
  })

  it('leaves the Sun its own sphere mid-cruise', () => {
    const bodies = createShipBodies()
    const sun = bodies.find((b) => b.key === 'sun')!
    updateLimbView('sun', bodies, eyeAt(0.5 * FLIGHT_UNITS_PER_AU), SCREEN_PX, SHIP_FOV)
    expect(wantsLimbSphere('sun', sun.radius, base)).toBe(false)
  })
})

describe('the limb spheres', () => {
  afterEach(() => disposeLimbSpheres())

  const watch = (sphere: THREE.BufferGeometry) => {
    const state = { disposed: false }
    sphere.addEventListener('dispose', () => (state.disposed = true))
    return state
  }

  // As a SphereGeometry of its own would be, up to float rounding.
  const expectLimbSphere = (sphere: THREE.BufferGeometry | null, radius: number) => {
    const own = new THREE.SphereGeometry(radius, ...LIMB_SEGMENTS)
    for (const name of ['position', 'normal', 'uv']) {
      const [ours, theirs] = [sphere!.getAttribute(name).array, own.getAttribute(name).array]
      expect(ours.length, name).toBe(theirs.length)
      const worst = Array.from(ours).reduce((max, v, i) => Math.max(max, Math.abs(v - theirs[i])), 0)
      expect(worst, name).toBeLessThan(1e-6 * radius)
    }
    expect(Array.from(sphere!.index!.array)).toEqual(Array.from(own.index!.array))
  }

  it('builds one LIMB_SEGMENTS sphere per radius and reuses it', () => {
    const sphere = limbSphere(10)
    expect(limbSphere(10)).toBe(sphere)
    expectLimbSphere(sphere, 10)
  })

  it('shares one topology between radii, each owning only its positions', () => {
    const [a, b] = [limbSphere(10), limbSphere(1)]
    expectLimbSphere(b, 1)
    expect(b.index).toBe(a.index)
    expect(b.getAttribute('normal')).toBe(a.getAttribute('normal'))
    expect(b.getAttribute('uv')).toBe(a.getAttribute('uv'))
    expect(b.getAttribute('position')).not.toBe(a.getAttribute('position'))
  })

  // What three frees when a geometry is disposed (WebGLGeometries).
  const freed = new Set<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>()
  const freesOnDispose = (sphere: THREE.BufferGeometry) =>
    sphere.addEventListener('dispose', () => {
      if (sphere.index) freed.add(sphere.index)
      Object.values(sphere.attributes).forEach((attribute) => freed.add(attribute))
    })

  it('frees the shared topology with a trimmed sphere when no other was shown', () => {
    freed.clear()
    const drawn = limbSphere(1)
    const release = retainLimbSphere(1, drawn)
    freesOnDispose(drawn)
    const shared = [drawn.index!, drawn.getAttribute('normal'), drawn.getAttribute('uv')]
    const unshown = [2, 3, 4, 5].map((r) => limbSphere(r))
    release()
    // Over the cache: the drawn one goes first, taking the topology the
    // never-drawn others couldn't free; they'd upload it afresh.
    expect(builtLimbSphere(1)).toBe(null)
    shared.forEach((attribute) => expect(freed.has(attribute)).toBe(true))
    expect(unshown[0].index).toBe(shared[0])
  })

  it('frees the shared topology only once no shown sphere needs it', () => {
    freed.clear()
    const kept = limbSphere(1)
    const release = retainLimbSphere(1, kept)
    const shared = [kept.index!, kept.getAttribute('normal'), kept.getAttribute('uv')]
    const trimmed = [2, 3, 4, 5, 6].map((r) => limbSphere(r))
    trimmed.forEach(freesOnDispose)
    retainLimbSphere(7, limbSphere(7))()
    // The trimmed three freed their positions alone; the rest still draw.
    expect(freed.size).toBe(3)
    trimmed.slice(0, 3).forEach((sphere) => expect(freed.has(sphere.getAttribute('position'))).toBe(true))
    shared.forEach((attribute) => expect(freed.has(attribute)).toBe(false))
    expect(kept.index).toBe(shared[0])
    release()
    freesOnDispose(kept)
    disposeLimbSpheres()
    shared.forEach((attribute) => expect(freed.has(attribute)).toBe(true))
    expect(limbSphere(1).index).not.toBe(shared[0])
  })

  it('gives a disposed sphere its topology back if it is shown again', () => {
    const sphere = limbSphere(2)
    ;[3, 4, 5, 6].forEach((r) => limbSphere(r))
    retainLimbSphere(7, limbSphere(7))()
    expect(sphere.index).toBe(null)
    const release = retainLimbSphere(2, sphere)
    expect(sphere.index).toBe(limbSphere(7).index)
    expect(sphere.getAttribute('normal')).toBe(limbSphere(7).getAttribute('normal'))
    release()
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

  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('builds requested spheres later, off the frame, and says when', async () => {
    let calls = 0
    const unsubscribe = subscribeLimbBody(() => calls++)
    requestLimbSphere(20)
    requestLimbSphere(20)
    expect(builtLimbSphere(20)).toBe(null)
    await nextTask()
    const sphere = builtLimbSphere(20)
    expectLimbSphere(sphere, 20)
    expect(calls).toBe(1)
    requestLimbSphere(20)
    await nextTask()
    expect(builtLimbSphere(20)).toBe(sphere)
    expect(calls).toBe(1)
    unsubscribe()
  })

  it('drops a queued build once nothing wants it', async () => {
    const first = requestLimbSphere(22)
    const second = requestLimbSphere(22)
    first()
    first()
    await nextTask()
    const sphere = builtLimbSphere(22)
    expect(sphere).not.toBe(null)
    let calls = 0
    const unsubscribe = subscribeLimbBody(() => calls++)
    requestLimbSphere(23)()
    second()
    await nextTask()
    expect(builtLimbSphere(23)).toBe(null)
    expect(calls).toBe(0)
    unsubscribe()
  })

  it('drops queued builds when ship mode ends', async () => {
    requestLimbSphere(21)
    disposeLimbSpheres()
    await nextTask()
    expect(builtLimbSphere(21)).toBe(null)
  })

  it('all go when ship mode ends', () => {
    const sphere = limbSphere(10)
    const watched = watch(sphere)
    disposeLimbSpheres()
    expect(watched.disposed).toBe(true)
    expect(limbSphere(10)).not.toBe(sphere)
  })
})
