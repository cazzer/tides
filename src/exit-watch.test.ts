import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Object3D, PerspectiveCamera, Vector3 } from 'three'
import {
  HEARTBEAT_KEY,
  HEARTBEAT_MS,
  NOTICE_MAX_S,
  answerPings,
  answerPingsWhileShown,
  classifyExit,
  createExitWatch,
  describeExit,
  exitDetails,
  geoPose,
  isLoadAlive,
  settleExit,
  showsNotice,
  watchCamera,
  watchedCamera,
  type ChannelCtor,
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
  loadId: 'load-a',
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

  it('is none for another version, or without a load id', () => {
    expect(classifyExit(JSON.stringify({ ...record(), v: 2 }), 0).kind).toBe('none')
    expect(classifyExit(JSON.stringify({ ...record(), loadId: undefined }), 0).kind).toBe('none')
  })

  it('reads a record without the snapshot fields', () => {
    const minimal = { v: 1, loadId: 'x', sha: 's', t: 0, uptimeS: 0, state: 'visible', navType: 'reload', writeMs: 0 }
    const result = classifyExit(JSON.stringify(minimal), 2000)
    expect(result.kind).toBe('foreground')
    expect(exitDetails(result).map(([label]) => label)).toEqual(['last heartbeat', 'build', 'snapshot'])
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

describe('settleExit', () => {
  const foreground = classifyExit(JSON.stringify(record()), 1_002_000)

  it('drops a foreground kill whose page still answers: a duplicated tab', async () => {
    const isAlive = vi.fn(async () => true)
    expect((await settleExit(foreground, isAlive)).kind).toBe('none')
    expect(isAlive).toHaveBeenCalledWith('load-a')
  })

  it('keeps a foreground kill nobody answers for', async () => {
    expect(await settleExit(foreground, async () => false)).toBe(foreground)
  })

  it('asks nothing for the other kinds', async () => {
    const isAlive = vi.fn(async () => true)
    const background = classifyExit(JSON.stringify(record({ state: 'hidden' })), 0)
    expect(await settleExit(background, isAlive)).toBe(background)
    expect(await settleExit({ kind: 'none' }, isAlive)).toEqual({ kind: 'none' })
    expect(isAlive).not.toHaveBeenCalled()
  })
})

describe('showsNotice', () => {
  it('shows only for a recent foreground kill', () => {
    const at = (state: Heartbeat['state'], seconds: number) =>
      classifyExit(JSON.stringify(record({ state })), 1_000_000 + seconds * 1000)
    expect(showsNotice(at('visible', 4))).toBe(true)
    expect(showsNotice(at('visible', NOTICE_MAX_S + 1))).toBe(false)
    expect(showsNotice(at('hidden', 4))).toBe(false)
    expect(showsNotice(at('clean', 4))).toBe(false)
    expect(showsNotice({ kind: 'none' })).toBe(false)
    expect(showsNotice(null)).toBe(false)
  })
})

// BroadcastChannel's delivery: async, to every other instance of the name.
function channelBus(): ChannelCtor {
  const open = new Set<FakeChannel>()
  class FakeChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null
    constructor(readonly name: string) {
      open.add(this)
    }
    postMessage(data: unknown) {
      for (const other of open) {
        if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data }))
      }
    }
    close() {
      open.delete(this)
    }
  }
  return FakeChannel
}

describe('isLoadAlive', () => {
  it('is true when the page of that load answers', async () => {
    const Channel = channelBus()
    const stop = answerPings('load-a', Channel)
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 50 })).toBe(true)
    stop()
  })

  it('is false when only other loads answer, or none', async () => {
    const Channel = channelBus()
    const stop = answerPings('load-b', Channel)
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(false)
    stop()
    expect(await isLoadAlive('load-b', { Channel, timeoutMs: 20 })).toBe(false)
  })

  it('is false without BroadcastChannel', async () => {
    // A live page on the runtime's channel, which the null Channel must not reach.
    const stop = answerPings('load-a')
    expect(await isLoadAlive('load-a', { Channel: null, timeoutMs: 20 })).toBe(false)
    expect(() => answerPings('load-a', null)()).not.toThrow()
    stop()
  })

  it('counts a pong that arrives as the timer fires', async () => {
    vi.useFakeTimers()
    try {
      const Channel = channelBus()
      const late = new Channel('tides.exit')
      late.onmessage = () => setTimeout(() => late.postMessage({ type: 'pong', loadId: 'load-a' }), 20)
      const alive = isLoadAlive('load-a', { Channel, timeoutMs: 20 })
      await vi.advanceTimersByTimeAsync(20)
      await vi.advanceTimersByTimeAsync(1)
      expect(await alive).toBe(true)
      late.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('works over the runtime BroadcastChannel', async () => {
    const stop = answerPings('load-real')
    expect(await isLoadAlive('load-real', { timeoutMs: 200 })).toBe(true)
    stop()
  })
})

describe('answerPingsWhileShown', () => {
  it('stops answering on pagehide and answers again after a back-forward cache restore', async () => {
    const Channel = channelBus()
    const win = new EventTarget()
    const stop = answerPingsWhileShown('load-a', win, Channel)
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(true)
    win.dispatchEvent(pageEvent('pagehide', true))
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(false)
    win.dispatchEvent(pageEvent('pageshow', false))
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(false)
    win.dispatchEvent(pageEvent('pageshow', true))
    win.dispatchEvent(pageEvent('pageshow', true))
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(true)
    stop()
    expect(await isLoadAlive('load-a', { Channel, timeoutMs: 20 })).toBe(false)
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
  removeItem(key: string) {
    this.data.delete(key)
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

  const start = (
    store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = storage,
    snapshot: () => ExitSnapshot | null = () => SNAPSHOT
  ) => {
    stop = createExitWatch({
      storage: store,
      doc,
      win,
      now: () => clock,
      snapshot,
      loadId: 'load-a',
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

  it('beats again on visible after a pagehide that kept the page (iOS)', () => {
    start()
    win.dispatchEvent(pageEvent('pagehide', false))
    doc.set('hidden')
    expect(next().kind).toBe('clean')
    doc.set('visible')
    const writes = storage.writes
    advance(HEARTBEAT_MS * 2)
    expect(storage.writes).toBe(writes + 2)
    expect(next().kind).toBe('foreground')
    doc.set('hidden')
    expect(next().kind).toBe('background')
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

  it('still writes, and still marks clean, when the snapshot throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    start(storage, () => {
      throw new Error('context gone')
    })
    advance(HEARTBEAT_MS * 2)
    expect(storage.writes).toBe(3)
    const beating = next()
    expect(beating.kind).toBe('foreground')
    expect(beating.record?.loadId).toBe('load-a')
    expect(beating.record?.view).toBeUndefined()
    win.dispatchEvent(pageEvent('pagehide', false))
    expect(next().kind).toBe('clean')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('writes a record without the snapshot before there is one', () => {
    start(storage, () => null)
    expect(next().kind).toBe('foreground')
    expect(next().record?.pose).toBeUndefined()
  })

  it('removes the record when the storage starts throwing', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    start()
    advance(HEARTBEAT_MS)
    expect(next().kind).toBe('foreground')
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    advance(HEARTBEAT_MS)
    expect(storage.getItem(HEARTBEAT_KEY)).toBeNull()
    expect(next().kind).toBe('none')
  })

  it('turns off on a throwing storage, with one console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
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
