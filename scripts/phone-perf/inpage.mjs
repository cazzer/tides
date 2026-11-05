// Code that runs in the page. INIT is installed before any app script (CDP
// Page.addScriptToEvaluateOnNewDocument); PROBE is evaluated once the app has
// rendered. Both are plain functions serialised into the page, so they may
// only use browser globals.

// Texture memory by format (the texStorage/texImage/compressed calls three
// makes), the same accounting as the perf-audit stream's harness, and a
// passive GPU timer: when the app opens its own TIME_ELAPSED queries
// (AdaptivePixelRatio on the high tier) the harness must not nest one inside
// (INVALID_OPERATION), so it records the results the app reads instead.
function init() {
  if (window.__pp) return
  const P = WebGL2RenderingContext.prototype
  const bpp = {
    0x8058: 4, 0x8c43: 4, 0x881a: 8, 0x8814: 16, 0x8229: 1, 0x822b: 2, 0x8d62: 2, 0x8051: 3,
    0x8c41: 3, 0x822d: 2, 0x822e: 4, 0x8230: 8, 0x8c3a: 4, 0x8c3d: 4, 0x81a5: 2, 0x81a6: 4,
    0x8cac: 4, 0x88f0: 4, 0x8cad: 8, 0x822f: 4, 0x8232: 1, 0x8236: 4,
  }
  const pp = (window.__pp = {
    vram: { total: 0, compressed: 0, uploads: 0, byFormat: {} },
    appGpuMs: [],
    appQueries: new Set(),
    appQuerySeenAt: -1,
    ownQueryOpen: false,
    programLinks: 0,
    contexts: [],
  })
  const add = (format, bytes, compressed) => {
    const key = (compressed ? 'cmp:' : '') + '0x' + format.toString(16)
    pp.vram.byFormat[key] = (pp.vram.byFormat[key] || 0) + bytes
    pp.vram.total += bytes
    pp.vram.uploads++
    if (compressed) pp.vram.compressed += bytes
  }
  const mipBytes = (levels, w, h, depth, format) => {
    let bytes = 0
    for (let i = 0; i < levels; i++) {
      bytes += w * h * depth * (bpp[format] || 4)
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
    }
    return bytes
  }
  const wrap = (name, before) => {
    const original = P[name]
    P[name] = function () {
      before.apply(this, arguments)
      return original.apply(this, arguments)
    }
  }
  wrap('texStorage2D', (t, levels, format, w, h) => add(format, mipBytes(levels, w, h, 1, format)))
  wrap('texStorage3D', (t, levels, format, w, h, d) => add(format, mipBytes(levels, w, h, d, format)))
  wrap('texImage2D', function (t, level, format) {
    if (level !== 0) return
    if (arguments.length >= 9) add(format, arguments[3] * arguments[4] * (bpp[format] || 4))
    else if (arguments.length === 6 && arguments[5] && arguments[5].width) {
      add(format, arguments[5].width * arguments[5].height * (bpp[format] || 4))
    }
  })
  wrap('compressedTexImage2D', (t, level, format, w, h, border, data) =>
    add(format, (data && data.byteLength) || 0, true)
  )
  wrap('linkProgram', () => pp.programLinks++)

  const TIME_ELAPSED = 0x88bf
  const QUERY_RESULT = 0x8866
  const beginQuery = P.beginQuery
  P.beginQuery = function (target, query) {
    if (target === TIME_ELAPSED && !pp.ownQueryOpen) {
      pp.appQueries.add(query)
      pp.appQuerySeenAt = performance.now()
    }
    return beginQuery.apply(this, arguments)
  }
  const getQueryParameter = P.getQueryParameter
  P.getQueryParameter = function (query, pname) {
    const value = getQueryParameter.apply(this, arguments)
    if (pname === QUERY_RESULT && pp.appQueries.has(query)) {
      pp.appQueries.delete(query)
      pp.appGpuMs.push(Number(value) / 1e6)
      if (pp.appGpuMs.length > 2000) pp.appGpuMs.splice(0, 1000)
    }
    return value
  }
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type) {
    const context = getContext.apply(this, arguments)
    if (context && /webgl/.test(type) && !pp.contexts.includes(context)) pp.contexts.push(context)
    return context
  }
}

// Installs window.__ppProbe: app handles (store, renderer) and the sampler.
async function probe() {
  if (window.__ppProbe) return window.__ppProbe.info()
  const handles = window.__ppHandles
  if (!handles?.getState || !handles.useStore || !handles.qualityTier) {
    throw new Error('Harness handles missing: serve the app with scripts/phone-perf/vite.config.mjs')
  }
  const store = handles.useStore
  const THREE = handles.THREE
  const root = () => handles.getState()
  const gl = root().gl
  const ctx = gl.getContext()
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2')
  const pp = window.__pp

  // The harness's own GPU timer, only while the app runs none. Each query
  // spans one sampler callback to the next, so it holds exactly one R3F frame
  // whichever of the two rAF callbacks runs first.
  const appTiming = () => performance.now() - pp.appQuerySeenAt < 1000
  const ownTimer = () => {
    const pending = []
    const results = []
    let open = null
    const collect = () => {
      while (pending.length) {
        const q = pending[0]
        if (!ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) break
        pending.shift()
        const disjoint = ctx.getParameter(ext.GPU_DISJOINT_EXT)
        const ns = ctx.getQueryParameter(q, ctx.QUERY_RESULT)
        ctx.deleteQuery(q)
        if (!disjoint) results.push(ns / 1e6)
      }
    }
    return {
      results,
      tick() {
        if (open) {
          ctx.endQuery(ext.TIME_ELAPSED_EXT)
          pending.push(open)
        }
        collect()
        open = ctx.createQuery()
        pp.ownQueryOpen = true
        ctx.beginQuery(ext.TIME_ELAPSED_EXT, open)
        pp.ownQueryOpen = false
      },
      stop() {
        if (open) ctx.endQuery(ext.TIME_ELAPSED_EXT)
        if (open) ctx.deleteQuery(open)
        open = null
        // Late results are dropped; a sample window has hundreds of frames.
        collect()
      },
    }
  }

  // Records every gl.render of a frame (scene, camera, viewport, scissor,
  // target), totalling draws across passes, so a frame can be replayed
  // synchronously: K replays then a 1-pixel readPixels sync time the GPU and
  // CPU submit together, which is the headroom measure where no GPU timer
  // exists (the perf-audit harness's replay, same idea).
  let recording = []
  let lastFrame = []
  const frameTotals = { calls: 0, triangles: 0, passes: 0 }
  let liveTotals = { calls: 0, triangles: 0, passes: 0 }
  let replaying = false
  const originalRender = gl.render
  gl.render = function (scene, camera) {
    if (!replaying) {
      const viewport = new THREE.Vector4()
      const scissor = new THREE.Vector4()
      gl.getViewport(viewport)
      gl.getScissor(scissor)
      recording.push({
        scene, camera, viewport, scissor,
        scissorTest: gl.getScissorTest(),
        target: gl.getRenderTarget(),
        autoClear: gl.autoClear,
      })
    }
    const result = originalRender.apply(this, arguments)
    if (!replaying) {
      liveTotals.calls += gl.info.render.calls
      liveTotals.triangles += gl.info.render.triangles
      liveTotals.passes++
    }
    return result
  }
  const recordLoop = () => {
    if (recording.length) {
      lastFrame = recording
      Object.assign(frameTotals, liveTotals)
    }
    recording = []
    liveTotals = { calls: 0, triangles: 0, passes: 0 }
    requestAnimationFrame(recordLoop)
  }
  requestAnimationFrame(recordLoop)
  const pixel = new Uint8Array(4)
  const sync = () => {
    gl.setRenderTarget(null)
    ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel)
  }
  const replayOnce = (calls) => {
    for (const c of calls) {
      gl.setRenderTarget(c.target)
      gl.setViewport(c.viewport)
      gl.setScissor(c.scissor)
      gl.setScissorTest(c.scissorTest)
      const autoClear = gl.autoClear
      gl.autoClear = c.autoClear
      originalRender.call(gl, c.scene, c.camera)
      gl.autoClear = autoClear
    }
  }
  // Median over rounds of (K replays + sync) / K, in ms, with R3F's loop
  // paused so nothing else draws in between.
  const replay = async (K = 10, rounds = 7) => {
    const calls = lastFrame
    if (!calls.length) return null
    const state = root()
    const frameloop = state.frameloop
    state.setFrameloop('never')
    replaying = true
    const perFrame = []
    try {
      replayOnce(calls)
      sync()
      for (let r = 0; r < rounds; r++) {
        const t0 = performance.now()
        for (let k = 0; k < K; k++) replayOnce(calls)
        sync()
        perFrame.push((performance.now() - t0) / K)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      replaying = false
      state.setFrameloop(frameloop)
    }
    perFrame.sort((a, b) => a - b)
    return { ms: perFrame[perFrame.length >> 1], min: perFrame[0], max: perFrame[perFrame.length - 1], K, rounds, passes: calls.length }
  }

  const info = () => {
    const s = store.getState()
    const canvas = gl.domElement
    return {
      url: location.href,
      quality: handles.qualityTier(),
      qualityChoice: handles.savedQualityChoice(),
      shipMode: !!s.shipMode,
      closeZoom: s.closeZoom ?? null,
      demo: s.demo ? { id: s.demo.id, step: s.demo.step } : null,
      dpr: gl.getPixelRatio(),
      devicePixelRatio: window.devicePixelRatio,
      canvas: [canvas.width, canvas.height],
      css: [canvas.clientWidth, canvas.clientHeight],
      gpuTimerExt: !!ext,
      appTimesGpu: appTiming(),
      renderer: (() => {
        const dbg = ctx.getExtension('WEBGL_debug_renderer_info')
        return dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)
      })(),
      render: { ...frameTotals },
      memory: { ...gl.info.memory },
      programs: gl.info.programs ? gl.info.programs.length : null,
      programLinks: pp.programLinks,
      vramMB: {
        total: +(pp.vram.total / 1048576).toFixed(1),
        compressed: +(pp.vram.compressed / 1048576).toFixed(1),
        uploads: pp.vram.uploads,
        byFormat: Object.fromEntries(
          Object.entries(pp.vram.byFormat)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => [k, +(v / 1048576).toFixed(1)])
        ),
      },
      visibility: document.visibilityState,
    }
  }

  // rAF deltas over ms, plus GPU ms per frame from whichever timer ran, and
  // long tasks (>50 ms) seen meanwhile.
  const sample = (ms) =>
    new Promise((resolve) => {
      const deltas = []
      const longTasks = []
      let observer = null
      try {
        observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(+e.duration.toFixed(1))
        })
        observer.observe({ type: 'longtask', buffered: false })
      } catch {}
      const appStart = pp.appGpuMs.length
      const own = ext && !appTiming() ? ownTimer() : null
      const drawsAtStart = gl.info.render.frame
      let last = null
      const end = performance.now() + ms
      const step = (now) => {
        if (last !== null) deltas.push(now - last)
        last = now
        own?.tick()
        if (now < end) {
          requestAnimationFrame(step)
          return
        }
        own?.stop()
        observer?.disconnect()
        const appGpu = pp.appGpuMs.slice(appStart)
        const ownGpu = own ? own.results : []
        resolve({
          deltas,
          gpuMs: appGpu.length ? appGpu : ownGpu,
          gpuSource: appGpu.length ? 'app' : ownGpu.length ? 'harness' : 'none',
          longTasks,
          rendererFrames: gl.info.render.frame - drawsAtStart,
          info: info(),
        })
      }
      requestAnimationFrame(step)
    })

  window.__ppProbe = { store, THREE, gl, ctx, root, info, sample, replay }
  return info()
}

export const INIT_SCRIPT = `(${init.toString()})()`
export const PROBE_SCRIPT = `(${probe.toString()})()`
