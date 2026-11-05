import { describe, expect, it } from 'vitest'
import {
  droppedFrameShare,
  estimateRefreshPeriod,
  noiseBand,
  percentile,
  summariseFrames,
} from './stats.mjs'
import { attributeThread, categoryOf, slicesByThread, summariseTrace } from './trace.mjs'

describe('frame stats', () => {
  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([10, 20], 50)).toBe(15)
    expect(percentile([], 50)).toBeNull()
  })

  it('snaps the refresh estimate to a real panel rate', () => {
    expect(1000 / estimateRefreshPeriod(Array(50).fill(16.9))).toBeCloseTo(60, 0)
    expect(1000 / estimateRefreshPeriod(Array(50).fill(8.4))).toBeCloseTo(120, 0)
  })

  it('counts missed vsync slots', () => {
    const period = 1000 / 60
    // Three on-time frames and one that took three slots: 2 of 6 slots missed.
    expect(droppedFrameShare([period, period, period, 3 * period], period)).toBeCloseTo(2 / 6)
  })

  it('summarises a run', () => {
    const summary = summariseFrames([...Array(98).fill(16.7), 50, 50])
    expect(summary.frames).toBe(100)
    expect(summary.refreshHz).toBe(60)
    expect(summary.p50).toBeCloseTo(16.7)
    expect(summary.p99).toBeCloseTo(50)
    expect(summary.droppedShare).toBeGreaterThan(0)
  })

  it('counts drops against a known refresh when every frame misses', () => {
    const slow = Array(30).fill(50)
    expect(summariseFrames(slow).refreshHz).toBe(30)
    const pinned = summariseFrames(slow, 1000 / 60)
    expect(pinned.refreshHz).toBe(60)
    expect(pinned.droppedShare).toBeCloseTo(2 / 3)
  })

  it('reports the spread across runs', () => {
    const band = noiseBand([10, 11, 12])
    expect(band.mean).toBe(11)
    expect(band.spreadPct).toBeCloseTo((2 / 11) * 100)
    expect(noiseBand([null, undefined])).toBeNull()
  })
})

describe('trace summary', () => {
  it('maps event names to categories', () => {
    expect(categoryOf('FunctionCall')).toBe('script')
    expect(categoryOf('MinorGC')).toBe('gc')
    expect(categoryOf('V8.GC_SCAVENGER')).toBe('gc')
    expect(categoryOf('v8.compile')).toBe('compile')
    expect(categoryOf('UpdateLayoutTree')).toBe('style-layout')
    expect(categoryOf('Paint')).toBe('paint-composite')
    expect(categoryOf('CommandBufferProxyImpl::Flush')).toBe('webgl')
    expect(categoryOf('ThreadControllerImpl::RunTask')).toBe('other')
  })

  it('attributes self time, so nested GC is not counted as script', () => {
    const slices = [
      { start: 0, end: 10000, name: 'RunTask' },
      { start: 0, end: 8000, name: 'FunctionCall' },
      { start: 2000, end: 5000, name: 'MinorGC' },
      { start: 20000, end: 21000, name: 'Paint' },
    ]
    const { busyMs, categoriesMs } = attributeThread(slices)
    expect(busyMs).toBe(11)
    expect(categoriesMs.script).toBe(5)
    expect(categoriesMs.gc).toBe(3)
    expect(categoriesMs.other).toBe(2)
    expect(categoriesMs['paint-composite']).toBe(1)
  })

  it('pairs B/E events into slices', () => {
    const slices = slicesByThread([
      { ph: 'B', ts: 0, pid: 1, tid: 1, name: 'FunctionCall' },
      { ph: 'E', ts: 500, pid: 1, tid: 1 },
    ]).get('1:1')
    expect(slices).toEqual([{ start: 0, end: 500, name: 'FunctionCall' }])
  })

  const tracedTabs = () => [
    { ph: 'M', name: 'process_name', pid: 2, args: { name: 'Renderer' } },
    { ph: 'M', name: 'thread_name', pid: 2, tid: 20, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'thread_name', pid: 3, tid: 30, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'process_name', pid: 9, args: { name: 'GPU Process' } },
    { ph: 'M', name: 'thread_name', pid: 9, tid: 90, args: { name: 'CrGpuMain' } },
    {
      ph: 'I',
      name: 'TracingStartedInBrowser',
      pid: 1,
      tid: 1,
      ts: 0,
      args: {
        data: {
          frames: [
            // Another tab with the same site comes first in the list.
            { frame: 'OTHER', url: 'https://x/tides/', processId: 3 },
            { frame: 'T1', url: 'http://localhost:5393/tides/?t=1', processId: 2 },
          ],
        },
      },
    },
    { ph: 'I', name: 'TimeStamp', pid: 2, tid: 20, ts: 1000, args: { data: { message: 'pp:trace:start' } } },
    { ph: 'X', name: 'RunTask', pid: 2, tid: 20, ts: 0, dur: 900 },
    { ph: 'X', name: 'FunctionCall', pid: 2, tid: 20, ts: 1000, dur: 4000 },
    { ph: 'X', name: 'FunctionCall', pid: 3, tid: 30, ts: 1000, dur: 9000 },
    { ph: 'X', name: 'GpuChannel::ExecuteDeferredRequest', pid: 9, tid: 90, ts: 1000, dur: 6000 },
    { ph: 'X', name: 'GPUTask', cat: 'disabled-by-default-gpu.device', pid: 9, tid: 91, ts: 1000, dur: 3000 },
    { ph: 'X', name: 'GPUTask', cat: 'disabled-by-default-gpu.device', pid: 9, tid: 91, ts: 1500, dur: 1000 },
    { ph: 'I', name: 'TimeStamp', pid: 2, tid: 20, ts: 9000, args: { data: { message: 'pp:trace:end' } } },
    { ph: 'X', name: 'FunctionCall', pid: 2, tid: 20, ts: 9500, dur: 400000 },
  ]

  it('measures the tab by target id, inside the sampler marks only', () => {
    const summary = summariseTrace(tracedTabs(), { targetId: 'T1', frames: 2 })
    expect(summary.rendererPid).toBe(2)
    expect(summary.seconds).toBeCloseTo(0.008)
    expect(summary.main.categoriesPerFrameMs.script).toBe(2)
    expect(summary.main.categoriesPerFrameMs.other).toBeUndefined()
    expect(summary.gpuThreads).toEqual([
      expect.objectContaining({ thread: 'CrGpuMain', process: 'GPU Process', busyPerFrameMs: 3 }),
    ])
    // Nested device slices count once: 3 ms over 2 frames.
    expect(summary.gpuDevicePerFrameMs).toBe(1.5)
  })

  it('finds the tab from its start mark when the trace lists no frames (Android)', () => {
    const android = tracedTabs().map((e) =>
      e.name === 'TracingStartedInBrowser' ? { ...e, args: {} } : e
    )
    const summary = summariseTrace(android, { targetId: 'T1', frames: 2 })
    expect(summary.rendererPid).toBe(2)
    expect(summary.main.categoriesPerFrameMs.script).toBe(2)
  })

  it('refuses to guess when the tab or the marks are missing', () => {
    const noMarks = { targetId: 'NOPE', frames: 2, marks: ['nope:start', 'nope:end'] }
    expect(summariseTrace(tracedTabs(), noMarks).error).toMatch(/tab not found/)
    const unmarked = tracedTabs().filter((e) => e.name !== 'TimeStamp')
    expect(summariseTrace(unmarked, { targetId: 'T1', frames: 2 }).error).toMatch(/marks missing/)
  })
})

describe('adb parsing', async () => {
  const { parseThermal, pickSerial } = await import('./adb.mjs')

  it('reads the thermal status and the hottest sensor per type', () => {
    const dump = [
      'IsStatusOverride: false',
      'Thermal Status: 2',
      'Cached temperatures:',
      '\tTemperature{mValue=30.0, mType=3, mName=skin, mStatus=0}',
      'HAL Ready: true',
      'Current temperatures from HAL:',
      '\tTemperature{mValue=41.5, mType=3, mName=skin-therm, mStatus=1}',
      '\tTemperature{mValue=55.2, mType=0, mName=cpu-0-0-usr, mStatus=0}',
      '\tTemperature{mValue=61.0, mType=0, mName=cpu-1-2-usr, mStatus=0}',
      '\tTemperature{mValue=50.1, mType=1, mName=gpuss-0-usr, mStatus=0}',
      'Current cooling devices from HAL:',
      '\tCoolingDevice{mValue=0, mType=2, mName=battery}',
    ].join('\n')
    const t = parseThermal(dump)
    expect(t.status).toBe(2)
    expect(t.skin).toEqual({ c: 41.5, sensor: 'skin-therm' })
    expect(t.cpu.c).toBe(61)
    expect(t.gpu.c).toBe(50.1)
  })

  it('prefers the ip:port entry when one phone is listed twice', () => {
    const out = [
      'List of devices attached',
      '192.168.68.56:36979    device product:o1qsqw model:SM_G991U device:o1q transport_id:42',
      'adb-R3CNC0KY9QY-cHoLFE._adb-tls-connect._tcp device product:o1qsqw model:SM_G991U device:o1q transport_id:41',
      '',
    ].join('\n')
    expect(pickSerial(out)).toBe('192.168.68.56:36979')
    expect(() => pickSerial('List of devices attached\n')).toThrow(/No adb device/)
  })
})

describe('profile summary', async () => {
  const { summariseProfile } = await import('./trace.mjs')
  it('charges each sample gap to the function that was running', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
        { id: 2, callFrame: { functionName: 'render', url: 'http://h/tides/node_modules/.vite/deps/three.js?v=1', lineNumber: 9 } },
        { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      ],
      samples: [2, 2, 3, 2],
      timeDeltas: [0, 1000, 1000, 3000],
    }
    expect(summariseProfile(profile)).toEqual([
      { fn: '(idle)', ms: 3 },
      { fn: 'render deps/three.js:10', ms: 2 },
    ])
  })
})
