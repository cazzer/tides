// Summarises a Chrome trace (CDP Tracing, JSON event array) into busy time
// per thread and main-thread time per category.

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink',
  'cc',
  'gpu',
  'viz',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.gc',
  'disabled-by-default-gpu.service',
  'disabled-by-default-gpu.device',
  '__metadata',
]

// First match wins, so the more specific names come first. Time is
// attributed by self time (an event's duration minus its children's), so a
// GC inside a rAF callback counts as GC, not script.
const CATEGORY_RULES = [
  ['gc', /(^|\.)(GC|gc)|GC_|MinorGC|MajorGC|Scavenge|MarkCompact|BlinkGC|CppGC/],
  ['compile', /[Cc]ompile|Parse(Script|Function|OnBackground)|v8\.parse|V8\.Deserialize/],
  ['webgl', /WebGL|GLES2|CommandBuffer|gpu::|Gpu|GPU|SharedImage|GLImplementation/],
  ['style-layout', /UpdateLayoutTree|RecalcStyle|Layout|UpdateLayer(Tree)?$|PrePaint|IntersectionObserver/],
  ['paint-composite', /Paint|Layerize|Raster|Commit|Composite|CompositeLayers|cc::|ProxyMain|BeginMainFrame/],
  ['script', /FunctionCall|EvaluateScript|FireAnimationFrame|TimerFire|EventDispatch|v8\.|V8\.|RunMicrotasks|v8\.callFunction|HandlePostMessage|ResourceSendRequest/],
]

export function categoryOf(name) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(name)) return category
  }
  return 'other'
}

function threadKey(event) {
  return `${event.pid}:${event.tid}`
}

// Names threads and processes from the metadata events.
export function threadNames(events) {
  const processes = new Map()
  const threads = new Map()
  for (const event of events) {
    if (event.ph !== 'M') continue
    if (event.name === 'process_name') processes.set(event.pid, event.args?.name ?? '')
    if (event.name === 'thread_name') threads.set(threadKey(event), event.args?.name ?? '')
  }
  return { processes, threads }
}

// Turns 'X' events and 'B'/'E' pairs into [start, end, name] slices per thread.
export function slicesByThread(events) {
  const byThread = new Map()
  const open = new Map()
  const push = (key, slice) => {
    if (!byThread.has(key)) byThread.set(key, [])
    byThread.get(key).push(slice)
  }
  for (const event of events) {
    if (typeof event.ts !== 'number') continue
    const key = threadKey(event)
    if (event.ph === 'X') {
      push(key, { start: event.ts, end: event.ts + (event.dur ?? 0), name: event.name })
    } else if (event.ph === 'B') {
      if (!open.has(key)) open.set(key, [])
      open.get(key).push(event)
    } else if (event.ph === 'E') {
      const begin = open.get(key)?.pop()
      if (begin) push(key, { start: begin.ts, end: event.ts, name: begin.name })
    }
  }
  for (const slices of byThread.values()) {
    slices.sort((a, b) => a.start - b.start || b.end - a.end)
  }
  return byThread
}

// Self time per category plus the busy time (union of top-level slices),
// in milliseconds, for one thread's slices clipped to [from, to] (µs).
export function attributeThread(slices, from = -Infinity, to = Infinity) {
  const categories = {}
  let busyUs = 0
  const stack = []
  const closeUntil = (time) => {
    while (stack.length && stack[stack.length - 1].end <= time) {
      const done = stack.pop()
      const self = Math.max(0, done.end - done.start - done.childUs)
      const category = categoryOf(done.name)
      categories[category] = (categories[category] ?? 0) + self
    }
  }
  for (const raw of slices) {
    const start = Math.max(raw.start, from)
    const end = Math.min(raw.end, to)
    if (end <= start) continue
    closeUntil(start)
    const slice = { start, end, name: raw.name, childUs: 0 }
    const parent = stack[stack.length - 1]
    if (parent) {
      slice.end = Math.min(slice.end, parent.end)
      parent.childUs += slice.end - slice.start
    } else {
      busyUs += end - start
    }
    stack.push(slice)
  }
  closeUntil(Infinity)
  const ms = {}
  for (const [category, us] of Object.entries(categories)) ms[category] = us / 1000
  return { busyMs: busyUs / 1000, categoriesMs: ms }
}

// The renderer process of the measured tab. First choice: the process that
// logged the sampler's start mark (the marks carry a per-pose nonce, so no
// other tab can have logged it; Android Chrome's trace lists no frames).
// Then the frame list in TracingStartedInBrowser, by target id (a URL match
// could pick another tab with the same site open) or exact URL. Null when
// nothing matches: no guessing.
export function findRendererPid(events, { targetId, url, startMark } = {}) {
  if (startMark) {
    const mark = events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === startMark)
    if (mark) return mark.pid
  }
  for (const event of events) {
    const frames = event.args?.data?.frames
    if (event.name !== 'TracingStartedInBrowser' || !Array.isArray(frames)) continue
    const byTarget = targetId && frames.find((f) => f.frame === targetId && f.processId)
    if (byTarget) return byTarget.processId
    const byUrl = url && frames.find((f) => f.url === url && f.processId)
    if (byUrl) return byUrl.processId
  }
  return null
}

// The measurement window: console.timeStamp marks the sampler leaves in the
// renderer at its first and last rAF callback, so time spent starting and
// flushing the trace is not divided among the window's frames.
export function markWindow(events, pid, startMessage, endMessage) {
  let from = null
  let to = null
  for (const event of events) {
    if (event.name !== 'TimeStamp' || event.pid !== pid) continue
    const message = event.args?.data?.message
    if (message === startMessage) from = event.ts
    if (message === endMessage) to = event.ts
  }
  return from !== null && to !== null && to > from ? { from, to } : null
}

const GPU_THREAD_NAMES = ['CrGpuMain', 'VizCompositorThread', 'Chrome_InProcGpuThread']

// Main-thread categories and GPU-process thread busy time per frame, over the
// window between the sampler's marks.
export function summariseTrace(
  events,
  { targetId, url, frames, marks = ['pp:trace:start', 'pp:trace:end'] } = {}
) {
  const names = threadNames(events)
  const byThread = slicesByThread(events)
  const rendererPid = findRendererPid(events, { targetId, url, startMark: marks[0] })
  if (rendererPid === null) {
    return { error: 'measured tab not found in the trace', rendererPid, main: null, gpuThreads: [], gpuDevicePerFrameMs: null }
  }
  const window = markWindow(events, rendererPid, marks[0], marks[1])
  if (!window) {
    return { error: 'sampler marks missing from the trace', rendererPid, main: null, gpuThreads: [], gpuDevicePerFrameMs: null }
  }
  const { from, to } = window
  const seconds = (to - from) / 1e6
  const perFrame = (ms) => (frames ? ms / frames : null)

  let main = null
  for (const [key, name] of names.threads) {
    if (name === 'CrRendererMain' && Number(key.split(':')[0]) === rendererPid) {
      const { busyMs, categoriesMs } = attributeThread(byThread.get(key) ?? [], from, to)
      main = {
        busyMs,
        busyPerFrameMs: perFrame(busyMs),
        busyShare: seconds > 0 ? busyMs / (seconds * 1000) : null,
        categoriesPerFrameMs: Object.fromEntries(
          Object.entries(categoriesMs).map(([c, ms]) => [c, perFrame(ms)])
        ),
        categoriesMs,
      }
    }
  }

  const gpuThreads = []
  for (const [key, name] of names.threads) {
    if (!GPU_THREAD_NAMES.includes(name)) continue
    const pid = Number(key.split(':')[0])
    const { busyMs } = attributeThread(byThread.get(key) ?? [], from, to)
    if (busyMs === 0) continue
    gpuThreads.push({
      thread: name,
      process: names.processes.get(pid) ?? String(pid),
      busyMs,
      busyPerFrameMs: perFrame(busyMs),
    })
  }

  // Device-side GPU slices appear only where Chrome can time the GPU itself
  // (disabled-by-default-gpu.device); most Android drivers expose none. They
  // nest, so take the union per track, not the sum.
  const deviceSlices = slicesByThread(events.filter((e) => e.cat?.includes('gpu.device')))
  let deviceMs = 0
  for (const slices of deviceSlices.values()) deviceMs += attributeThread(slices, from, to).busyMs

  return {
    seconds,
    rendererPid,
    main,
    gpuThreads,
    // A handful of zero-length device slices is not a GPU timing.
    gpuDevicePerFrameMs: frames && deviceMs / frames > 0.1 ? perFrame(deviceMs) : null,
  }
}

// Self time per function from a CDP Profiler profile, heaviest first:
// [{ fn, url, ms }], with (idle), (program) and (garbage collector) kept so
// the split against app code stays visible.
export function summariseProfile(profile, top = 15) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfUs = new Map()
  const { samples = [], timeDeltas = [] } = profile
  for (let i = 0; i < samples.length; i++) {
    // timeDeltas[i] is the gap before sample i; charge it to sample i - 1's node.
    const node = i > 0 ? samples[i - 1] : null
    if (node === null) continue
    selfUs.set(node, (selfUs.get(node) ?? 0) + (timeDeltas[i] ?? 0))
  }
  const byFunction = new Map()
  for (const [id, us] of selfUs) {
    const frame = byId.get(id)?.callFrame
    if (!frame) continue
    const file = frame.url ? frame.url.replace(/^.*\/(src|deps|node_modules)\//, '$1/').replace(/\?.*$/, '') : ''
    const key = `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}` : ''}`
    byFunction.set(key, (byFunction.get(key) ?? 0) + us)
  }
  return [...byFunction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([fn, us]) => ({ fn, ms: us / 1000 }))
}
