import { PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls } from 'three-stdlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Demo } from './demo-script'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('../ship/reduced-motion', () => ({ prefersReducedMotion: () => motion.reduced }))

// A demo that travels, beside the real ones.
const travelling: Demo = {
  id: 'travel-test',
  title: 'Travel',
  blurb: 'A demo that travels.',
  steps: [
    { date: '2026-03-20T14:46:00Z', timeScale: 0, caption: { title: 'T', body: 'B' } },
    { date: '2026-06-21T08:24:00Z', travel: { seconds: 4 }, caption: { title: 'T', body: 'B' } },
    { date: '2026-09-23T00:05:00Z', caption: { title: 'T', body: 'B' } },
  ],
}
vi.mock('./demos', async (importOriginal) => {
  const real = await importOriginal<typeof import('./demos')>()
  return { ...real, findDemo: (id: string) => (id === travelling.id ? travelling : real.findDemo(id)) }
})

import { useStore } from '../store'
import {
  rememberMainCameraPose,
  requestFocusSnap,
  requestMainCameraRestore,
  takeFocusSnap,
  takeMainCameraRestore,
} from '../main-camera-session'
import { DEMO_PLAY_SCALE } from './demo-session'
import { findDemo } from './demos'

const initial = useStore.getState()

afterEach(() => {
  motion.reduced = false
  useStore.setState(initial, true)
  takeMainCameraRestore()
  takeFocusSnap()
})

function rememberPose(x: number) {
  const camera = new PerspectiveCamera()
  camera.position.set(x, 2, 3)
  rememberMainCameraPose(camera, { target: new Vector3(1, 0, 0) } as unknown as OrbitControls)
}

describe('main camera restore', () => {
  it('hands out the saved pose once per request', () => {
    rememberPose(7)
    expect(takeMainCameraRestore()).toBeNull()
    requestMainCameraRestore()
    expect(takeMainCameraRestore()?.position).toEqual([7, 2, 3])
    expect(takeMainCameraRestore()).toBeNull()
  })

  it('hands out a focus snap once per request', () => {
    expect(takeFocusSnap()).toBe(false)
    requestFocusSnap()
    expect(takeFocusSnap()).toBe(true)
    expect(takeFocusSnap()).toBe(false)
  })
})

describe('store demo actions', () => {
  const demo = findDemo('lunar-eclipse')!

  it('starts a demo at its first step and leaves it as it was', () => {
    useStore.setState({ timeScale: 3600, layout: 'triple', cameraFocus: 'sun', timestamp: 5 })
    useStore.getState().startDemo(demo.id)
    expect(useStore.getState()).toMatchObject({
      demo: { id: demo.id, step: 0 },
      layout: 'single',
      cameraFocus: 'earth',
      timestamp: Date.parse(demo.steps[0].date),
    })
    useStore.getState().goToDemoStep(2)
    expect(useStore.getState().demo).toEqual({ id: demo.id, step: 2 })
    rememberPose(4)
    useStore.getState().exitDemo()
    expect(useStore.getState()).toMatchObject({
      demo: null,
      demoSaved: null,
      timeScale: 3600,
      layout: 'triple',
      cameraFocus: 'sun',
      timestamp: 5,
    })
    // The main view puts the camera back on its next frame.
    expect(takeMainCameraRestore()?.position).toEqual([4, 2, 3])
  })

  it('ignores unknown demos and steps out of range', () => {
    useStore.getState().startDemo('no-such-demo')
    expect(useStore.getState().demo).toBeNull()
    useStore.getState().startDemo(demo.id)
    useStore.getState().goToDemoStep(demo.steps.length)
    expect(useStore.getState().demo?.step).toBe(0)
  })

  it('keeps ship mode out while a demo runs', () => {
    useStore.getState().startDemo(demo.id)
    useStore.getState().enterShip()
    expect(useStore.getState().shipMode).toBe(false)
  })

  it("toggles the clock between paused and the step's speed", () => {
    useStore.getState().startDemo(demo.id)
    expect(useStore.getState().timeScale).toBe(0)
    useStore.getState().toggleDemoPlaying()
    expect(useStore.getState().timeScale).toBe(DEMO_PLAY_SCALE)
    useStore.getState().toggleDemoPlaying()
    expect(useStore.getState().timeScale).toBe(0)
    useStore.getState().goToDemoStep(1)
    expect(useStore.getState().timeScale).toBe(300)
    useStore.getState().toggleDemoPlaying()
    expect(useStore.getState().timeScale).toBe(0)
    useStore.getState().toggleDemoPlaying()
    expect(useStore.getState().timeScale).toBe(300)
  })
})

describe('store demo travel', () => {
  const march = Date.parse(travelling.steps[0].date)
  const june = Date.parse(travelling.steps[1].date)

  it('travels to a step, lands on Next and clears on exit', () => {
    useStore.getState().startDemo(travelling.id)
    useStore.getState().goToDemoStep(1)
    expect(useStore.getState()).toMatchObject({
      demo: { id: travelling.id, step: 1 },
      timestamp: march,
      demoTravel: { from: march, to: june, seconds: 4 },
    })
    useStore.getState().goToDemoStep(2)
    expect(useStore.getState()).toMatchObject({
      demo: { id: travelling.id, step: 1 },
      timestamp: june,
      demoTravel: null,
    })
    useStore.getState().goToDemoStep(0)
    useStore.getState().goToDemoStep(1)
    expect(useStore.getState().demoTravel).not.toBeNull()
    useStore.getState().exitDemo()
    expect(useStore.getState().demoTravel).toBeNull()
  })

  it('cuts under reduced motion', () => {
    motion.reduced = true
    useStore.getState().startDemo(travelling.id)
    useStore.getState().goToDemoStep(1)
    expect(useStore.getState()).toMatchObject({ timestamp: june, demoTravel: null })
  })
})
