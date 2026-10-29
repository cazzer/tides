import { Quaternion, Vector3 } from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { earthSpin } from '../ephemeris'
import { DEFAULT_SYSTEM_AIDS } from '../store'
import type { Demo } from './demo-script'
import {
  easeProgress,
  easedEye,
  eyeDirection,
  intoPoseFrame,
  outOfPoseFrame,
  poseDirection,
  poseDistance,
  type DemoFrame,
} from './demo-script'
import { setEarthSpinHold, shownEarthSpin, travelRun } from './demo-travel'
import {
  DEMO_PLAY_SCALE,
  demoPlayScale,
  demoStepPatch,
  enterDemoPatch,
  exitDemoPatch,
  goToDemoStepPatch,
  demoClockFrame,
  demoClockTrack,
  reachedUntil,
  type DemoSaved,
  type DemoSessionState,
} from './demo-session'

type View = DemoSessionState & { jumpDate: Date | null }

function view(overrides: Partial<View> = {}): View {
  return {
    jumpDate: null,
    timestamp: Date.parse('2025-06-01T12:00:00Z'),
    timeScale: 3600,
    cameraFocus: 'mars',
    mainPanel: 'bottom',
    layout: 'triple',
    location: { lat: 51.5, lon: -0.1 },
    showPlanets: true,
    showConstellations: true,
    showConstellationArt: false,
    showLunar: true,
    showZodiac: false,
    systemAids: { ...DEFAULT_SYSTEM_AIDS },
    skyLook: { azimuth: 10, altitude: 20 },
    skyFov: 30,
    compass: true,
    demo: null,
    demoSaved: null,
    demoTravel: null,
    shipMode: false,
    ...overrides,
  }
}

const caption = { title: 'T', body: 'B' }

const demo: Demo = {
  id: 'test',
  title: 'Test',
  blurb: 'A test demo.',
  steps: [
    {
      date: '2026-03-03T08:30:00Z',
      timeScale: 0,
      layout: 'single',
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 90, elevation: 25, distance: 120 },
      overlays: { showPlanets: false, systemAids: { grid: false } },
      caption,
    },
    {
      date: '2026-03-03T09:40:00Z',
      until: '2026-03-03T11:00:00Z',
      timeScale: 300,
      camera: { focus: 'moon', azimuth: 40, elevation: 15, distance: 6 },
      caption,
    },
    {
      date: '2026-03-03T11:33:46Z',
      mainPanel: 'top',
      location: { lat: 21.31, lon: -157.86 },
      skyLook: { azimuth: 221.5, altitude: 70.3 },
      skyFov: null,
      overlays: { showZodiac: true, systemAids: { trails: true } },
      caption,
    },
  ],
}

const SAVED_KEYS = [
  'timestamp', 'timeScale', 'cameraFocus', 'mainPanel', 'layout', 'location',
  'showPlanets', 'showConstellations', 'showConstellationArt', 'showLunar',
  'showZodiac', 'systemAids', 'skyLook', 'skyFov', 'compass',
] as const satisfies readonly (keyof DemoSaved)[]

function saved(s: View): DemoSaved {
  return Object.fromEntries(SAVED_KEYS.map((key) => [key, s[key]])) as unknown as DemoSaved
}

describe('enterDemoPatch', () => {
  it('saves the view, turns compass mode off and applies the first step', () => {
    const s = view()
    const patch = enterDemoPatch(s, demo, 1234)!
    expect(patch.demoSaved).toEqual({ ...saved(s), enteredAt: 1234 })
    expect(patch).toMatchObject({
      demo: { id: 'test', step: 0 },
      compass: false,
      jumpDate: null,
      timestamp: Date.parse('2026-03-03T08:30:00Z'),
      timeScale: 0,
      layout: 'single',
      mainPanel: 'main',
      cameraFocus: 'earth',
      showPlanets: false,
      // Unset by the demo: the user's own.
      location: s.location,
      skyLook: s.skyLook,
      showLunar: true,
    })
    expect(patch.systemAids).toEqual({ ...DEFAULT_SYSTEM_AIDS, grid: false })
  })

  it('saves the date a jump under way lands on', () => {
    const jumpDate = new Date('2030-01-01T00:00:00Z')
    const patch = enterDemoPatch(view({ jumpDate }), demo)!
    expect(patch.demoSaved.timestamp).toBe(jumpDate.getTime())
    expect(patch.jumpDate).toBeNull()
  })

  it('returns null while a demo or ship mode runs', () => {
    const s = view()
    const running = { ...s, ...enterDemoPatch(s, demo)! }
    expect(enterDemoPatch(running, demo)).toBeNull()
    expect(enterDemoPatch(view({ shipMode: true }), demo)).toBeNull()
  })
})

describe('demoStepPatch', () => {
  it('folds the steps up to the one shown over the saved view', () => {
    const s = view()
    const patch = demoStepPatch(saved(s), demo, 2)
    expect(patch).toMatchObject({
      demo: { id: 'test', step: 2 },
      timestamp: Date.parse('2026-03-03T11:33:46Z'),
      jumpDate: null,
      timeScale: 300,
      layout: 'single',
      mainPanel: 'top',
      cameraFocus: 'moon',
      location: { lat: 21.31, lon: -157.86 },
      skyLook: { azimuth: 221.5, altitude: 70.3 },
      skyFov: null,
      showPlanets: false,
      showZodiac: true,
    })
    expect(patch.systemAids).toEqual({ ...DEFAULT_SYSTEM_AIDS, grid: false, trails: true })
    expect(patch).not.toHaveProperty('compass')
  })

  it('gives the same view going back as going forward from the start', () => {
    let s: View = view()
    s = { ...s, ...enterDemoPatch(s, demo)! }
    const forward = [demoStepPatch(s.demoSaved!, demo, 0)]
    for (let i = 1; i < demo.steps.length; i++) {
      s = { ...s, ...goToDemoStepPatch(s, demo, i)! }
      forward.push(demoStepPatch(s.demoSaved!, demo, i))
    }
    for (let i = demo.steps.length - 2; i >= 0; i--) {
      const back = goToDemoStepPatch(s, demo, i)!
      expect(back).toEqual(forward[i])
      s = { ...s, ...back }
    }
  })

  it('sets the date directly, cancelling a pending jump', () => {
    const s = { ...view(), ...enterDemoPatch(view(), demo)! }
    const patch = goToDemoStepPatch({ ...s, jumpDate: new Date() } as View, demo, 1)!
    expect(patch).toMatchObject({ timestamp: Date.parse('2026-03-03T09:40:00Z'), jumpDate: null })
  })

  it('refuses a step out of range, or outside the demo', () => {
    const s = { ...view(), ...enterDemoPatch(view(), demo)! }
    expect(goToDemoStepPatch(s, demo, -1)).toBeNull()
    expect(goToDemoStepPatch(s, demo, demo.steps.length)).toBeNull()
    expect(goToDemoStepPatch(view(), demo, 0)).toBeNull()
  })
})

describe('goToDemoStepPatch travel', () => {
  const earth = { focus: 'earth', azimuth: 0, elevation: 10, distance: 60 } as const
  const travelling: Demo = {
    id: 'travel',
    title: 'Travel',
    blurb: 'A demo that travels.',
    steps: [
      { date: '2026-03-20T14:46:00Z', timeScale: 0, camera: earth, travel: { seconds: 4 }, caption },
      { date: '2026-06-21T08:24:00Z', camera: earth, travel: { seconds: 4, hold: ['spin'] }, caption },
      { date: '2026-09-23T00:05:00Z', travel: { rate: 60 }, caption },
    ],
  }
  const march = Date.parse(travelling.steps[0].date)
  const june = Date.parse(travelling.steps[1].date)
  const entered = (): View => ({ ...view(), ...enterDemoPatch(view(), travelling)! })

  it('enters with the clock cut to the first step, its travel aside', () => {
    expect(entered()).toMatchObject({ timestamp: march, demoTravel: null })
  })

  it('keeps the instant shown and travels from it to another step', () => {
    const patch = goToDemoStepPatch(entered(), travelling, 1)!
    expect(patch).toMatchObject({
      demo: { id: 'travel', step: 1 },
      timestamp: march,
      demoTravel: { from: march, to: june, seconds: 4, easing: 'smooth', holdSpin: true },
    })
  })

  it('cuts under reduced motion, to the same step, or where the travel would take too long', () => {
    const s = entered()
    expect(goToDemoStepPatch(s, travelling, 1, true)).toMatchObject({ timestamp: june, demoTravel: null })
    expect(goToDemoStepPatch(s, travelling, 0)).toMatchObject({ timestamp: march, demoTravel: null })
    // A minute a second over three months is far past the cap.
    expect(goToDemoStepPatch(s, travelling, 2)).toMatchObject({
      timestamp: Date.parse(travelling.steps[2].date),
      demoTravel: null,
    })
  })

  it('lands the travel on Next, without moving on', () => {
    let s = entered()
    s = { ...s, ...goToDemoStepPatch(s, travelling, 1)! }
    s = { ...s, timestamp: march + 1000 }
    expect(goToDemoStepPatch(s, travelling, 2)).toEqual({ timestamp: june, demoTravel: null })
  })

  it('travels back on Prev from wherever the clock has got to', () => {
    let s = entered()
    s = { ...s, ...goToDemoStepPatch(s, travelling, 1)! }
    const mid = (march + june) / 2
    s = { ...s, timestamp: mid }
    expect(goToDemoStepPatch(s, travelling, 0)).toMatchObject({
      demo: { id: 'travel', step: 0 },
      timestamp: mid,
      demoTravel: { from: mid, to: march },
    })
  })

  it('clears the travel on exit', () => {
    let s = entered()
    s = { ...s, ...goToDemoStepPatch(s, travelling, 1)! }
    expect(exitDemoPatch(s)!.demoTravel).toBeNull()
  })
})

describe('exitDemoPatch', () => {
  it('restores every saved field, a planet focus with the planets shown included', () => {
    const before = view()
    let s: View = { ...before, ...enterDemoPatch(before, demo)! }
    s = { ...s, ...goToDemoStepPatch(s, demo, 2)! }
    const after = { ...s, ...exitDemoPatch(s)! }
    expect(saved(after)).toEqual(saved(before))
    expect(after.cameraFocus).toBe('mars')
    expect(after.showPlanets).toBe(true)
    expect(after.compass).toBe(true)
    expect(after.demo).toBeNull()
    expect(after.demoSaved).toBeNull()
    expect(after.jumpDate).toBeNull()
  })

  it('returns null outside a demo', () => {
    expect(exitDemoPatch(view())).toBeNull()
  })

  it('brings someone following real time back to now', () => {
    const before = view({ timeScale: 1 })
    const s = { ...before, ...enterDemoPatch(before, demo, 10_000)! }
    const after = exitDemoPatch(s, 70_000)!
    expect(after.timestamp).toBe(before.timestamp! + 60_000)
    expect(after.timeScale).toBe(1)
  })

  it('brings any other clock back exactly as it was', () => {
    for (const timeScale of [0, 3600]) {
      const before = view({ timeScale })
      const s = { ...before, ...enterDemoPatch(before, demo, 10_000)! }
      expect(exitDemoPatch(s, 70_000)!.timestamp).toBe(before.timestamp)
    }
  })
})

describe('demoPlayScale', () => {
  it("plays at the step's speed, or an hour a second where it pauses", () => {
    const s = { ...view(), ...enterDemoPatch(view(), demo)! }
    expect(demoPlayScale(s, demo)).toBe(DEMO_PLAY_SCALE)
    expect(demoPlayScale({ ...s, demo: { id: 'test', step: 1 } }, demo)).toBe(300)
  })
})

describe('reachedUntil', () => {
  it('counts only the crossing, so Play after the stop runs on', () => {
    expect(reachedUntil(90, 101, 100)).toBe(true)
    expect(reachedUntil(90, 100, 100)).toBe(true)
    expect(reachedUntil(100, 110, 100)).toBe(false)
    expect(reachedUntil(null, 110, 100)).toBe(false)
    expect(reachedUntil(110, 50, 100)).toBe(false)
  })
})

describe('demoClockFrame', () => {
  afterEach(() => setEarthSpinHold(null))
  const DAY = 86_400_000
  const from = Date.parse('2026-03-20T14:46:00Z')
  const to = from + 90 * DAY
  // The step's stop, a day past its date, as the tours set it.
  const until = to + DAY

  it('carries the clock, landing exactly on the date, and stops at until only after', () => {
    const run = travelRun({ seconds: 1, hold: ['spin'] }, from, to, false)!
    const track = demoClockTrack()
    let timestamp: number | null = from
    let travel: typeof run | null = run
    const seen: number[] = []
    // A binary fraction of a second, so the frames sum to the travel exactly.
    for (let i = 0; i < 40 && travel; i++) {
      const { write, hold } = demoClockFrame(track, travel, timestamp, until, 0.0625)
      expect(write).not.toBeNull()
      timestamp = write!.timestamp
      seen.push(timestamp)
      if (write!.demoTravel === null) {
        travel = null
        expect(hold).toBeNull()
      } else expect(hold).toEqual({ from, to, spinFrom: earthSpin(from) })
    }
    expect(travel).toBeNull()
    expect(seen[seen.length - 1]).toBe(to)
    expect(seen.every((t, i) => i === 0 || t >= seen[i - 1])).toBe(true)
    expect(seen).toHaveLength(16)

    // Landed: the clock runs on (SimClock) and stops at until.
    expect(demoClockFrame(track, null, to + DAY / 2, until, 0.1).write).toBeNull()
    expect(demoClockFrame(track, null, until + 1000, until, 0.1).write).toEqual({ timestamp: until, timeScale: 0 })
  })

  it('checks no stop on the way, even a travel back across until', () => {
    const run = travelRun({ seconds: 1 }, until + 10 * DAY, to, false)!
    const track = demoClockTrack()
    track.previous = until + 10 * DAY
    for (let i = 0; i < 10; i++) {
      const { write } = demoClockFrame(track, run, null, until, 0.1)
      expect(write?.timeScale).toBeUndefined()
    }
    expect(track.previous).toBe(to)
  })

  it('turns a new travel on from the spin shown', () => {
    // Prev a day into a travel that holds the spin: back from the angle shown.
    setEarthSpinHold({ from, to, spinFrom: 1 })
    const shown = shownEarthSpin(from + DAY)
    expect(shown).not.toBeCloseTo(earthSpin(from + DAY))
    const run = travelRun({ seconds: 2, hold: ['spin'] }, from + DAY, from, false)!
    expect(demoClockFrame(demoClockTrack(), run, from + DAY, null, 0.05).hold?.spinFrom).toBe(shown)
  })
})

describe('eyeDirection', () => {
  const sun = new Vector3(0, 0, 0)
  const earth = new Vector3(50, 0, 0)

  it('looks from the Sun side at azimuth 0', () => {
    const dir = eyeDirection(earth, sun, earth, 0, 0)
    expect(dir.x).toBeCloseTo(-1)
    expect(dir.y).toBeCloseTo(0)
    expect(dir.z).toBeCloseTo(0)
  })

  it('turns counter-clockwise seen from ecliptic north (+Y)', () => {
    // From +Y looking down, +X then -Z is counter-clockwise (right-handed).
    const dir = eyeDirection(sun, sun, earth, 90, 0)
    expect(dir.x).toBeCloseTo(0)
    expect(dir.z).toBeCloseTo(-1)
  })

  it('points along +Y at elevation 90', () => {
    const dir = eyeDirection(earth, sun, earth, 37, 90)
    expect(dir.y).toBeCloseTo(1)
    expect(dir.length()).toBeCloseTo(1)
  })

  it('ignores the height of the Sun above the focus', () => {
    const dir = eyeDirection(new Vector3(10, 5, 0), sun, earth, 0, 0)
    expect(dir.y).toBeCloseTo(0)
    expect(dir.x).toBeCloseTo(-1)
  })
})

describe('poseDirection', () => {
  const bodies = {
    focus: new Vector3(30, 4, -40),
    sun: new Vector3(0, 0, 0),
    earth: new Vector3(30, 4, -40),
    earthTurn: new Quaternion(),
  }
  const near = (v: Vector3, x: number, y: number, z: number) =>
    expect(v.distanceTo(new Vector3(x, y, z))).toBeCloseTo(0)

  it("matches eyeDirection in the Sun's frame, the default", () => {
    for (const frame of [undefined, 'sun'] as const) {
      const pose = { frame, azimuth: 70, elevation: 20 }
      near(poseDirection(pose, bodies), ...eyeDirection(bodies.focus, bodies.sun, bodies.earth, 70, 20).toArray())
    }
  })

  it('measures ecliptic longitude against the stars, wherever the focus and the Sun are', () => {
    for (const focus of [bodies.focus, new Vector3(-80, 0, 5)]) {
      const at = { ...bodies, focus, earth: focus }
      near(poseDirection({ frame: 'stars', azimuth: 0, elevation: 0 }, at), -1, 0, 0)
      near(poseDirection({ frame: 'stars', azimuth: 90, elevation: 0 }, at), 0, 0, 1)
      near(poseDirection({ frame: 'stars', azimuth: 37, elevation: 90 }, at), 0, 1, 0)
    }
  })

  it('stands over a latitude and longitude, turning with Earth', () => {
    // calculateLocationAndRotationForLatLng: longitude 0 on local +X, east toward -Z.
    near(poseDirection({ frame: 'earth', azimuth: 0, elevation: 0 }, bodies), 1, 0, 0)
    near(poseDirection({ frame: 'earth', azimuth: 90, elevation: 0 }, bodies), 0, 0, -1)
    near(poseDirection({ frame: 'earth', azimuth: 123, elevation: 90 }, bodies), 0, 1, 0)
    const turned = { ...bodies, earthTurn: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2) }
    near(poseDirection({ frame: 'earth', azimuth: 0, elevation: 0 }, turned), 0, 0, -1)
  })
})

describe('poseDistance', () => {
  // A sphere of radius `fit` exactly fills the narrower half-angle at the result.
  const fills = (fit: number, distance: number, vfov: number, aspect: number) => {
    const halfV = (vfov / 2) * (Math.PI / 180)
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect))
    expect(Math.asin(fit / distance)).toBeCloseTo(half)
  }

  it('is the pose’s distance without a fit', () => {
    expect(poseDistance({ distance: 170 }, 30, 390 / 844)).toBe(170)
  })

  it('keeps the distance on a wide view, where the fit already shows', () => {
    // 1440x900: the vertical 15° half-angle is the narrower; 60 fits from 232.
    expect(poseDistance({ distance: 300, fit: 60 }, 30, 1440 / 900)).toBe(300)
    const d = poseDistance({ distance: 170, fit: 60 }, 30, 1440 / 900)
    fills(60, d, 30, 1440 / 900)
  })

  it('backs off on a phone held upright, fitting across its width', () => {
    const d = poseDistance({ distance: 170, fit: 60 }, 30, 390 / 844)
    expect(d).toBeGreaterThan(170)
    fills(60, d, 30, 390 / 844)
  })
})

describe('easedEye', () => {
  const focus = new Vector3(100, 0, 0)
  const goal = new Vector3(0, 0, 1)

  it('starts at the user’s offset and ends on the pose, about the focus', () => {
    const from = new Vector3(7.8, 0, 0)
    expect(easedEye(from, goal, focus, 0, 20).distanceTo(new Vector3(107.8, 0, 0))).toBeCloseTo(0)
    expect(easedEye(from, goal, focus, 1, 20).distanceTo(new Vector3(100, 0, 20))).toBeCloseTo(0)
  })

  it('scales the distance geometrically on the way', () => {
    const eye = easedEye(new Vector3(5, 0, 0), goal, focus, 0.5, 20)
    expect(eye.distanceTo(focus)).toBeCloseTo(10)
  })

  // tides-ytp: zoomed in to 2.6 Earth radii, a step's date jump left the
  // view's target ~30 radii from Earth; an eye placed about the target was
  // turned further out each frame until it reached ~1e16 radii.
  it('stays at the eased distance from the focus wherever the view’s target lags', () => {
    const from = new Vector3(0, 7.8, 0)
    for (let t = 0; t <= 1; t += 0.1) {
      const d = easedEye(from, goal, focus, t, 20).distanceTo(focus)
      expect(d).toBeGreaterThanOrEqual(7.8 - 1e-9)
      expect(d).toBeLessThanOrEqual(20 + 1e-9)
    }
  })

  it('pushes straight in or out when already on the pose’s direction', () => {
    for (const fromDistance of [3, 80]) {
      const from = goal.clone().multiplyScalar(fromDistance)
      for (let t = 0; t <= 1; t += 0.1) {
        const dir = easedEye(from, goal, focus, t, 20).sub(focus).normalize()
        expect(dir.distanceTo(goal)).toBeCloseTo(0)
      }
    }
  })

  it('takes the pose outright with no starting offset', () => {
    expect(easedEye(new Vector3(), goal, focus, 0, 20).distanceTo(new Vector3(100, 0, 20))).toBeCloseTo(0)
  })
})

describe('an ease in a turning frame', () => {
  const at = (turn: number) => ({
    focus: new Vector3(30, 4, -40).applyAxisAngle(new Vector3(0, 1, 0), turn / 50),
    sun: new Vector3(0, 0, 0),
    earth: new Vector3(30, 4, -40).applyAxisAngle(new Vector3(0, 1, 0), turn / 50),
    earthTurn: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), turn),
  })

  it('keeps a pose fixed in its own frame however the frame turns', () => {
    for (const frame of ['sun', 'stars', 'earth'] as DemoFrame[]) {
      const pose = { frame, azimuth: 40, elevation: 25 }
      const fixed = intoPoseFrame(poseDirection(pose, at(0)), frame, at(0))
      for (const turn of [0.7, 3, -5]) {
        const bodies = at(turn)
        expect(intoPoseFrame(poseDirection(pose, bodies), frame, bodies).distanceTo(fixed)).toBeCloseTo(0)
        expect(outOfPoseFrame(fixed, frame, bodies).distanceTo(poseDirection(pose, bodies))).toBeCloseTo(0)
      }
    }
  })

  // A fast travel turns Earth many times over an ease: a start held fixed in
  // the world meets the goal turning with Earth head on and the arc flips.
  it('eases smoothly in Earth’s frame while Earth spins under it', () => {
    const pose = { frame: 'earth' as const, azimuth: 0, elevation: 20 }
    const focus = new Vector3()
    const startWorld = new Vector3(-30, 5, 4)
    const from = intoPoseFrame(startWorld, 'earth', at(0))
    let last: Vector3 | null = null
    for (let i = 0; i <= 400; i++) {
      const t = i / 400
      const bodies = at(t * 40)
      const goal = poseDirection(pose, bodies)
      const eye = easedEye(outOfPoseFrame(from, 'earth', bodies), goal, focus, easeProgress(t, 1), 20)
      if (i === 0) expect(eye.distanceTo(startWorld)).toBeCloseTo(0)
      // Seen from Earth, the eye moves a little each sample.
      const seen = intoPoseFrame(eye, 'earth', bodies)
      if (last) expect(seen.distanceTo(last)).toBeLessThan(0.5)
      last = seen
    }
    expect(last!.clone().normalize().distanceTo(poseDirection(pose, at(0)))).toBeCloseTo(0)
  })
})

describe('easeProgress', () => {
  it('runs 0 to 1 smoothly, and jumps to 1 with no duration', () => {
    expect(easeProgress(0, 2.5)).toBe(0)
    expect(easeProgress(1.25, 2.5)).toBeCloseTo(0.5)
    expect(easeProgress(3, 2.5)).toBe(1)
    expect(easeProgress(0, 0)).toBe(1)
  })
})
