import { describe, expect, test } from 'vitest'
import { SETTLE_MS, type CloudSource } from '../real-clouds'
import { createRealCloudController, type GibsSource } from './realCloudController'

const NOW = Date.UTC(2026, 9, 18, 15, 30)

interface FakeTexture {
  name: string
  disposed: boolean
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup() {
  const builds: {
    source: GibsSource
    signal: AbortSignal
    resolve: (t: FakeTexture | null) => void
  }[] = []
  const controller = createRealCloudController<FakeTexture>({
    build: (source, _staticUrl, signal) => {
      const d = deferred<FakeTexture | null>()
      builds.push({ source, signal, resolve: d.resolve })
      return d.promise
    },
    dispose: (t) => {
      t.disposed = true
    },
  })
  let wall = 0
  /** Wants `date` long enough for it to commit. */
  const go = (date: string, jumpTo: string | null = null) => {
    const sim = Date.parse(`${date}T12:00:00Z`)
    const jump = jumpTo ? Date.parse(`${jumpTo}T12:00:00Z`) : null
    controller.tick(sim, jump, wall, NOW, 'static.jpg')
    wall += SETTLE_MS
    controller.tick(sim, jump, wall, NOW, 'static.jpg')
  }
  const texture = (name: string): FakeTexture => ({ name, disposed: false })
  const snap = () => controller.getSnapshot()
  const date = (source: CloudSource | null) =>
    source?.kind === 'gibs' ? source.date : source?.kind
  return { controller, builds, go, texture, snap, date }
}

describe('realCloudController', () => {
  test('the first day loads at once and shows when ready', async () => {
    const { builds, go, texture, snap, date } = setup()
    go('2024-10-09')
    expect(builds).toHaveLength(1)
    expect(snap()).toMatchObject({ texture: null, status: 'loading' })
    expect(date(snap().source)).toBe('2024-10-09')
    const t = texture('a')
    builds[0].resolve(t)
    await flush()
    expect(snap()).toMatchObject({ texture: t, status: 'ready' })
  })

  test('a build that finds no imagery shows the static clouds as failed', async () => {
    const { builds, go, snap } = setup()
    go('2024-10-09')
    builds[0].resolve(null)
    await flush()
    expect(snap()).toMatchObject({ texture: null, status: 'failed' })
  })

  test('A -> B -> A while A builds: superseded builds are aborted and ignored', async () => {
    const { builds, go, texture, snap, date } = setup()
    go('2024-10-09')
    go('2024-10-10')
    expect(builds[0].signal.aborted).toBe(true)
    go('2024-10-09')
    expect(builds[1].signal.aborted).toBe(true)
    expect(builds).toHaveLength(3)
    expect(date(builds[2].source)).toBe('2024-10-09')

    const lateA = texture('late A')
    const lateB = texture('late B')
    builds[0].resolve(lateA)
    builds[1].resolve(lateB)
    await flush()
    expect(lateA.disposed).toBe(true)
    expect(lateB.disposed).toBe(true)
    expect(snap()).toMatchObject({ texture: null, status: 'loading' })
    expect(date(snap().source)).toBe('2024-10-09')

    const a = texture('A')
    builds[2].resolve(a)
    await flush()
    expect(snap()).toMatchObject({ texture: a, status: 'ready' })
  })

  test('wanting the in-flight day again starts no second build', () => {
    const { controller, builds, go } = setup()
    go('2024-10-09')
    controller.deactivate()
    go('2024-10-09')
    go('2024-10-09')
    expect(builds).toHaveLength(2)
    expect(builds[1].signal.aborted).toBe(false)
  })

  test('a cached day shows at once and aborts the build in flight', async () => {
    const { builds, go, texture, snap } = setup()
    go('2024-10-09')
    const c = texture('C')
    builds[0].resolve(c)
    await flush()
    go('2024-10-10')
    expect(snap()).toMatchObject({ texture: c, status: 'loading' })
    go('2024-10-09')
    expect(builds[1].signal.aborted).toBe(true)
    expect(snap()).toMatchObject({ texture: c, status: 'ready' })

    const late = texture('late D')
    builds[1].resolve(late)
    await flush()
    expect(late.disposed).toBe(true)
    expect(snap().texture).toBe(c)
    expect(builds).toHaveLength(2)
  })

  test('A -> static while A builds shows static clouds and caches nothing', async () => {
    const { builds, go, texture, snap } = setup()
    go('2024-10-09')
    go('2024-10-09', '1950-01-01')
    expect(builds[0].signal.aborted).toBe(true)
    expect(snap()).toEqual({
      texture: null,
      source: { kind: 'static', reason: 'before-coverage' },
      status: 'ready',
    })
    const late = texture('late A')
    builds[0].resolve(late)
    await flush()
    expect(late.disposed).toBe(true)
    expect(snap().texture).toBeNull()
    go('2024-10-09')
    expect(builds).toHaveLength(2)
  })

  test('static clouds replace a displayed real texture', async () => {
    const { builds, go, texture, snap } = setup()
    go('2024-10-09')
    builds[0].resolve(texture('A'))
    await flush()
    go('1950-01-01')
    expect(snap()).toMatchObject({ texture: null, status: 'ready' })
  })

  test('deactivate mid-build discards the late result and does not cache it', async () => {
    const { controller, builds, go, texture, snap } = setup()
    go('2024-10-09')
    controller.deactivate()
    expect(builds[0].signal.aborted).toBe(true)
    expect(snap()).toEqual({ texture: null, source: null, status: 'loading' })
    const late = texture('late')
    builds[0].resolve(late)
    await flush()
    expect(late.disposed).toBe(true)
    expect(snap().texture).toBeNull()
    go('2024-10-09')
    expect(builds).toHaveLength(2)
  })

  test('deactivate keeps the cache for when Real weather returns', async () => {
    const { controller, builds, go, texture, snap } = setup()
    go('2024-10-09')
    const a = texture('A')
    builds[0].resolve(a)
    await flush()
    controller.deactivate()
    go('2024-10-09')
    expect(builds).toHaveLength(1)
    expect(snap()).toMatchObject({ texture: a, status: 'ready' })
  })

  test('eviction keeps three days and never disposes the displayed texture', async () => {
    const { builds, go, texture, snap } = setup()
    const days = ['2024-10-01', '2024-10-02', '2024-10-03']
    const textures = days.map(texture)
    for (const [i, day] of days.entries()) {
      go(day)
      builds[i].resolve(textures[i])
      await flush()
    }
    go('2024-10-01') // cached: shown again, now the most recently used
    expect(snap().texture).toBe(textures[0])
    go('2024-10-04')
    const fourth = texture('2024-10-04')
    builds[3].resolve(fourth)
    await flush()
    expect(textures.map((t) => t.disposed)).toEqual([false, true, false])
    expect(fourth.disposed).toBe(false)
    expect(snap().texture).toBe(fourth)
  })

  test('the snapshot is the same object across ticks with no change', async () => {
    const { controller, builds, go, texture, snap } = setup()
    go('2024-10-09')
    builds[0].resolve(texture('A'))
    await flush()
    const before = snap()
    let notified = 0
    const unsubscribe = controller.subscribe(() => notified++)
    for (let i = 0; i < 10; i++) {
      controller.tick(Date.parse('2024-10-09T13:00:00Z'), null, 100_000 + i * 16, NOW, 'static.jpg')
    }
    unsubscribe()
    expect(snap()).toBe(before)
    expect(notified).toBe(0)
  })
})
