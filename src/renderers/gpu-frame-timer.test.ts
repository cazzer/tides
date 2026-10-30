import { describe, expect, it, vi } from 'vitest'
import { createGpuFrameTimer } from './gpu-frame-timer'

const TIME_ELAPSED_EXT = 0x88bf
const GPU_DISJOINT_EXT = 0x8fbb
const QUERY_RESULT = 0x8866
const QUERY_RESULT_AVAILABLE = 0x8867

interface FakeQuery {
  id: number
  available: boolean
  ns: number
}

/** Just the WebGL2 calls the timer makes; queries finish when a test says so. */
function fakeGl({ extension = true } = {}) {
  let nextId = 0
  const state = { lost: false, disjoint: false }
  const created: FakeQuery[] = []
  const gl = {
    QUERY_RESULT,
    QUERY_RESULT_AVAILABLE,
    getExtension: vi.fn((name: string) =>
      extension && name === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } : null,
    ),
    createQuery: vi.fn(() => {
      const query = { id: nextId++, available: false, ns: 0 }
      created.push(query)
      return query
    }),
    deleteQuery: vi.fn(),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    isContextLost: () => state.lost,
    getParameter: vi.fn((pname: number) => (pname === GPU_DISJOINT_EXT ? state.disjoint : null)),
    getQueryParameter: vi.fn((query: FakeQuery, pname: number) =>
      pname === QUERY_RESULT_AVAILABLE ? query.available : pname === QUERY_RESULT ? query.ns : null,
    ),
  }
  const begun = () => gl.beginQuery.mock.calls.map(([, query]) => query as FakeQuery)
  const finish = (query: FakeQuery, ns: number) => {
    query.available = true
    query.ns = ns
  }
  return { gl, state, created, begun, finish, context: gl as unknown as WebGL2RenderingContext }
}

/** Times `n` frames tagged by index. */
function frames(timer: NonNullable<ReturnType<typeof createGpuFrameTimer>>, n: number) {
  for (let i = 0; i < n; i++) {
    timer.begin(i)
    timer.end()
  }
}

describe('createGpuFrameTimer', () => {
  it('is null without the timer extension', () => {
    expect(createGpuFrameTimer(fakeGl({ extension: false }).context)).toBeNull()
  })

  it('never nests: a second begin before end starts no query', () => {
    const { context, gl } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    timer.begin(2)
    timer.begin(2)
    expect(gl.beginQuery).toHaveBeenCalledTimes(1)
    expect(gl.beginQuery).toHaveBeenCalledWith(TIME_ELAPSED_EXT, expect.anything())
    timer.end()
    timer.end()
    expect(gl.endQuery).toHaveBeenCalledTimes(1)
  })

  it('skips timing while every query awaits its result', () => {
    const { context, gl, begun, finish } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    frames(timer, 10)
    expect(gl.beginQuery).toHaveBeenCalledTimes(6)
    finish(begun()[0], 5e6)
    expect(timer.poll()).toEqual([{ ms: 5, tag: 0 }])
    frames(timer, 2)
    expect(gl.beginQuery).toHaveBeenCalledTimes(7)
  })

  it('reads results oldest first, stopping at the first unfinished', () => {
    const { context, begun, finish } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    timer.begin(2)
    timer.end()
    timer.begin(1.5)
    timer.end()
    timer.begin(1.25)
    timer.end()
    const [a, b, c] = begun()
    finish(a, 31_800_000)
    finish(c, 8_000_000)
    expect(timer.poll()).toEqual([{ ms: 31.8, tag: 2 }])
    expect(timer.poll()).toEqual([])
    finish(b, 12_500_000)
    expect(timer.poll()).toEqual([
      { ms: 12.5, tag: 1.5 },
      { ms: 8, tag: 1.25 },
    ])
  })

  it('discards everything in flight on a disjoint and reuses the queries', () => {
    const { context, gl, state, begun, finish } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    frames(timer, 6)
    for (const query of begun()) finish(query, 1e6)
    state.disjoint = true
    expect(timer.poll()).toEqual([])
    state.disjoint = false
    expect(timer.poll()).toEqual([])
    frames(timer, 6)
    expect(gl.beginQuery).toHaveBeenCalledTimes(12)
  })

  it('does nothing on a lost context', () => {
    const { context, gl, state, begun, finish } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    timer.begin(2)
    timer.end()
    finish(begun()[0], 1e6)
    state.lost = true
    timer.begin(2)
    timer.end()
    expect(gl.beginQuery).toHaveBeenCalledTimes(1)
    expect(gl.endQuery).toHaveBeenCalledTimes(1)
    expect(timer.poll()).toEqual([])
    expect(gl.getQueryParameter).not.toHaveBeenCalled()
  })

  it('deletes every query on dispose', () => {
    const { context, gl, created } = fakeGl()
    const timer = createGpuFrameTimer(context)!
    frames(timer, 2)
    timer.begin(2)
    timer.dispose()
    expect(gl.endQuery).toHaveBeenCalledTimes(3)
    expect(gl.deleteQuery).toHaveBeenCalledTimes(created.length)
  })
})
