import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NORTH_TIMEOUT, SENSOR_TIMEOUT, followDeviceOrientation, type Silence } from './compass-follow'
import type { SkyLook } from './sky-look'

type Listener = (event: Event) => void

// Just enough of window and screen to drive the follower.
function stubWindow({ absoluteEvents }: { absoluteEvents: boolean }) {
  const listeners = new Map<string, Listener>()
  const win: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  if (absoluteEvents) win.ondeviceorientationabsolute = null
  vi.stubGlobal('window', win)
  vi.stubGlobal('screen', { orientation: { angle: 0 } })
  let time = 0
  const fire = (type: string, reading: Record<string, unknown>) => {
    time += 16
    listeners.get(type)?.({ timeStamp: time, ...reading } as unknown as Event)
  }
  return { listeners, fire }
}

function follow() {
  const looks: SkyLook[] = []
  const silences: Silence[] = []
  const cleanup = followDeviceOrientation(
    (look) => looks.push(look),
    (silence) => silences.push(silence)
  )
  return { looks, silences, cleanup }
}

describe('following the device orientation (tides-d5j)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('listens for north-referenced readings where Chrome offers them', () => {
    const { listeners, fire } = stubWindow({ absoluteEvents: true })
    const { looks, silences, cleanup } = follow()
    expect([...listeners.keys()]).toEqual(['deviceorientationabsolute'])
    fire('deviceorientationabsolute', { alpha: 0, beta: 130, gamma: 0, absolute: true })
    expect(looks).toHaveLength(1)
    expect(looks[0].azimuth).toBeCloseTo(0, 6)
    expect(looks[0].altitude).toBeCloseTo(40, 6)
    vi.advanceTimersByTime(NORTH_TIMEOUT)
    expect(silences).toEqual([])
    cleanup()
    expect(listeners.size).toBe(0)
  })

  it('reads iOS headings from deviceorientation', () => {
    const { listeners, fire } = stubWindow({ absoluteEvents: false })
    const { looks } = follow()
    expect([...listeners.keys()]).toEqual(['deviceorientation'])
    // Facing east, its own alpha reading 12.
    fire('deviceorientation', { alpha: 12, beta: 60, gamma: 0, absolute: false, webkitCompassHeading: 90 })
    expect(looks[0].azimuth).toBeCloseTo(90, 6)
    expect(looks[0].altitude).toBeCloseTo(-30, 6)
  })

  it('gives up when no sensor answers', () => {
    const { fire } = stubWindow({ absoluteEvents: true })
    const { silences } = follow()
    // Desktop Chrome may send one empty reading.
    fire('deviceorientationabsolute', { alpha: null, beta: null, gamma: null, absolute: true })
    vi.advanceTimersByTime(SENSOR_TIMEOUT)
    expect(silences).toEqual(['no-sensor'])
    vi.advanceTimersByTime(NORTH_TIMEOUT)
    expect(silences).toEqual(['no-sensor'])
  })

  it('waits for a calibrating compass, then gives up on north', () => {
    const { fire } = stubWindow({ absoluteEvents: false })
    const { looks, silences } = follow()
    fire('deviceorientation', { alpha: 0, beta: 60, gamma: 0, absolute: false, webkitCompassHeading: -1 })
    vi.advanceTimersByTime(SENSOR_TIMEOUT)
    expect(silences).toEqual([])
    vi.advanceTimersByTime(NORTH_TIMEOUT - SENSOR_TIMEOUT)
    expect(looks).toEqual([])
    expect(silences).toEqual(['no-north'])
  })

  it('stops its timers on cleanup', () => {
    stubWindow({ absoluteEvents: true })
    const { silences, cleanup } = follow()
    cleanup()
    vi.advanceTimersByTime(NORTH_TIMEOUT)
    expect(silences).toEqual([])
  })
})
