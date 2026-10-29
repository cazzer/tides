import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_AIDS } from '../store'
import type { Demo } from './demo-script'
import { easeProgress, easedEye, eyeDirection } from './demo-script'
import {
  DEMO_PLAY_SCALE,
  demoPlayScale,
  demoStepPatch,
  enterDemoPatch,
  exitDemoPatch,
  goToDemoStepPatch,
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
    expect(patch.timestamp).toBe(Date.parse('2026-03-03T09:40:00Z'))
    expect(patch.jumpDate).toBeNull()
  })

  it('refuses a step out of range, or outside the demo', () => {
    const s = { ...view(), ...enterDemoPatch(view(), demo)! }
    expect(goToDemoStepPatch(s, demo, -1)).toBeNull()
    expect(goToDemoStepPatch(s, demo, demo.steps.length)).toBeNull()
    expect(goToDemoStepPatch(view(), demo, 0)).toBeNull()
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

  it('takes the pose outright with no starting offset', () => {
    expect(easedEye(new Vector3(), goal, focus, 0, 20).distanceTo(new Vector3(100, 0, 20))).toBeCloseTo(0)
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
