import { describe, expect, test } from 'vitest'
import { HOLD_REFRESH_MS, MAX_CACHED_FRAMES, planCloudFrames, SETTLE_MS } from '../cloud-frames'
import { sourceKey } from '../real-clouds'
import { createRealCloudController, type ImagerySource } from './realCloudController'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const at = (iso: string) => Date.parse(iso)

interface FakeTexture {
  name: string
  disposed: boolean
}

interface FakeBuild {
  key: string
  source: ImagerySource
  signal: AbortSignal
  startedAt: number
  done: boolean
  resolve: (t: FakeTexture | null) => void
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function finish(b: FakeBuild, t: FakeTexture | null) {
  b.done = true
  b.resolve(t)
}

const texture = (name: string): FakeTexture => ({ name, disposed: false })

/** The frame keys a paused (or playing) plan wants for a sim time. */
const keys = (iso: string, timeScale = 0) =>
  planCloudFrames(at(iso), timeScale, NOW).frames.map((f) => f.key)

function setup() {
  const builds: FakeBuild[] = []
  let wall = 0
  const controller = createRealCloudController<FakeTexture>({
    build: (source, _staticUrl, signal) =>
      new Promise((resolve) => {
        builds.push({ key: sourceKey(source), source, signal, startedAt: wall, done: false, resolve })
      }),
    dispose: (t) => {
      t.disposed = true
    },
  })
  const tick = (
    sim: number,
    { timeScale = 0, jumpTo = null }: { timeScale?: number; jumpTo?: number | null } = {}
  ) => controller.tick(sim, jumpTo, timeScale, wall, NOW, 'static.jpg')
  /** Wants `iso` (paused) long enough for it to commit. */
  const go = (iso: string) => {
    tick(at(iso))
    wall += SETTLE_MS
    tick(at(iso))
  }
  const pending = () => builds.filter((b) => !b.done && !b.signal.aborted)
  const snap = () => controller.getSnapshot()
  const setWall = (ms: number) => {
    wall = ms
  }
  return { controller, builds, tick, go, pending, snap, setWall }
}

describe('realCloudController', () => {
  test('at most two build at once, the wanted frames first', async () => {
    const { builds, tick, snap } = setup()
    const sim = '2026-10-17T06:43:00Z'
    tick(at(sim), { timeScale: 1 })
    const [a, b, c] = keys(sim, 1)
    expect(builds.map((x) => x.key)).toEqual([a, b])
    expect(snap()).toMatchObject({ texture: null, status: 'loading' })
    const ta = texture('A')
    finish(builds[0], ta)
    await flush()
    expect(builds.map((x) => x.key)).toEqual([a, b, c])
    expect(snap()).toMatchObject({ texture: ta, status: 'ready' })
    expect(snap().frames.map((f) => f.status)).toEqual(['ready', 'loading', 'loading'])
  })

  test('a frame with no imagery fails; static frames need no build', async () => {
    const { builds, go, snap } = setup()
    go('2024-10-09T12:00:00Z')
    finish(builds[0], null)
    await flush()
    expect(snap()).toMatchObject({ texture: null, status: 'failed' })
    go('1950-01-01T00:00:00Z')
    expect(snap()).toMatchObject({
      texture: null,
      source: { kind: 'static', reason: 'before-coverage' },
      status: 'ready',
    })
    expect(builds).toHaveLength(2)
  })

  test('stepping on keeps builds going; a jump aborts the ones it does not need', async () => {
    const { builds, tick, go, pending, setWall } = setup()
    tick(at('2026-10-17T06:43:00Z'))
    const [first, second] = keys('2026-10-17T06:43:00Z')
    // Ten sim minutes on: the next step along commits at once.
    setWall(16)
    tick(at('2026-10-17T06:53:00Z'))
    expect(builds.map((b) => b.signal.aborted)).toEqual([false, false])
    const ta = texture('A')
    finish(builds[0], ta)
    await flush()
    // The freed slot goes to the new plan's next frame.
    expect(builds.map((b) => b.key)).toEqual([first, second, keys('2026-10-17T06:53:00Z')[1]])

    setWall(1000)
    go('2024-10-09T12:00:00Z')
    expect(builds[1].signal.aborted).toBe(true)
    expect(builds[2].signal.aborted).toBe(true)
    expect(pending().map((b) => b.key)).toEqual(keys('2024-10-09T12:00:00Z'))
    const late = texture('late')
    finish(builds[1], late)
    await flush()
    expect(late.disposed).toBe(true)
    expect(ta.disposed).toBe(false)

    // The frame that finished while moving on is still cached.
    const before = builds.length
    go('2026-10-17T06:43:00Z')
    expect(builds.slice(before).map((b) => b.key)).not.toContain(first)
  })

  test('the cache keeps the last five and never the frames in the plan', async () => {
    const { go, pending, snap } = setup()
    const made: FakeTexture[] = []
    for (let day = 1; day <= 6; day++) {
      go(`2024-10-0${day}T12:00:00Z`)
      for (const b of pending()) {
        const t = texture(b.key)
        made.push(t)
        finish(b, t)
      }
      await flush()
      for (const f of snap().frames) expect(f.texture?.disposed).toBe(false)
    }
    // Days 1 to 7 were built; the oldest two are gone.
    expect(made.map((t) => t.disposed)).toEqual([true, true, false, false, false, false, false])
    expect(made.filter((t) => !t.disposed)).toHaveLength(MAX_CACHED_FRAMES)
  })

  test('deactivate aborts builds and keeps the cache', async () => {
    const { controller, builds, go, snap } = setup()
    go('2024-10-09T12:00:00Z')
    const a = texture('A')
    finish(builds[0], a)
    await flush()
    controller.deactivate()
    expect(builds[1].signal.aborted).toBe(true)
    expect(snap()).toEqual({ frames: [], texture: null, source: null, status: 'loading' })
    const late = texture('late')
    finish(builds[1], late)
    await flush()
    expect(late.disposed).toBe(true)
    go('2024-10-09T12:00:00Z')
    expect(builds.slice(2).map((b) => b.key)).toEqual([builds[1].key])
    expect(snap()).toMatchObject({ texture: a, status: 'ready' })
  })

  test('the snapshot is the same object across ticks with no change', async () => {
    const { controller, builds, go, tick, snap, setWall } = setup()
    go('2024-10-09T12:00:00Z')
    finish(builds[0], texture('A'))
    finish(builds[1], texture('B'))
    await flush()
    const before = snap()
    let notified = 0
    const unsubscribe = controller.subscribe(() => notified++)
    for (let i = 0; i < 10; i++) {
      setWall(100_000 + i * 16)
      tick(at('2024-10-09T13:00:00Z'))
    }
    unsubscribe()
    expect(snap()).toBe(before)
    expect(notified).toBe(0)
  })

  /** Plays at `timeScale` from `from` for wallMs, ticking every 16 ms, with
   * builds that take buildMs. Returns the builds and the primary frames shown,
   * in order. */
  async function play(from: string, timeScale: number, wallMs: number, buildMs: number) {
    const { builds, tick, snap, setWall } = setup()
    const start = at(from)
    const shown: string[] = []
    for (let wall = 0; wall <= wallMs; wall += 16) {
      setWall(wall)
      tick(start + wall * timeScale, { timeScale })
      const due = builds.filter((b) => !b.done && wall - b.startedAt >= buildMs)
      for (const b of due) finish(b, texture(b.key))
      if (due.length) await flush()
      const { source, status } = snap()
      const key = source ? sourceKey(source) : null
      if (key && status === 'ready' && shown[shown.length - 1] !== key) shown.push(key)
    }
    return { builds, shown }
  }

  test('an hour per second moves on every few seconds', async () => {
    const { builds, shown } = await play('2026-10-17T00:00:00Z', 3600, 30_000, 1000)
    expect(shown.length).toBeGreaterThanOrEqual(8)
    // A 3-hour cadence over 30 sim hours, plus the bracket and prefetch.
    expect(builds.length).toBeLessThanOrEqual(14)
    expect(builds.every((b) => !b.signal.aborted)).toBe(true)
  })

  test('a day per second refreshes the held frame no faster than HOLD_REFRESH_MS', async () => {
    const { builds } = await play('2026-08-01T00:00:00Z', 86_400, 20_000, 1000)
    const starts = builds.map((b) => b.startedAt)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(HOLD_REFRESH_MS)
    }
    expect(builds.length).toBeGreaterThanOrEqual(3)
  })

  test('a jump fetches only what the target needs', () => {
    const { builds, tick, setWall } = setup()
    const start = at('2024-10-09T12:00:00Z')
    tick(start)
    const from = builds.length
    const target = at('2026-10-17T06:43:00Z')
    for (let wall = 16; wall <= 3000; wall += 16) {
      setWall(wall)
      tick(start + ((target - start) * Math.min(wall, 2000)) / 2000, { jumpTo: target })
    }
    expect(builds.slice(from).map((b) => b.key)).toEqual(keys('2026-10-17T06:43:00Z'))
  })
})
