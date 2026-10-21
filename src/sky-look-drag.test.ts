import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { surfaceView } from './sky'
import { DOUBLE_TAP_MS, DRAG_THRESHOLD } from './sky-look'
import { lookOnDrag, type Reset } from './sky-look-drag'

type Listener = (event: PointerEvent) => void

// Just enough of the panel's div to drive the handlers.
function panel() {
  const listeners = new Map<string, Listener>()
  const captured: number[] = []
  const element = {
    style: { touchAction: '', cursor: '' } as CSSStyleDeclaration,
    clientHeight: 800,
    setPointerCapture: (id: number) => captured.push(id),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  let time = 0
  const fire = (
    type: string,
    x: number,
    y: number,
    { id = 1, buttons = type === 'pointerup' ? 0 : 1, after = 16 } = {}
  ) => {
    time += after
    listeners.get(type)?.({
      type,
      pointerId: id,
      pointerType: 'touch',
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
      timeStamp: time,
    } as PointerEvent)
  }
  const reset = { current: null as Reset | null }
  const cleanup = lookOnDrag(element as unknown as HTMLElement, reset)
  return { element, listeners, captured, fire, reset, cleanup }
}

const look = () => useStore.getState().skyLook

describe('dragging View from Earth (tides-2dp)', () => {
  beforeEach(() => useStore.setState({ skyLook: null, location: { lat: 51.5, lon: 0 } }))

  it('keeps short presses as taps and drags past the threshold', () => {
    const { fire, captured } = panel()
    fire('pointerdown', 100, 100)
    fire('pointermove', 100 + DRAG_THRESHOLD - 1, 100)
    fire('pointerup', 100 + DRAG_THRESHOLD - 1, 100)
    expect(look()).toBeNull()
    expect(captured).toEqual([1])

    fire('pointerdown', 100, 100, { after: 1000 })
    fire('pointermove', 100 + DRAG_THRESHOLD + 1, 100)
    fire('pointerup', 100 + DRAG_THRESHOLD + 1, 100)
    // Dragging right turns the view left (west of the default south).
    expect(look()!.azimuth).toBeLessThan(surfaceView(51.5).azimuth)
    expect(look()!.altitude).toBeCloseTo(surfaceView(51.5).altitude, 9)
  })

  it('looks up on a drag down', () => {
    const { fire } = panel()
    fire('pointerdown', 100, 100)
    fire('pointermove', 100, 300)
    expect(look()!.altitude).toBeGreaterThan(surfaceView(51.5).altitude)
  })

  it('resets on a double tap, not two slow taps', () => {
    const { fire, reset } = panel()
    useStore.setState({ skyLook: { azimuth: 10, altitude: 70 } })
    fire('pointerdown', 50, 50)
    fire('pointerup', 50, 50)
    fire('pointerdown', 52, 50, { after: DOUBLE_TAP_MS + 10 })
    fire('pointerup', 52, 50)
    expect(reset.current).toBeNull()
    fire('pointerdown', 52, 52, { after: 100 })
    fire('pointerup', 52, 52)
    expect(reset.current?.from).toEqual({ azimuth: 10, altitude: 70 })
  })

  it('follows one pointer only', () => {
    const { fire } = panel()
    fire('pointerdown', 100, 100, { id: 1 })
    fire('pointerdown', 300, 100, { id: 2 })
    fire('pointermove', 400, 400, { id: 2 })
    expect(look()).toBeNull()
    fire('pointermove', 100, 300, { id: 1 })
    expect(look()).not.toBeNull()
  })

  it('drops a press whose release was lost', () => {
    const { fire } = panel()
    fire('pointerdown', 100, 100)
    // Hovering with no button down must not turn the sky.
    fire('pointermove', 200, 200, { buttons: 0 })
    fire('pointermove', 300, 300, { buttons: 0 })
    expect(look()).toBeNull()

    fire('pointerdown', 100, 100)
    fire('lostpointercapture', 100, 100)
    fire('pointermove', 300, 300)
    expect(look()).toBeNull()
  })

  it('lands a reset cut short, and gives the element back', () => {
    const { fire, reset, cleanup, element, listeners } = panel()
    expect(element.style.touchAction).toBe('none')
    useStore.setState({ skyLook: { azimuth: 10, altitude: 70 } })
    fire('pointerdown', 50, 50)
    fire('pointerup', 50, 50)
    fire('pointerdown', 50, 50)
    fire('pointerup', 50, 50)
    expect(reset.current).not.toBeNull()
    cleanup()
    expect(look()).toBeNull()
    expect(listeners.size).toBe(0)
    expect(element.style.touchAction).toBe('')
  })
})
