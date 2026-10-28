import { PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls } from 'three-stdlib'
import { afterEach, describe, expect, it } from 'vitest'
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
