import { Quaternion, Vector3 } from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { positionsFor, type BodyKey } from '../flight-scale'
import { FOCUS_EASE, MAIN_FOV, turnTarget } from '../main-view'
import {
  DEMO_FLIGHT_SECONDS,
  blendFlightTarget,
  demoFlightRunning,
  poseFocusBefore,
  setDemoFlight,
} from './demo-flight'
import {
  easeProgress,
  easedEye,
  intoPoseFrame,
  outOfPoseFrame,
  poseDirection,
  poseDistance,
  type Demo,
  type DemoFocus,
  type PoseBodies,
} from './demo-script'
import { findDemo } from './demos'

describe('blendFlightTarget', () => {
  it('runs from the target to the focus as the flight goes', () => {
    const focus = new Vector3(10, 0, 0)
    expect(blendFlightTarget(new Vector3(), focus, 0)).toEqual(new Vector3())
    expect(blendFlightTarget(new Vector3(), focus, 0.25)).toEqual(new Vector3(2.5, 0, 0))
    expect(blendFlightTarget(new Vector3(), focus, 1)).toEqual(focus)
  })
})

describe('demoFlightRunning', () => {
  afterEach(() => setDemoFlight(false))

  it('says what DemoPlayer last set', () => {
    expect(demoFlightRunning()).toBe(false)
    setDemoFlight(true)
    expect(demoFlightRunning()).toBe(true)
  })
})

describe('poseFocusBefore', () => {
  const caption = { title: 'T', body: 'B' }
  const demo: Demo = {
    id: 'test',
    title: 'Test',
    blurb: 'A test demo.',
    steps: [
      { date: '2026-01-01T00:00:00Z', camera: { focus: 'earth', azimuth: 0, elevation: 0, distance: 30 }, caption },
      { date: '2026-01-02T00:00:00Z', caption },
      { date: '2026-01-03T00:00:00Z', camera: { focus: 'sun', azimuth: 0, elevation: 0, distance: 150 }, caption },
    ],
  }

  it('is the last pose’s focus before the step, or null at the first', () => {
    expect(poseFocusBefore(demo, 0)).toBeNull()
    expect(poseFocusBefore(demo, 1)).toBe('earth')
    expect(poseFocusBefore(demo, 2)).toBe('earth')
    expect(poseFocusBefore(demo, 3)).toBe('sun')
  })
})

// Mercury to Venus in the planets tour, frame by frame as CameraProvider
// (turnTarget toward the focus) and DemoPlayer (the eye, then the blend)
// run: Venus moves ~4 units a second at four days a second, and the
// target CameraProvider turns trails it.
describe('a flight’s landing', () => {
  const SYSTEM = positionsFor('system')
  const at = (key: BodyKey, t: number) => new Vector3(...SYSTEM.positionAt[key](t))
  const bodiesAt = (focus: DemoFocus, t: number): PoseBodies => ({
    focus: at(focus as BodyKey, t),
    sun: at('sun', t),
    earth: at('earth', t),
    earthTurn: new Quaternion(),
  })
  const demo = findDemo('planets')!
  const before = demo.steps[0].camera!
  const pose = demo.steps[1].camera!
  const timeScale = demo.steps[1].timeScale!
  const t0 = Date.parse(demo.steps[1].date)
  const frame = pose.frame ?? 'sun'
  const FRAMES = DEMO_FLIGHT_SECONDS * 60
  const distance = poseDistance(pose, MAIN_FOV, 1440 / 900)

  /** The target shown each frame, and the focus, from the flight's first frame to a few past landing. */
  function fly(blend: boolean) {
    const last = bodiesAt(before.focus, t0)
    const eye = poseDirection(before, last).multiplyScalar(poseDistance(before, MAIN_FOV, 1440 / 900)).add(last.focus)
    const cameraTarget = last.focus.clone()
    const from = intoPoseFrame(eye.clone().sub(at(pose.focus, t0)), frame, bodiesAt(pose.focus, t0))
    const shown: Vector3[] = []
    const focus: Vector3[] = []
    let snap = false
    for (let k = 1; k <= FRAMES + 3; k++) {
      const bodies = bodiesAt(pose.focus, t0 + (k / 60) * 1000 * timeScale)
      turnTarget(cameraTarget, eye, bodies.focus, snap ? 1 : FOCUS_EASE)
      const t = easeProgress(k / 60, DEMO_FLIGHT_SECONDS)
      easedEye(outOfPoseFrame(from, frame, bodies), poseDirection(pose, bodies), bodies.focus, t, distance, eye)
      const target = cameraTarget.clone()
      if (blend) blendFlightTarget(target, bodies.focus, t)
      // Landed: the target is put on the focus and snapped there from the next frame.
      if (t >= 1) {
        target.copy(bodies.focus)
        snap = true
      }
      shown.push(target)
      focus.push(bodies.focus)
    }
    return { shown, focus }
  }

  // How far the shown target moves at landing beyond the focus's own move.
  function landingJump({ shown, focus }: ReturnType<typeof fly>): number {
    const i = FRAMES - 1
    return shown[i].clone().sub(shown[i - 1]).sub(focus[i].clone().sub(focus[i - 1])).length()
  }

  it('lands the target on the moving focus without a jump', () => {
    const flown = fly(true)
    expect(flown.shown[FRAMES - 1].distanceTo(flown.focus[FRAMES - 1])).toBe(0)
    expect(landingJump(flown)).toBeLessThan(1e-3)
    // Without the blend, the trailing target jumps onto the focus.
    expect(landingJump(fly(false))).toBeGreaterThan(0.1)
  })
})
