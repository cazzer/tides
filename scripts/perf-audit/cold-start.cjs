// Cold-start main-thread profile (tides-0oi.6): the longest main-thread block from navigation until a few seconds
// past the loading screen's reveal, from a CDP Profiler run started before the page loads. See README.md.
//
//   COLD=1 RUNS=3 node cold-start.cjs        # cold Metal shader cache (salted shaders, lib.cjs)
//   RUNS=3 node cold-start.cjs               # warm
//
// Per run it prints one JSON line:
//   block      the longest stretch with no (idle) samples after navigation: start (ms from navigation), ms, and
//              its top self-time functions
//   blocks     the five longest stretches, [start, ms, top two self times]
//   readyAt    when the overlay starts to fade (class loading-overlay--hidden; the build's tides:ready mark too)
//   bake       the Sun bake's first face (the first draw into a cube face): when, the stretch holding it, and the
//              rAF frame holding it; draws into cube faces (18 for the bake) and when the last was
//   mips       generateMipmap calls on cube maps and on 2D textures
//   programs   programs three holds at the end, and linkProgram calls
//   firstUses  programs whose first use (getProgramInfoLog) took >= 1 ms, by start time: [t, ms, tag]
//   firstUseMs all first uses' time, summed
//   drawUses   first uses made at a draw rather than ahead of it (a warm-up), [t, ms, tag]: what draws still link
//   frames     rAF intervals in the second after readyAt: count, median, max
//   uploads    texture uploads that took >= 5 ms, [t, ms, size, source]
//   linkAt     when each linkProgram call was made
// Env: RUNS (1), PARAMS (JSON URL params over lib.cjs DEFAULTS), PHONE (default 1: 390x844 dpr3), AFTER (ms to
// keep profiling past readyAt, 4000), TIMEOUT (ms to wait for readyAt, 90000), OUT (append each run's JSON line to
// this file). Each run holds the GPU lock (lib.cjs withGpuLock) and opens a fresh browser.
const fs = require('fs')
const H = require('./lib.cjs')

const RUNS = +(process.env.RUNS || 1)
const PARAMS = JSON.parse(process.env.PARAMS || '{}')
const AFTER = +(process.env.AFTER || 4000)
const TIMEOUT = +(process.env.TIMEOUT || 90000)

// In page, ahead of the app: a clock sync the profile can find, first-use timing, mip and bake hooks, the reveal.
const HOOKS = `(() => {
  if (/\\.svg$/.test(location.pathname)) return
  const C = (window.__cold = { syncAt: 0, uses: [], uploads: [], linkAt: [], cubeDraws: 0, bakeDoneAt: null, mips: { cube: 0, flat: 0 }, bakeAt: null, readyAt: null, raf: [] })
  C.syncAt = performance.now()
  ;(function __tidesClockSync() { const end = performance.now() + 4; while (performance.now() < end) {} })()
  const P = WebGL2RenderingContext.prototype
  const lp = P.linkProgram
  P.linkProgram = function () { C.linkAt.push(performance.now()); return lp.apply(this, arguments) }
  const gm = P.generateMipmap
  P.generateMipmap = function (target) { if (target === 0x8513) C.mips.cube++; else C.mips.flat++; return gm.apply(this, arguments) }
  for (const name of ['texImage2D', 'texSubImage2D']) {
    const up = P[name]
    P[name] = function () {
      const t = performance.now()
      const out = up.apply(this, arguments)
      const ms = performance.now() - t
      if (ms >= 5) {
        const src = [...arguments].find((a) => a && typeof a === 'object' && 'width' in a)
        const size = src ? src.width + 'x' + src.height : arguments[name === 'texImage2D' ? 3 : 4] + 'x' + arguments[name === 'texImage2D' ? 4 : 5]
        C.uploads.push([t, ms, size, src ? src.constructor.name : 'data'])
      }
      return out
    }
  }
  // Which framebuffers draw into a cube face, and which one is bound.
  const cubeFb = new WeakSet(); let fb = null
  const ft = P.framebufferTexture2D
  P.framebufferTexture2D = function (t, a, textarget) { if (textarget >= 0x8515 && textarget <= 0x851A && fb) cubeFb.add(fb); return ft.apply(this, arguments) }
  const bf = P.bindFramebuffer
  P.bindFramebuffer = function (t, f) { if (t !== 0x8CA8) fb = f; return bf.apply(this, arguments) }
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
    const draw = P[name]
    P[name] = function () {
      if (fb && cubeFb.has(fb)) { const t = performance.now(); if (C.bakeAt === null) C.bakeAt = t; C.cubeDraws++; C.bakeDoneAt = t }
      return draw.apply(this, arguments)
    }
  }
  // A program's tag: three's shader type and name, and the first few of its fragment shader's own uniforms.
  const PRELUDE = /^(viewMatrix|cameraPosition|isOrthographic|toneMappingExposure|modelMatrix|modelViewMatrix|projectionMatrix|normalMatrix)$/
  const tagOf = new WeakMap(), shaders = new WeakMap()
  const ss = P.shaderSource
  P.shaderSource = function (sh, src) {
    const type = (src.match(/#define SHADER_TYPE (\\S+)/) || [])[1] || '?'
    const name = (src.match(/#define SHADER_NAME ([^\\n]*)/) || [])[1] || ''
    const own = [...src.matchAll(/uniform\\s+\\w+\\s+\\w+\\s+(\\w+)|uniform\\s+\\w+\\s+(\\w+)/g)].map((m) => m[1] || m[2]).filter((u) => !PRELUDE.test(u))
    shaders.set(sh, type + (name ? ':' + name : '') + ' ' + own.slice(0, 4).join(','))
    return ss.apply(this, arguments)
  }
  // Typed at creation: a getShaderParameter here could wait on the GPU process.
  const fragments = new WeakSet()
  const cs = P.createShader
  P.createShader = function (type) { const sh = cs.apply(this, arguments); if (type === 0x8B30 && sh) fragments.add(sh); return sh }
  const as = P.attachShader
  P.attachShader = function (pr, sh) { if (fragments.has(sh)) tagOf.set(pr, shaders.get(sh)); return as.apply(this, arguments) }
  const seen = new WeakSet()
  const gpil = P.getProgramInfoLog
  P.getProgramInfoLog = function (pr) {
    const t = performance.now()
    const out = gpil.apply(this, arguments)
    if (!seen.has(pr)) {
      seen.add(pr)
      // At a draw (three's setProgram), or ahead of one (a warm-up's getUniforms).
      const atDraw = /renderBufferDirect/.test(new Error().stack)
      C.uses.push([t, performance.now() - t, (tagOf.get(pr) || '?') + (fb ? (cubeFb.has(fb) ? ' @cube' : ' @rt') : ''), atDraw])
    }
    return out
  }
  const frame = (now) => { C.raf.push(now); if (C.raf.length < 20000) requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  const ready = () => { if (C.readyAt === null) C.readyAt = performance.now() }
  new MutationObserver(() => { if (document.querySelector('.loading-overlay--hidden')) ready() })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true })
})()`

const r1 = (x) => (x == null ? null : +x.toFixed(1))

function frameStats(raf, from) {
  const gaps = []
  for (let i = 1; i < raf.length; i++) if (raf[i - 1] >= from && raf[i] <= from + 1000) gaps.push(raf[i] - raf[i - 1])
  gaps.sort((a, b) => a - b)
  return { n: gaps.length, med: r1(gaps[gaps.length >> 1]), max: r1(gaps[gaps.length - 1]) }
}

// The profile's samples as [time ms (profile clock), node]; stretches of non-idle samples as [start, end, from, to].
function analyse(profile, page) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id)
  // The JS callers of a sample's node, nearest first: who asked for a native call.
  const via = (id) => {
    const chain = []
    for (let p = parent.get(id); p !== undefined && chain.length < 3; p = parent.get(p)) {
      const name = byId.get(p).callFrame.functionName
      if (name && name !== '(root)') chain.push(name)
    }
    return chain.join('<')
  }
  const times = []
  let t = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) { t += profile.timeDeltas[i]; times.push(t / 1000) }
  const fn = (i) => byId.get(profile.samples[i]).callFrame.functionName
  // Page clock -> profile clock, from the first sample inside the sync loop.
  const sync = profile.samples.findIndex((_, i) => fn(i) === '__tidesClockSync')
  if (sync < 0) throw new Error('clock sync not in the profile: did the profiler survive the navigation?')
  const offset = times[sync] - page.syncAt
  const toPage = (ms) => ms - offset
  const stretches = []
  let from = -1
  for (let i = sync; i < times.length; i++) {
    const idle = fn(i) === '(idle)'
    if (!idle && from < 0) from = i
    if ((idle || i === times.length - 1) && from >= 0) { stretches.push([times[from], times[i], from, i]); from = -1 }
  }
  // Top self time over samples a..b, each with its heaviest caller chain.
  const top = (a, b, n = 8) => {
    const self = new Map()
    for (let i = a; i < b; i++) {
      const id = profile.samples[i]
      const cf = byId.get(id).callFrame
      const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop().split('?')[0] + ':' + cf.lineNumber
      const dt = times[i + 1] - times[i] || 0
      const e = self.get(k) || { ms: 0, via: new Map() }
      e.ms += dt
      const v = via(id)
      e.via.set(v, (e.via.get(v) || 0) + dt)
      self.set(k, e)
    }
    return [...self].sort((x, y) => y[1].ms - x[1].ms).slice(0, n)
      .map(([k, e]) => [k, r1(e.ms), [...e.via].sort((x, y) => y[1] - x[1])[0][0]])
  }
  const sorted = stretches.slice().sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
  const longest = sorted[0]
  const holding = (pageMs) => {
    if (pageMs == null) return null
    const at = pageMs + offset
    const s = stretches.find(([a, b]) => a <= at && at <= b)
    return s ? { start: r1(toPage(s[0])), ms: r1(s[1] - s[0]), top: top(s[2], s[3], 5) } : null
  }
  const frameOf = (pageMs) => {
    if (pageMs == null) return null
    const i = page.raf.findIndex((x) => x > pageMs)
    return i > 0 ? { start: r1(page.raf[i - 1]), ms: r1(page.raf[i] - page.raf[i - 1]) } : null
  }
  return {
    block: { start: r1(toPage(longest[0])), ms: r1(longest[1] - longest[0]), top: top(longest[2], longest[3]) },
    blocks: sorted.slice(0, 5).map(([a, b, i, j]) => [r1(toPage(a)), r1(b - a), top(i, j, 2).map(([k, ms]) => k.split(' ')[0] + ' ' + ms).join('; ')]),
    bake: { at: r1(page.bakeAt), stretch: holding(page.bakeAt), frame: frameOf(page.bakeAt), draws: page.cubeDraws, doneAt: r1(page.bakeDoneAt) },
  }
}

async function run() {
  const { browser, page } = await H.launch({ phone: process.env.PHONE !== '0' })
  try {
    await page.addInitScript(HOOKS)
    // Same origin first, so the navigation below keeps the renderer process (and the profiler) it starts in.
    await page.goto(H.BASE_URL + 'icon.svg')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
    const q = new URLSearchParams({ ...H.DEFAULTS, ...PARAMS })
    await page.goto(`${H.BASE_URL}?${q}`)
    await page.waitForFunction(() => window.__cold && window.__cold.readyAt !== null, null, { timeout: TIMEOUT, polling: 200 })
    await page.waitForTimeout(AFTER)
    const { profile } = await cdp.send('Profiler.stop')
    const data = await page.evaluate(() => {
      const C = window.__cold
      const gl = window.__ppHandles?.getState?.().gl
      const mark = performance.getEntriesByName('tides:ready')[0]
      return { ...C, mark: mark ? mark.startTime : null, programs: gl?.info.programs?.length ?? null, links: window.__progCount }
    })
    const out = analyse(profile, data)
    return {
      cold: !!process.env.COLD, params: PARAMS,
      ...out,
      readyAt: r1(data.readyAt), mark: r1(data.mark),
      mips: data.mips,
      programs: { held: data.programs, links: data.links },
      firstUses: data.uses.filter(([, ms]) => ms >= 1).map(([t, ms, tag, atDraw]) => [r1(t), r1(ms), tag + (atDraw ? ' (draw)' : '')]),
      firstUseMs: r1(data.uses.reduce((s, [, ms]) => s + ms, 0)),
      drawUses: data.uses.filter(([, , , atDraw]) => atDraw).map(([t, ms, tag]) => [r1(t), r1(ms), tag]),
      frames: frameStats(data.raf, data.readyAt),
      uploads: data.uploads.map(([t, ms, size, src]) => [r1(t), r1(ms), size, src]),
      linkAt: data.linkAt.map((t) => Math.round(t)),
    }
  } finally {
    await browser.close()
  }
}

;(async () => {
  for (let i = 0; i < RUNS; i++) {
    const result = await H.withGpuLock(run)
    const line = JSON.stringify({ label: process.env.LABEL || null, ...result })
    console.log(line)
    if (process.env.OUT) fs.appendFileSync(process.env.OUT, line + '\n')
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
