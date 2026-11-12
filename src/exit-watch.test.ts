import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Object3D, PerspectiveCamera, Vector3 } from 'three'
import {
  HEARTBEAT_KEY,
  HEARTBEAT_MS,
  classifyExit,
  createExitWatch,
  describeExit,
  geoPose,
  watchCamera,
  watchedCamera,
  type ExitSnapshot,
  type Heartbeat,
} from './exit-watch'

const SNAPSHOT: ExitSnapshot = {
  view: { focus: 'earth', closeZoom: true, closeZoomTiles: true, ship: false, demo: null },
  pose: { latDeg: 36.1, lonDeg: -112.1, altKm: 2.5, tiltDeg: 80 },
  dpr: 2,
  canvas: [1170, 2532],
  mem: { textures: 120, geometries: 300, programs: 45 },
  ctxLost: false,
}

const record = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  v: 1,
  sha: 'abc1234',
  t: 1_000_000,
  uptimeS: 40,
  state: 'visible',
  navType: 'navigate',
  writeMs: 0.05,
  ...SNAPSHOT,
  ...over,
})

describe('classifyExit', () => {
  it('is none without a heartbeat', () => {
    expect(classifyExit(null, 0)).toEqual({ kind: 'none' })
  })

  it('is none for malformed JSON or a record it does not know', () => {
    expect(classifyExit('{not json', 0).kind).toBe('none')
    expect(classifyExit('"a string"', 0).kind).toBe('none')
    expect(classifyExit(JSON.stringify({ v: 1, t: 5 }), 0).kind).toBe('none')
    expect(classifyExit(JSON.stringify({ ...record(), state: 'gone' }), 0).kind).toBe('none')
  })

  it('is none for another version', () => {
    expect(classifyExit(JSON.stringify({ ...record(), v: 2 }), 0).kind).toBe('none')
  })

  it('reads clean, background (hidden) and foreground (visible)', () => {
    expect(classifyExit(JSON.stringify(record({ state: 'clean' })), 0).kind).toBe('clean')
    expect(classifyExit(JSON.stringify(record({ state: 'hidden' })), 0).kind).toBe('background')
    expect(classifyExit(JSON.stringify(record({ state: 'visible' })), 0).kind).toBe('foreground')
  })

  it('gives the seconds since the last heartbeat', () => {
    const result = classifyExit(JSON.stringify(record({ t: 1_000_000 })), 1_012_500)
    expect(result.secondsSince).toBe(12.5)
    expect(result.record?.sha).toBe('abc1234')
  })
})

describe('describeExit', () => {
  it('is null for none and clean', () => {
    expect(describeExit({ kind: 'none' })).toBeNull()
    expect(describeExit(classifyExit(JSON.stringify(record({ state: 'clean' })), 0))).toBeNull()
  })

  it('names the kind, pose, dpr and GL memory of an unclean exit', () => {
    const line = describeExit(classifyExit(JSON.stringify(record()), 1_003_000))!
    expect(line).toContain('unclean exit (foreground)')
    expect(line).toContain('3 s before this load')
    expect(line).toContain('36.100°, -112.100°, 2.50 km, tilt 80.0°')
    expect(line).toContain('dpr 2, canvas 1170×2532')
    expect(line).toContain('120 textures, 300 geometries, 45 programs')
  })
})

class FakeStorage {
  data = new Map<string, string>()
  writes = 0
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.writes++
    this.data.set(key, value)
  }
}

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
  set(state: DocumentVisibilityState) {
    this.visibilityState = state
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

const pageEvent = (type: string, persisted: boolean) =>
  Object.assign(new Event(type), { persisted })

describe('createExitWatch', () => {
  let storage: FakeStorage
  let doc: FakeDoc
  let win: EventTarget
  let clock: number
  let stop: () => void

  const start = (store: Pick<Storage, 'getItem' | 'setItem'> | null = storage) => {
    stop = createExitWatch({
      storage: store,
      doc,
      win,
      now: () => clock,
      snapshot: () => SNAPSHOT,
      sha: 'abc1234',
      navType: 'navigate',
    })
  }
  const advance = (ms: number) => {
    clock += ms
    vi.advanceTimersByTime(ms)
  }
  const next = () => classifyExit(storage.getItem(HEARTBEAT_KEY), clock)

  beforeEach(() => {
    vi.useFakeTimers()
    storage = new FakeStorage()
    doc = new FakeDoc()
    win = new EventTarget()
    clock = 1_000_000
  })
  afterEach(() => {
    stop?.()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a running heartbeat with no events reads as a foreground kill', () => {
    start()
    advance(HEARTBEAT_MS * 3)
    expect(storage.writes).toBe(4)
    const result = next()
    expect(result.kind).toBe('foreground')
    expect(result.record?.uptimeS).toBe(6)
    expect(result.record?.pose).toEqual(SNAPSHOT.pose)
  })

  it('pagehide marks a clean exit, even with visibilitychange after it', () => {
    start()
    advance(HEARTBEAT_MS)
    win.dispatchEvent(pageEvent('pagehide', false))
    doc.set('hidden')
    advance(HEARTBEAT_MS * 2)
    expect(next().kind).toBe('clean')
  })

  it('hidden without pagehide reads as a background kill', () => {
    start()
    doc.set('hidden')
    expect(next().kind).toBe('background')
  })

  it('writes nothing while hidden', () => {
    start()
    doc.set('hidden')
    const writes = storage.writes
    advance(HEARTBEAT_MS * 10)
    expect(storage.writes).toBe(writes)
  })

  it('starts hidden in a background tab', () => {
    doc.visibilityState = 'hidden'
    start()
    advance(HEARTBEAT_MS * 3)
    expect(storage.writes).toBe(1)
    expect(next().kind).toBe('background')
  })

  it('beats again once visible', () => {
    start()
    doc.set('hidden')
    doc.set('visible')
    expect(next().kind).toBe('foreground')
    const writes = storage.writes
    advance(HEARTBEAT_MS)
    expect(storage.writes).toBe(writes + 1)
  })

  it('comes back from the back-forward cache visible and beating', () => {
    start()
    win.dispatchEvent(pageEvent('pagehide', true))
    expect(next().kind).toBe('clean')
    win.dispatchEvent(pageEvent('pageshow', true))
    expect(next().kind).toBe('foreground')
    const writes = storage.writes
    advance(HEARTBEAT_MS)
    expect(storage.writes).toBe(writes + 1)
  })

  it('ignores the first load pageshow', () => {
    start()
    win.dispatchEvent(pageEvent('pagehide', false))
    win.dispatchEvent(pageEvent('pageshow', false))
    expect(next().kind).toBe('clean')
  })

  it('stops writing once stopped', () => {
    start()
    stop()
    const writes = storage.writes
    advance(HEARTBEAT_MS * 3)
    doc.set('hidden')
    expect(storage.writes).toBe(writes)
  })

  it('turns off on a throwing storage, with one console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => start(throwing)).not.toThrow()
    expect(() => {
      advance(HEARTBEAT_MS * 3)
      doc.set('hidden')
      win.dispatchEvent(pageEvent('pagehide', false))
    }).not.toThrow()
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('turns off without storage, with one console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(() => start(null)).not.toThrow()
    advance(HEARTBEAT_MS * 3)
    expect(info).toHaveBeenCalledTimes(1)
  })
})

describe('geoPose', () => {
  const R = 3
  const earth = new Object3D()
  earth.position.set(10, -4, 7)
  earth.rotation.set(0.3, 1.1, -0.2)
  earth.updateMatrixWorld()
  // The world point over (lat, lon) radians at `r` (Earth's frame: Y north, lon 0 at +X, east toward -Z).
  const over = (lat: number, lon: number, r: number) =>
    earth.localToWorld(
      new Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)).multiplyScalar(r)
    )
  const centre = earth.getWorldPosition(new Vector3())

  it('reads 637 km over lat 0, lon 0 at 1.1 radii', () => {
    const eye = over(0, 0, 1.1 * R)
    const pose = geoPose(eye, centre.clone().sub(eye), earth, R)!
    expect(pose.altKm).toBeCloseTo(637.1, 1)
    expect(pose.latDeg).toBeCloseTo(0, 6)
    expect(pose.lonDeg).toBeCloseTo(0, 6)
  })

  it('reads the latitude and longitude of the eye', () => {
    const eye = over((30 * Math.PI) / 180, (-45 * Math.PI) / 180, 2 * R)
    const pose = geoPose(eye, new Vector3(1, 0, 0), earth, R)!
    expect(pose.latDeg).toBeCloseTo(30, 6)
    expect(pose.lonDeg).toBeCloseTo(-45, 6)
  })

  it('is tilt 0 looking at the centre and 90 along the tangent', () => {
    const eye = over(0.4, 1.2, 1.5 * R)
    const down = centre.clone().sub(eye)
    expect(geoPose(eye, down, earth, R)!.tiltDeg).toBeCloseTo(0, 4)
    const tangent = new Vector3().crossVectors(down, new Vector3(0.3, 1, 0.1)).normalize()
    expect(geoPose(eye, tangent, earth, R)!.tiltDeg).toBeCloseTo(90, 4)
  })

  it('is null at the centre', () => {
    expect(geoPose(centre.clone(), new Vector3(1, 0, 0), earth, R)).toBeNull()
  })
})

describe('watchCamera', () => {
  it('clears only the camera it registered', () => {
    const a = new PerspectiveCamera()
    const b = new PerspectiveCamera()
    const unwatchA = watchCamera(a)
    const unwatchB = watchCamera(b)
    unwatchA()
    expect(watchedCamera()).toBe(b)
    unwatchB()
    expect(watchedCamera()).toBeNull()
  })
})
