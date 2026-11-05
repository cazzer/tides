// Code that runs in the page. INIT is installed before any app script (CDP
// Page.addScriptToEvaluateOnNewDocument); PROBE is evaluated once the app has
// rendered. Both are plain functions serialised into the page, so they may
// only use browser globals.

// Resident texture and renderbuffer memory by format (what is alive now:
// re-uploads replace a level, deleteTexture frees it), plus the bytes
// uploaded so far, and a passive GPU timer: when the app opens its own
// TIME_ELAPSED queries (AdaptivePixelRatio on the high tier) the harness must
// not nest one inside (INVALID_OPERATION), so it records the results the app
// reads instead.
function init() {
  if (window.__pp) return
  const P = WebGL2RenderingContext.prototype
  const bpp = {
    0x8058: 4, 0x8c43: 4, 0x881a: 8, 0x8814: 16, 0x8229: 1, 0x822b: 2, 0x8d62: 2, 0x8051: 3,
    0x8c41: 3, 0x822d: 2, 0x822e: 4, 0x8230: 8, 0x8c3a: 4, 0x8c3d: 4, 0x81a5: 2, 0x81a6: 4,
    0x8cac: 4, 0x88f0: 4, 0x8cad: 8, 0x822f: 4, 0x8232: 1, 0x8236: 4, 0x8d48: 1,
    0x1908: 4, 0x1907: 3, 0x1909: 1, 0x190a: 2, 0x1906: 1,
  }
  const pp = (window.__pp = {
    textures: new Map(), // WebGLTexture -> { format, parts: Map(part -> bytes), compressed }
    renderbuffers: new Map(), // WebGLRenderbuffer -> { format, bytes }
    uploadedBytes: 0,
    appGpuMs: [],
    appQueries: new Set(),
    appQuerySeenAt: -1,
    ownQueryOpen: false,
    programLinks: 0,
  })
  const state = new WeakMap()
  const stateOf = (ctx) => {
    if (!state.has(ctx)) state.set(ctx, { unit: 0x84c0, bound: new Map(), renderbuffer: null })
    return state.get(ctx)
  }
  const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a]
  const bindTarget = (target) => (CUBE_FACES.includes(target) ? 0x8513 : target)
  const boundTexture = (ctx, target) => stateOf(ctx).bound.get(`${stateOf(ctx).unit}:${bindTarget(target)}`)
  const setPart = (ctx, target, part, format, bytes, compressed) => {
    const texture = boundTexture(ctx, target)
    if (!texture) return
    if (!pp.textures.has(texture)) pp.textures.set(texture, { format, parts: new Map(), compressed: false })
    const record = pp.textures.get(texture)
    record.format = format
    record.compressed = record.compressed || !!compressed
    record.parts.set(part, bytes)
    pp.uploadedBytes += bytes
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
      before.apply(this, [this, ...arguments])
      return original.apply(this, arguments)
    }
  }
  wrap('activeTexture', (ctx, unit) => (stateOf(ctx).unit = unit))
  wrap('bindTexture', (ctx, target, texture) => stateOf(ctx).bound.set(`${stateOf(ctx).unit}:${target}`, texture))
  wrap('deleteTexture', (ctx, texture) => pp.textures.delete(texture))
  wrap('texStorage2D', (ctx, t, levels, format, w, h) => setPart(ctx, t, 'storage', format, mipBytes(levels, w, h, t === 0x8513 ? 6 : 1, format)))
  wrap('texStorage3D', (ctx, t, levels, format, w, h, d) => setPart(ctx, t, 'storage', format, mipBytes(levels, w, h, d, format)))
  wrap('texImage2D', function (ctx, t, level, format) {
    const args = [...arguments].slice(1)
    let w, h
    if (args.length >= 8) [w, h] = [args[3], args[4]]
    else if (args.length === 6 && args[5]) [w, h] = [args[5].width ?? args[5].videoWidth, args[5].height ?? args[5].videoHeight]
    if (w && h) setPart(ctx, t, `${t}:${level}`, format, w * h * (bpp[format] || 4))
  })
  wrap('texImage3D', (ctx, t, level, format, w, h, d) => setPart(ctx, t, `${t}:${level}`, format, w * h * d * (bpp[format] || 4)))
  wrap('compressedTexImage2D', (ctx, t, level, format, w, h, border, data) =>
    setPart(ctx, t, `${t}:${level}`, format, (data && data.byteLength) || 0, true)
  )
  wrap('generateMipmap', (ctx, t) => {
    const texture = boundTexture(ctx, t)
    const record = texture && pp.textures.get(texture)
    if (!record || record.parts.has('storage')) return
    let base = 0
    for (const [part, bytes] of record.parts) if (/:0$/.test(part)) base += bytes
    record.parts.set('mips', base / 3)
  })
  wrap('bindRenderbuffer', (ctx, t, rb) => (stateOf(ctx).renderbuffer = rb))
  wrap('deleteRenderbuffer', (ctx, rb) => pp.renderbuffers.delete(rb))
  wrap('renderbufferStorage', (ctx, t, format, w, h) => {
    const rb = stateOf(ctx).renderbuffer
    if (rb) pp.renderbuffers.set(rb, { format, bytes: w * h * (bpp[format] || 4) })
  })
  wrap('renderbufferStorageMultisample', (ctx, t, samples, format, w, h) => {
    const rb = stateOf(ctx).renderbuffer
    if (rb) pp.renderbuffers.set(rb, { format, bytes: w * h * (bpp[format] || 4) * Math.max(1, samples) })
  })
  wrap('linkProgram', () => pp.programLinks++)
  pp.memory = () => {
    const MB = 1048576
    const byFormat = {}
    let textures = 0
    let compressed = 0
    for (const record of pp.textures.values()) {
      let bytes = 0
      for (const b of record.parts.values()) bytes += b
      const key = (record.compressed ? 'cmp:' : '') + '0x' + record.format.toString(16)
      byFormat[key] = (byFormat[key] || 0) + bytes
      textures += bytes
      if (record.compressed) compressed += bytes
    }
    let renderbuffers = 0
    for (const rb of pp.renderbuffers.values()) renderbuffers += rb.bytes
    return {
      total: +((textures + renderbuffers) / MB).toFixed(1),
      textures: +(textures / MB).toFixed(1),
      compressed: +(compressed / MB).toFixed(1),
      renderbuffers: +(renderbuffers / MB).toFixed(1),
      liveTextures: pp.textures.size,
      uploaded: +(pp.uploadedBytes / MB).toFixed(1),
      byFormat: Object.fromEntries(
        Object.entries(byFormat)
          .sort((x, y) => y[1] - x[1])
          .map(([k, v]) => [k, +(v / MB).toFixed(1)])
      ),
    }
  }

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
}

// Installs window.__ppProbe: app handles (store, renderer) and the sampler.
async function probe() {
  if (window.__ppProbe) return window.__ppProbe.info()
  const handles = window.__ppHandles
  if (!handles?.getState || !handles.useStore || !handles.qualityTier || !handles.addEffect) {
    throw new Error('Harness handles missing: serve the app with scripts/phone-perf/vite.config.mjs')
  }
  const store = handles.useStore
  const THREE = handles.THREE
  const root = () => handles.getState()
  const gl = root().gl
  const ctx = gl.getContext()
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2')
  const pp = window.__pp

  // The harness's own GPU timer, only while the app runs none: a query from
  // R3F's global before-effect to its after-effect brackets one frame's
  // draws, the way the app's own gpu-frame-timer does.
  const appTiming = () => performance.now() - pp.appQuerySeenAt < 1000
  const ownTimer = () => {
    const pending = []
    const results = []
    let open = null
    let active = true
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
    const offBefore = handles.addEffect(() => {
      if (!active || open || appTiming()) return
      open = ctx.createQuery()
      pp.ownQueryOpen = true
      ctx.beginQuery(ext.TIME_ELAPSED_EXT, open)
      pp.ownQueryOpen = false
    })
    const offAfter = handles.addAfterEffect(() => {
      if (open) {
        ctx.endQuery(ext.TIME_ELAPSED_EXT)
        pending.push(open)
        open = null
      }
      collect()
    })
    return {
      results,
      stop() {
        active = false
        offBefore()
        offAfter()
        if (open) {
          ctx.endQuery(ext.TIME_ELAPSED_EXT)
          ctx.deleteQuery(open)
          open = null
        }
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
  const recentFrames = []
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
      recentFrames.push(recording)
      if (recentFrames.length > 12) recentFrames.shift()
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
  // The replayed frame is the latest one with the most common pass count, so
  // an occasional extra pass (a tile or surface bake) is not run K times.
  const typicalFrame = () => {
    const counts = new Map()
    for (const f of recentFrames) counts.set(f.length, (counts.get(f.length) || 0) + 1)
    let mode = null
    for (const [passes, n] of counts) if (mode === null || n > counts.get(mode)) mode = passes
    for (let i = recentFrames.length - 1; i >= 0; i--) if (recentFrames[i].length === mode) return recentFrames[i]
    return []
  }
  const replay = async (K = 10, rounds = 7) => {
    const calls = typicalFrame()
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
      vramMB: pp.memory(),
      visibility: document.visibilityState,
    }
  }

  // rAF deltas over ms, plus GPU ms per frame from whichever timer ran, and
  // long tasks (>50 ms) seen meanwhile.
  // marks: console.timeStamp labels left at the first and last callback, so
  // a trace can be clipped to exactly the frames counted here.
  const sample = (ms, marks) =>
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
        if (last === null && marks) console.timeStamp(marks[0])
        if (last !== null) deltas.push(now - last)
        last = now
        if (now < end) {
          requestAnimationFrame(step)
          return
        }
        if (marks) console.timeStamp(marks[1])
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
