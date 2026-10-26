import { describe, expect, it } from 'vitest'
import { MathUtils, Vector3 } from 'three'
import {
  MAIN_DISTANCE,
  MAIN_FOV,
  MAIN_ZOOM,
  PLANETS_STAR_RADIUS,
  REFERENCE_VIEW_HEIGHT,
  NEAR_MIN,
  allowDistance,
  easeDistance,
  focusedRef,
  followMotion,
  framingDistance,
  mainNearFar,
  mainViewRange,
  minDistance,
  nearReach,
  nearestSurface,
  planetFramingZoom,
  stepEyeDistance,
  stepFocusDistance,
  turnTarget,
  systemFitDistance,
  targetUnitsPerPixel,
  zoomDistance,
} from './main-view'
import { CLOCK_VIEW } from './clock-view'
import { CLOUD_UNITS_PER_KM } from './cloud-layer'
import { EARTH_ORBIT_RADIUS } from './ephemeris'
import { CLOCK_HALF_WIDTH } from './clock-size'
import { PLANETS, sceneDistance } from './planets'
import { KUIPER_A_AU } from './system-aids/belt-particles'
import { FOCUS_VALUES, isSystemFocus, type CameraFocus } from './store'
import { bodyRadius } from './system-aids/label-visibility'

describe('planetFramingZoom', () => {
  const EARTH = 2.95

  it('frames a planet the size of Earth at the default zoom', () => {
    expect(planetFramingZoom(EARTH, EARTH)).toBeCloseTo(MAIN_ZOOM, 12)
  })

  it('keeps zoom times radius equal to Earth at the default zoom', () => {
    expect(planetFramingZoom(6.5, EARTH) * 6.5).toBeCloseTo(MAIN_ZOOM * EARTH, 9)
    expect(planetFramingZoom(1.5, EARTH) * 1.5).toBeCloseTo(MAIN_ZOOM * EARTH, 9)
  })

  it('clamps very small and very large radii', () => {
    expect(planetFramingZoom(0.01, EARTH)).toBe(40)
    expect(planetFramingZoom(1000, EARTH)).toBe(1)
  })
})

const DESKTOP = { width: 1167, height: 830 }
const PHONE = { width: 390, height: 844 }
const TAN_HALF_FOV = Math.tan(((MAIN_FOV / 2) * Math.PI) / 180)
const EARTH = bodyRadius('earth')

// A sphere's radius on screen, CSS px, at `distance` in a view `height` tall.
const radiusPx = (radius: number, distance: number, height: number) =>
  ((radius / distance) * (height / 2)) / TAN_HALF_FOV

describe('zoomDistance and framingDistance', () => {
  it('frames Earth as large as the ortho view did at the default zoom', () => {
    expect(framingDistance(EARTH, EARTH)).toBeCloseTo(MAIN_DISTANCE, 9)
    expect(radiusPx(EARTH, MAIN_DISTANCE, REFERENCE_VIEW_HEIGHT)).toBeCloseTo(
      EARTH * MAIN_ZOOM,
      9
    )
    expect(radiusPx(EARTH, MAIN_DISTANCE, REFERENCE_VIEW_HEIGHT)).toBeCloseTo(29.5, 1)
  })

  it('frames each planet as large as Earth, within the zoom clamps', () => {
    for (const { key, radius } of Object.values(PLANETS)) {
      expect(radius / framingDistance(radius, EARTH), key).toBeCloseTo(
        EARTH / MAIN_DISTANCE,
        9
      )
    }
  })

  it('spans the old zoom’s units per pixel at the target', () => {
    for (const zoom of [1, MAIN_ZOOM, 40]) {
      expect(
        targetUnitsPerPixel(zoomDistance(zoom), REFERENCE_VIEW_HEIGHT)
      ).toBeCloseTo(1 / zoom, 12)
    }
  })
})

const SYSTEM_FOCI = FOCUS_VALUES.filter(
  (focus): focus is Exclude<CameraFocus, 'clock' | 'location'> =>
    focus !== 'clock' && focus !== 'location'
)

describe('minDistance', () => {
  it('lets every focus reach its framing, and the framing stay in range', () => {
    const { maxDistance } = mainViewRange(true, DESKTOP)
    for (const focus of SYSTEM_FOCI) {
      const framing = isSystemFocus(focus)
        ? framingDistance(bodyRadius(focus), EARTH)
        : MAIN_DISTANCE
      expect(framing, focus).toBeGreaterThan(minDistance(focus))
      expect(framing, focus).toBeLessThan(maxDistance)
    }
    expect(CLOCK_VIEW.distance).toBeGreaterThan(minDistance('clock'))
  })

  it('keeps the eye outside the focused body, its shells and its rings', () => {
    for (const focus of SYSTEM_FOCI) {
      expect(minDistance(focus), focus).toBeGreaterThan(nearReach(focus))
    }
    const saturn = PLANETS.saturn
    expect(minDistance('saturn')).toBeGreaterThan(saturn.radius * saturn.rings!.outer)
    // From a target on Earth's surface, straight above it.
    expect(minDistance('location') - EARTH).toBeCloseTo(minDistance('earth'), 12)
    expect(minDistance('clock')).toBe(2 * CLOCK_HALF_WIDTH)
  })
})

const NEPTUNE_APHELION = sceneDistance(30.4)

/** The angle from the view axis to the far edge of a sphere, for an eye looking at `target`. */
function edgeAngle(eye: Vector3, target: Vector3, centre: Vector3, radius: number) {
  const toCentre = centre.clone().sub(eye)
  return (
    toCentre.angleTo(target.clone().sub(eye)) + Math.asin(radius / toCentre.length())
  )
}

describe('mainViewRange', () => {
  it('leaves the planets-off view exactly as it was', () => {
    for (const view of [DESKTOP, PHONE]) {
      expect(mainViewRange(false, view)).toEqual({
        maxDistance: Infinity,
        starRadius: undefined,
      })
    }
  })

  it('shows Neptune across the Sun from an Earth target at the distance limit', () => {
    const earth = new Vector3(EARTH_ORBIT_RADIUS, 0, 0)
    const neptune = new Vector3(-NEPTUNE_APHELION, 0, 0)
    // Looking at Earth square to the Sun line, from above and from the side.
    const across = [new Vector3(0, 1, 0), new Vector3(0, 0, 1)]
    for (const view of [DESKTOP, PHONE, { width: 844, height: 390 }]) {
      const { maxDistance } = mainViewRange(true, view)
      const narrower = Math.atan(TAN_HALF_FOV * Math.min(1, view.width / view.height))
      for (const direction of across) {
        const eye = earth.clone().addScaledVector(direction, maxDistance)
        expect(
          edgeAngle(eye, earth, neptune, PLANETS.neptune.radius),
          `${view.width}x${view.height}`
        ).toBeLessThan(narrower)
      }
    }
    expect(systemFitDistance(PHONE)).toBeGreaterThan(systemFitDistance(DESKTOP))
  })
})

describe('mainNearFar', () => {
  // 24-bit depth resolution, scene units, `depth` in front of the eye.
  const depthStep = (near: number, far: number, depth: number) =>
    (depth * depth * (far - near)) / (far * near * 2 ** 24)

  it('keeps the near plane short of the nearest surface down to 2 · NEAR_MIN', () => {
    for (let surface = 2 * NEAR_MIN; surface < 1e4; surface *= 1.1) {
      const { near } = mainNearFar(surface, 0)
      expect(near).toBeLessThan(surface)
    }
  })

  it('holds at NEAR_MIN closer in, cutting a body that close to the eye', () => {
    expect(mainNearFar(NEAR_MIN, 0).near).toBe(NEAR_MIN)
    expect(mainNearFar(0, 0).near).toBe(NEAR_MIN)
    expect(mainNearFar(-1, 0).near).toBe(NEAR_MIN)
  })

  it('takes in the far side of the Kuiper belt from a phone zoomed out on Neptune', () => {
    const { maxDistance, starRadius } = mainViewRange(true, PHONE)
    const neptune = new Vector3(-NEPTUNE_APHELION, 0, 0)
    // Looking back across the Sun at Neptune, as far out as the phone goes.
    const eye = neptune.clone().add(new Vector3(-maxDistance, 0, 0))
    const kuiperEdge = new Vector3(sceneDistance(KUIPER_A_AU[1]), 0, 0)
    const { far } = mainNearFar(maxDistance, eye.length())
    expect(eye.distanceTo(kuiperEdge)).toBeLessThan(far)
    // The starfield is centred on the eye.
    expect(far).toBeGreaterThan(starRadius!)
    expect(mainNearFar(1, 0).far).toBeGreaterThan(PLANETS_STAR_RADIUS)
  })

  it('resolves 10 m of cloud height at an Earth close-up', () => {
    const tenMetres = CLOUD_UNITS_PER_KM / 100
    const atmosphere = nearReach('earth')
    // Straight down at the closest distance...
    const eye = minDistance('earth')
    const down = mainNearFar(eye - atmosphere, EARTH_ORBIT_RADIUS)
    expect(depthStep(down.near, down.far, eye - EARTH)).toBeLessThan(tenMetres)
    // ...and tilted all the way, to ~1.115 radii, looking at the horizon.
    const tilted = 1.115 * EARTH
    const horizon = Math.sqrt(tilted ** 2 - EARTH ** 2)
    const flat = mainNearFar(tilted - atmosphere, EARTH_ORBIT_RADIUS)
    expect(depthStep(flat.near, flat.far, horizon)).toBeLessThan(tenMetres)
  })

  it('writes into the object it is given', () => {
    const out = { near: 0, far: 0 }
    expect(mainNearFar(4, 100, out)).toBe(out)
  })
})

describe('nearestSurface', () => {
  const eye = new Vector3(0, 0, 0)
  const body = (x: number, reach: number) => ({ centre: new Vector3(x, 0, 0), reach })

  it('measures to the nearest reach, or the target if nearer', () => {
    const bodies = [body(10, 2), body(-6, 3), body(1, 0)]
    expect(nearestSurface(eye, new Vector3(0, 50, 0), bodies)).toBe(3)
    expect(nearestSurface(eye, new Vector3(0, 2, 0), bodies)).toBe(2)
  })

  it('skips a body that is not there', () => {
    expect(nearestSurface(eye, new Vector3(0, 50, 0), [body(1, 0)])).toBe(50)
  })

  it('goes negative inside a reach', () => {
    expect(nearestSurface(eye, new Vector3(0, 50, 0), [body(1, 3)])).toBe(-2)
  })
})

describe('easeDistance', () => {
  it('lands on the goal from either side without overshooting', () => {
    for (const [from, goal] of [[3.98, 149.3], [1e5, 2048], [331, 149.3]]) {
      let distance = from
      let frames = 0
      while (distance !== goal && frames < 1000) {
        const next = easeDistance(distance, goal)
        expect(Math.sign(goal - next) * Math.sign(goal - from)).toBeGreaterThanOrEqual(0)
        distance = next
        frames++
      }
      expect(distance).toBe(goal)
      expect(frames).toBeLessThan(250)
    }
  })

  it('jumps to the goal from a distance of 0, where there is no ratio', () => {
    expect(easeDistance(0, 10)).toBe(10)
  })

  it('changes the apparent size by the same small share each frame', () => {
    // 5% of the remaining ratio: from 50x too far, ~18% a frame, not a jump.
    const next = easeDistance(1e5, 2048)
    expect(1e5 / next).toBeCloseTo((1e5 / 2048) ** 0.05, 9)
    expect(1e5 / next).toBeLessThan(1.25)
    expect(easeDistance(3.98, 149.3) / 3.98).toBeLessThan(1.25)
  })
})

// The part of OrbitControls stepEyeDistance drives, clamping as it does.
function dolly(distance: number, minDistance = 0, maxDistance = Infinity) {
  return {
    distance,
    minDistance,
    maxDistance,
    getDistance() {
      return this.distance
    },
    setScale(scale: number) {
      this.distance = MathUtils.clamp(
        this.distance * scale,
        this.minDistance,
        this.maxDistance
      )
    },
  }
}

describe('stepEyeDistance', () => {
  it('eases into a raised minDistance rather than jumping there', () => {
    // An Earth close-up when the Sun is chosen.
    const controls = dolly(minDistance('earth'), minDistance('earth'))
    const lo = minDistance('sun')
    let previous = controls.distance
    for (let frame = 0; frame < 300; frame++) {
      stepEyeDistance(controls, null, lo, 2048)
      expect(controls.distance / previous).toBeLessThan(1.07)
      expect(controls.minDistance).toBeLessThanOrEqual(controls.distance)
      previous = controls.distance
    }
    expect(controls.distance).toBeCloseTo(lo, 9)
    expect(controls.minDistance).toBe(lo)
  })

  it('eases into a lowered maxDistance, e.g. planets turned on far out', () => {
    const controls = dolly(1e5)
    const hi = systemFitDistance(DESKTOP)
    let previous = controls.distance
    for (let frame = 0; frame < 300; frame++) {
      stepEyeDistance(controls, null, 1, hi)
      expect(previous / controls.distance).toBeLessThan(1.25)
      previous = controls.distance
    }
    expect(controls.distance).toBeCloseTo(hi, 9)
    expect(controls.maxDistance).toBe(hi)
  })

  it('leaves a distance in range where it is', () => {
    const controls = dolly(100, 0, 0)
    expect(stepEyeDistance(controls, null, 10, 1000)).toBe(false)
    expect(controls.distance).toBe(100)
    expect([controls.minDistance, controls.maxDistance]).toEqual([10, 1000])
  })

  it('reports landing on the framing, kept within range', () => {
    const controls = dolly(MAIN_DISTANCE)
    const frames = []
    for (let frame = 0; frame < 300; frame++) {
      if (stepEyeDistance(controls, 5000, 1, 2048)) frames.push(frame)
    }
    expect(frames.length).toBeGreaterThan(0)
    expect(controls.distance).toBeCloseTo(2048, 9)
  })
})

describe('stepFocusDistance', () => {
  const focus = new Vector3(100, 0, 0)
  const anchor = { key: 'mars' as unknown, position: focus, speed: 0 }
  const at = (target: Vector3, distance: number) =>
    Object.assign(dolly(distance), { target })

  it('neither frames nor pushes while the target is on its way', () => {
    const controls = at(new Vector3(50, 0, 0), 3)
    expect(stepFocusDistance(controls, anchor, 300, 10, 2048)).toBe(false)
    expect(controls.distance).toBe(3)
    expect(controls.minDistance).toBe(3)
  })

  it('counts a target trailing a moving body as arrived', () => {
    // 1 unit a frame trails ~19 behind; that much allowance and more still frames.
    const moving = { ...anchor, speed: 1 }
    const controls = at(new Vector3(70, 0, 0), 100)
    stepFocusDistance(controls, moving, 300, 10, 2048)
    expect(controls.distance).toBeGreaterThan(100)
  })

  it('frames once the target has reached the focus', () => {
    const controls = at(new Vector3(95, 0, 0), 100)
    for (let frame = 0; frame < 300; frame++) {
      if (stepFocusDistance(controls, anchor, 300, 10, 2048)) break
    }
    expect(controls.distance).toBeCloseTo(300, 9)
  })
})

describe('turnTarget', () => {
  const eye = new Vector3(0, 0, 0)

  it('turns the view by the ease’s share of the angle, even to a focus behind the eye', () => {
    const target = new Vector3(4, 0, 0)
    const behind = new Vector3(-46, 1, 0)
    const before = target.clone()
    turnTarget(target, eye, behind, 0.05)
    const turned = (before.angleTo(target) * 180) / Math.PI
    expect(turned).toBeCloseTo(0.05 * ((before.angleTo(behind) * 180) / Math.PI), 6)
    expect(target.length()).toBeCloseTo(MathUtils.lerp(4, behind.length(), 0.05), 9)
  })

  it('arrives at the focus', () => {
    const target = new Vector3(4, 0, 0)
    const focus = new Vector3(-46, 8, 3)
    for (let frame = 0; frame < 600; frame++) turnTarget(target, eye, focus, 0.05)
    expect(target.distanceTo(focus)).toBeLessThan(1e-4)
  })

  it('eases like a straight line when the focus is nearly ahead', () => {
    const target = new Vector3(100, 0, 0)
    const focus = new Vector3(100, 0.01, 0)
    const straight = target.clone().lerp(focus, 0.05)
    turnTarget(target, eye, focus, 0.05)
    // To first order: they part by the square of the angle.
    expect(target.distanceTo(straight)).toBeLessThan(1e-6)
  })
})

describe('allowDistance', () => {
  it('widens the limits to take in the distance, never narrows them', () => {
    const controls = dolly(2, 13.5, 2048)
    allowDistance(controls)
    expect([controls.minDistance, controls.maxDistance]).toEqual([2, 2048])
    controls.distance = 5000
    allowDistance(controls)
    expect([controls.minDistance, controls.maxDistance]).toEqual([2, 5000])
    controls.distance = 100
    allowDistance(controls)
    expect([controls.minDistance, controls.maxDistance]).toEqual([2, 5000])
  })
})

describe('followMotion', () => {
  it('carries the eye by the followed body’s motion', () => {
    const anchor = { key: null, position: new Vector3(), speed: 0 }
    const carry = new Vector3(9, 9, 9)
    followMotion(anchor, 'earth', new Vector3(50, 0, 0), carry)
    expect(carry.length()).toBe(0)
    followMotion(anchor, 'earth', new Vector3(49, 0, 2), carry)
    expect(carry.toArray()).toEqual([-1, 0, 2])
  })

  it('leaves the eye put on the frame the focus changes, or with none', () => {
    const anchor = { key: 'earth' as unknown, position: new Vector3(50, 0, 0), speed: 0 }
    const carry = new Vector3()
    followMotion(anchor, 'sun', new Vector3(), carry)
    expect(carry.length()).toBe(0)
    followMotion(anchor, null, new Vector3(1, 1, 1), carry)
    expect(carry.length()).toBe(0)
    followMotion(anchor, null, new Vector3(2, 2, 2), carry)
    expect(carry.length()).toBe(0)
  })
})

describe('focusedRef', () => {
  const sun = { current: 'sun' }
  const moon = { current: 'moon' }
  const jupiter = { current: 'jupiter' }

  it('returns the focused body ref', () => {
    expect(focusedRef({ sun, moon }, 'moon')).toBe(moon)
    expect(focusedRef({ sun, jupiter }, 'jupiter')).toBe(jupiter)
  })

  it('falls back to the Sun for a planet or moon that has not registered', () => {
    expect(focusedRef({ sun, moon }, 'neptune')).toBe(sun)
    expect(focusedRef({ sun, moon, saturn: { current: null } }, 'saturn')).toBe(sun)
    expect(focusedRef({ sun, moon }, 'titan')).toBe(sun)
  })

  it('does not swap an unregistered non-planet for the Sun', () => {
    expect(focusedRef({ sun }, 'earth')).toBeUndefined()
  })
})
