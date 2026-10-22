import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { SURFACE_FOV, surfaceView } from './sky'
import type { Reset } from './sky-look-drag'
import { SKY_FOV_MIN, directionAt } from './sky-zoom'
import { stepGlide, zoomOnPinch, type Glide } from './sky-zoom-gesture'

type Listener = (event: Event) => void

const DEG = Math.PI / 180
const tanHalf = (fov: number) => Math.tan((fov / 2) * DEG)
const angleBetween = (a: number, b: number) =>
  Math.abs(THREE.MathUtils.euclideanModulo(a - b + 180, 360) - 180)

// Just enough of the panel's div, 400x800 at (100, 0), to drive the handlers.
function panel() {
  const listeners = new Map<string, Listener>()
  const options = new Map<string, unknown>()
  const element = {
    getBoundingClientRect: () => ({ left: 100, top: 0, width: 400, height: 800 }) as DOMRect,
    setPointerCapture: () => {},
    addEventListener: (type: string, listener: Listener, option: unknown) => {
      listeners.set(type, listener)
      options.set(type, option)
    },
    removeEventListener: (type: string) => listeners.delete(type),
  }
  let prevented = 0
  const fire = (type: string, fields: Record<string, unknown>) =>
    listeners.get(type)?.({
      type,
      preventDefault: () => prevented++,
      ...fields,
    } as unknown as Event)
  const touch = (type: string, id: number, x: number, y: number) =>
    fire(type, { pointerId: id, pointerType: 'touch', isPrimary: false, clientX: x, clientY: y })
  const reset = { current: null as Reset | null }
  const glide = { current: null as Glide | null }
  const cleanup = zoomOnPinch(element as unknown as HTMLElement, reset, glide)
  return { listeners, options, fire, touch, reset, glide, cleanup, prevented: () => prevented }
}

const state = () => useStore.getState()
const look = { azimuth: 160, altitude: 40 }
// The sky at a client point of the test panel, as it's drawn now.
const skyAt = (x: number, y: number) =>
  directionAt(state().skyLook!, state().skyFov!, { dx: x - 300, dy: y - 400 }, 800)

describe('pinch to zoom View from Earth (tides-2j7)', () => {
  beforeEach(() =>
    useStore.setState({ skyLook: look, skyFov: null, location: { lat: 51.5, lon: 0 } })
  )

  it('zooms with the fingers’ spread, keeping the sky between them', () => {
    const { touch, reset } = panel()
    reset.current = { from: look, fromFov: 90, start: 0 }
    const start = directionAt(look, SURFACE_FOV, { dx: -100, dy: -100 }, 800)
    touch('pointerdown', 1, 150, 300)
    touch('pointerdown', 2, 250, 300)
    expect(reset.current).toBeNull()
    expect(state().skyFov).toBeNull()

    // Spread to twice the distance, and drift: the midpoint moves to (220, 260).
    touch('pointermove', 1, 120, 260)
    touch('pointermove', 2, 320, 260)
    expect(tanHalf(state().skyFov!)).toBeCloseTo(tanHalf(SURFACE_FOV) / 2, 9)
    const under = skyAt(220, 260)
    expect(under.altitude).toBeCloseTo(start.altitude, 6)
    expect(angleBetween(under.azimuth, start.azimuth)).toBeLessThan(1e-6)

    // Spreading far stops at the narrowest view; lifting a finger ends it.
    touch('pointermove', 2, 3000, 260)
    expect(state().skyFov).toBe(SKY_FOV_MIN)
    touch('pointerup', 2, 3000, 260)
    touch('pointermove', 1, 0, 0)
    expect(state().skyFov).toBe(SKY_FOV_MIN)
  })

  it('ignores one finger and the mouse', () => {
    const { touch, fire } = panel()
    touch('pointerdown', 1, 150, 300)
    touch('pointermove', 1, 350, 300)
    fire('pointerdown', { pointerId: 9, pointerType: 'mouse', clientX: 0, clientY: 0 })
    touch('pointermove', 1, 400, 300)
    expect(state().skyFov).toBeNull()
    expect(state().skyLook).toEqual(look)
  })

  it('glides on the wheel toward the cursor, and never zooms the page', () => {
    const { fire, glide, reset, options, prevented } = panel()
    expect(options.get('wheel')).toEqual({ passive: false })
    const start = directionAt(look, SURFACE_FOV, { dx: 100, dy: 200 }, 800)
    const wheel = { clientX: 400, clientY: 600, deltaMode: 0 }
    fire('wheel', { ...wheel, deltaY: -100, ctrlKey: false })
    fire('wheel', { ...wheel, deltaY: -30, ctrlKey: true })
    expect(prevented()).toBe(2)
    // Nothing jumps; the frames ease in.
    expect(state().skyFov).toBeNull()
    const target = glide.current!.fov
    expect(tanHalf(SURFACE_FOV) / tanHalf(target)).toBeCloseTo(2 ** 0.8, 9)

    let frames = 0
    while (glide.current && frames < 200) {
      const before = state().skyFov ?? SURFACE_FOV
      stepGlide(glide, reset, 1 / 60)
      expect(state().skyFov!).toBeLessThan(before)
      frames++
    }
    expect(frames).toBeGreaterThan(5)
    expect(frames).toBeLessThan(60)
    expect(state().skyFov).toBe(target)
    const under = skyAt(400, 600)
    expect(under.altitude).toBeCloseTo(start.altitude, 6)
    expect(angleBetween(under.azimuth, start.azimuth)).toBeLessThan(1e-6)
  })

  it('lets a press take over a glide at once', () => {
    const { fire, glide } = panel()
    fire('wheel', { clientX: 300, clientY: 400, deltaMode: 0, deltaY: -300, ctrlKey: false })
    expect(glide.current).not.toBeNull()
    fire('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 300, clientY: 400 })
    expect(glide.current).toBeNull()
  })

  it('responds at once pinching back from the narrowest view', () => {
    const { touch } = panel()
    touch('pointerdown', 1, 250, 400)
    touch('pointerdown', 2, 350, 400)
    touch('pointermove', 2, 2000, 400)
    expect(state().skyFov).toBe(SKY_FOV_MIN)
    touch('pointermove', 2, 1900, 400)
    expect(state().skyFov).toBeGreaterThan(SKY_FOV_MIN)
  })

  it('hands a pinch over to the fingers still down', () => {
    const { touch } = panel()
    touch('pointerdown', 1, 200, 400)
    touch('pointerdown', 2, 300, 400)
    touch('pointerdown', 3, 400, 400)
    touch('pointerup', 1, 200, 400)
    touch('pointermove', 3, 600, 400)
    expect(tanHalf(state().skyFov!)).toBeCloseTo(tanHalf(SURFACE_FOV) / 3, 9)
  })

  it('lets a double-tap reset take over a glide', () => {
    const { fire, glide, reset } = panel()
    fire('wheel', { clientX: 300, clientY: 400, deltaMode: 0, deltaY: -300, ctrlKey: false })
    stepGlide(glide, reset, 1 / 60)
    reset.current = { from: look, fromFov: state().skyFov!, start: 0 }
    const fov = state().skyFov
    stepGlide(glide, reset, 1 / 60)
    expect(glide.current).toBeNull()
    expect(state().skyFov).toBe(fov)
  })

  it('takes Safari’s trackpad pinch, not the page', () => {
    const { fire, prevented, touch } = panel()
    const at = { clientX: 300, clientY: 400 }
    fire('gesturestart', { ...at, scale: 1 })
    fire('gesturechange', { ...at, scale: 2 })
    expect(tanHalf(state().skyFov!)).toBeCloseTo(tanHalf(SURFACE_FOV) / 2, 9)
    // About the centre, so only the zoom changes.
    expect(state().skyLook!.altitude).toBeCloseTo(look.altitude, 9)
    // Its own ctrl+wheel, if any, adds nothing.
    const fov = state().skyFov
    fire('wheel', { ...at, deltaMode: 0, deltaY: -50, ctrlKey: true })
    fire('gestureend', { ...at, scale: 2 })
    expect(prevented()).toBe(4)
    expect(state().skyFov).toBe(fov)

    // On iOS the touch pointers drive the pinch, not the gesture events.
    touch('pointerdown', 1, 250, 400)
    fire('gesturestart', { ...at, scale: 1 })
    fire('gesturechange', { ...at, scale: 3 })
    expect(state().skyFov).toBe(fov)
  })

  it('gives the element back', () => {
    const { listeners, cleanup } = panel()
    expect(listeners.size).toBeGreaterThan(0)
    cleanup()
    expect(listeners.size).toBe(0)
  })

  it('starts from the default view when not yet turned', () => {
    useStore.setState({ skyLook: null })
    const { touch } = panel()
    touch('pointerdown', 1, 250, 400)
    touch('pointerdown', 2, 350, 400)
    touch('pointermove', 1, 200, 400)
    touch('pointermove', 2, 400, 400)
    // Spread about the centre: the default look, zoomed.
    expect(state().skyLook!.altitude).toBeCloseTo(surfaceView(51.5).altitude, 6)
    expect(state().skyFov).toBeLessThan(SURFACE_FOV)
  })
})
