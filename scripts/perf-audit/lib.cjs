// tides in-page perf harness (tides-0oi.2). See README.md in this directory.
//
//   const H = require('./lib.cjs')
//   const { browser, page } = await H.launch({ phone: true })        // 390x844 dpr3 isMobile; default 960x600 dpr1
//   await H.open(page, { focus: 'earth' })                            // URL params merged over DEFAULTS
//   await H.hook(page)                                                // window.__H in page (see IN_PAGE below)
//   await H.poseMain(page, { lat: 30, lon: -100, km: 400 })           // system view close zoom over a point
//   await H.openShip(page, { lat: 20, lon: -150, km: 600 })           // ship mode held at a pose (call instead of open)
//   await H.settle(page, 8000); await page.evaluate(() => { __H.freeze(); __H.pause() })
//   const r = await H.withGpuLock(() => page.evaluate(() => __H.ab(['base', 'myVariant'], 8, 12)))
//
// In page: __H.frame (last frame's recorded gl.render calls), __H.replay(K) -> {wall, gpu},
// __H.reg(name, on, off), __H.ab(names, K, N), __H.pixels(names), __H.breakdown(K, N, opts),
// __H.shaderVariant(filter, pairs, name), __H.vram(), __H.programs(), __H.T (three), __H.gl, __H.store, __H.earth().
// Rules: __H.pause() after the pose settles (an idle page still draws and loads a shared GPU); wrap every timing
// in withGpuLock. ANGLE-Metal's TIME_ELAPSED over-reads frames with extra render-target passes (the glow): read
// dWall for multi-pass variants, and don't replay glow=1 frames at all (see glow-pass-only.js).
// Pose hooks: the app must be served with scripts/phone-perf/vite.config.mjs (s02/perf-device), which adds
// window.__mainPose / __ship / __shipPose at transform time. POSE VALIDITY on the low tier: the ship can't fly
// below ~450 km (src/ship/ship-bodies.ts:71-76) and streamed tiles are off; use poseMain close zoom instead.
const fs = require('fs')
const path = require('path')
// playwright-core isn't a tides dependency: PLAYWRIGHT_CORE=<path to playwright-core> or have it resolvable.
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core')

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5391}/tides/`
// Shared with the phone-perf harness's GPU_LOCK (mkdir lock, owner '<who> <epoch ms>', stale after 180 s).
const LOCK_DIR = process.env.GPU_LOCK || path.join(require('os').tmpdir(), 'tides-gpu-lock')
// chrome-headless-shell with ANGLE-Metal (swiftshader is far too slow): CHROME=<exe>, else the newest
// ms-playwright chromium_headless_shell.
function chromeExe() {
  if (process.env.CHROME) return process.env.CHROME
  const root = process.env.HOME + '/Library/Caches/ms-playwright/'
  const shell = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop()
  if (!shell) throw new Error('no chromium_headless_shell in ' + root + ' (npx playwright install chromium-headless-shell, or set CHROME)')
  const dir = root + shell + '/'
  return dir + fs.readdirSync(dir).find((d) => d.startsWith('chrome-')) + '/chrome-headless-shell'
}

const DEFAULTS = { quality: 'low', weather: 'static', speed: '0', t: '2026-03-20T15:00:00Z' }

async function launch({ phone = !!process.env.PHONE, width, height, dpr, vsync = true, args = [] } = {}) {
  const W = width || (phone ? 390 : 960), Hh = height || (phone ? 844 : 600), D = dpr || (phone ? 3 : 1)
  const browser = await chromium.launch({
    executablePath: chromeExe(),
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
      ...(vsync ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']), ...args],
  })
  const page = await browser.newPage({ viewport: { width: W, height: Hh }, deviceScaleFactor: D, isMobile: phone, hasTouch: phone })
  page.on('pageerror', (e) => console.error('pageerror:', String(e).slice(0, 300)))
  await page.addInitScript(INIT)
  return { browser, page, W, H: Hh, DPR: D }
}

// Init script: VRAM accounting + program count. COLD=1 forces cold Metal shader compiles.
const INIT = `(() => {
  const P = WebGL2RenderingContext.prototype
  const bpp = { 0x8058: 4, 0x8C43: 4, 0x881A: 8, 0x8814: 16, 0x8229: 1, 0x822B: 2, 0x8D62: 2, 0x8051: 3, 0x8C41: 3,
    0x822D: 2, 0x822E: 4, 0x8230: 8, 0x8C3A: 4, 0x8C3D: 4, 0x81A5: 2, 0x81A6: 4, 0x8CAC: 4, 0x88F0: 4, 0x8CAD: 8, 0x822F: 4, 0x8232: 1, 0x8236: 4 }
  const V = (window.__vram = { byFmt: {}, total: 0, n: 0, compressed: 0, list: [] })
  const add = (fmt, bytes, what) => { V.byFmt[fmt] = (V.byFmt[fmt] || 0) + bytes; V.total += bytes; V.n++; V.list.push([what, fmt, bytes]) }
  // Resident bytes (tides-0oi.7): per WebGLTexture (the one bound to the call's target), per face/level slot, so a
  // re-specified level replaces its bytes and deleteTexture subtracts them. V.total above never subtracts.
  V.live = 0; V.liveN = 0
  const liveBy = new WeakMap()
  const BINDING = { 0x0DE1: 0x8069, 0x8513: 0x8514, 0x806F: 0x806A, 0x8C1A: 0x8C1D }
  const bindingOf = (ctx, t) => ctx.getParameter(BINDING[t] || (t >= 0x8515 && t <= 0x851A ? 0x8514 : 0x8069))
  const setLive = (ctx, t, slot, bytes) => {
    const tex = bindingOf(ctx, t)
    if (!tex) return
    let m = liveBy.get(tex)
    if (!m) { m = new Map(); liveBy.set(tex, m); V.liveN++ }
    V.live += bytes - (m.get(slot) || 0)
    m.set(slot, bytes)
  }
  V.liveOf = (tex) => { const m = liveBy.get(tex); let b = 0; if (m) for (const v of m.values()) b += v; return b }
  const dt = P.deleteTexture
  P.deleteTexture = function (tex) {
    const m = tex && liveBy.get(tex)
    if (m) { for (const v of m.values()) V.live -= v; liveBy.delete(tex); V.liveN-- }
    return dt.apply(this, arguments)
  }
  // 4x4-block compressed formats' bytes per block (tides-0oi.14): ASTC 4x4, BC7, ETC2/EAC, S3TC, each with its sRGB twin.
  const block = { 0x93B0: 16, 0x93D0: 16, 0x8E8C: 16, 0x8E8D: 16, 0x9274: 8, 0x9275: 8, 0x9278: 16, 0x9279: 16,
    0x83F0: 8, 0x83F1: 8, 0x8C4C: 8, 0x8C4D: 8, 0x83F2: 16, 0x83F3: 16, 0x8C4E: 16, 0x8C4F: 16 }
  const levelBytes = (fmt, w, h) => (block[fmt] ? Math.ceil(w / 4) * Math.ceil(h / 4) * block[fmt] : w * h * (bpp[fmt] || 4))
  const ts2 = P.texStorage2D
  P.texStorage2D = function (t, levels, fmt, w, h) {
    let b = 0, ww = w, hh = h
    for (let i = 0; i < levels; i++) { b += levelBytes(fmt, ww, hh); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1) }
    add('0x' + fmt.toString(16), b, w + 'x' + h + 'x' + levels)
    setLive(this, t, 'storage', t === 0x8513 ? 6 * b : b)
    return ts2.apply(this, arguments)
  }
  const ts3 = P.texStorage3D
  P.texStorage3D = function (t, levels, fmt, w, h, d) {
    let b = 0, ww = w, hh = h
    for (let i = 0; i < levels; i++) { b += ww * hh * d * (bpp[fmt] || 4); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1) }
    add('0x' + fmt.toString(16), b, w + 'x' + h + 'x' + d + 'x' + levels)
    setLive(this, t, 'storage', b)
    return ts3.apply(this, arguments)
  }
  const ti2 = P.texImage2D
  P.texImage2D = function (t, level, fmt) {
    const lw = arguments.length >= 9 ? arguments[3] : arguments[5] && arguments[5].width
    const lh = arguments.length >= 9 ? arguments[4] : arguments[5] && arguments[5].height
    if (lw && lh) setLive(this, t, t + ':' + level, lw * lh * (bpp[fmt] || 4))
    if (arguments.length >= 9 && level === 0) add('img:0x' + fmt.toString(16), arguments[3] * arguments[4] * (bpp[fmt] || 4), arguments[3] + 'x' + arguments[4])
    else if (arguments.length === 6 && level === 0 && arguments[5] && arguments[5].width) add('img:0x' + fmt.toString(16), arguments[5].width * arguments[5].height * (bpp[fmt] || 4), arguments[5].width + 'x' + arguments[5].height)
    return ti2.apply(this, arguments)
  }
  const ci2 = P.compressedTexImage2D
  P.compressedTexImage2D = function (t, level, fmt, w, h, b, data) {
    const n = data && data.byteLength || 0
    V.compressed += n; add('cmp:0x' + fmt.toString(16), n, w + 'x' + h + '@' + level)
    setLive(this, t, t + ':' + level, n)
    return ci2.apply(this, arguments)
  }
  const cs2 = P.compressedTexSubImage2D
  P.compressedTexSubImage2D = function (t, level, x, y, w, h, fmt, data) {
    V.compressed += (data && data.byteLength) || 0
    return cs2.apply(this, arguments)
  }
  window.__progCount = 0
  const lp = P.linkProgram
  P.linkProgram = function () { window.__progCount++; return lp.apply(this, arguments) }
  ${process.env.COLD ? `const ss = P.shaderSource; const salt = Math.random();
  P.shaderSource = function (sh, src) { if (src.includes('gl_FragColor') || src.includes('out highp vec4') || /out\\s+\\w*\\s*vec4/.test(src)) src = src.replace(/void\\s+main\\s*\\(\\s*\\)\\s*\\{/, 'void main() { if (gl_FragCoord.x < -' + salt + ') discard;'); return ss.call(this, sh, src) }` : ''}
})()`

async function open(page, params = {}, { waitMs = 12000 } = {}) {
  const q = new URLSearchParams({ ...DEFAULTS, ...params })
  for (const [k, v] of [...q]) if (v === null || v === 'null' || v === undefined) q.delete(k)
  await page.goto(`${BASE_URL}?${q}`)
  await page.waitForTimeout(waitMs)
}

async function hook(page) {
  await page.evaluate(IN_PAGE)
  await page.waitForTimeout(300)
  return page.evaluate(() => window.__H.summary())
}

// Runs in the page. Records every gl.render of a frame (scene, camera, viewport, scissor, target), and replays it.
const IN_PAGE = async () => {
  if (window.__H) return
  // Handles: the phone-perf build's window.__ppHandles when present, else the dev server's module URLs.
  const names = performance.getEntriesByType('resource').map((e) => e.name)
  const find = (re) => names.find((n) => re.test(n))
  const pp = window.__ppHandles
  const store = pp?.useStore ?? (await import(find(/\/src\/store\.ts/))).useStore
  const T = pp?.THREE ?? (await import(find(/\/deps\/three\.js/)))
  const fiber = pp?.getState ? null : await import(find(/\/deps\/@react-three_fiber\.js/))
  const rootState = () => (pp?.getState ? pp.getState() : [...fiber._roots.values()][0].store.getState())
  const gl = rootState().gl
  const ctx = gl.getContext()
  const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2')
  const H = (window.__H = { T, gl, ctx, ext, store, fiber, frame: [], frames: 0, recording: true })
  let cur = []
  const orig = gl.render
  H.origRender = orig
  gl.render = function (scene, camera) {
    if (H.recording) {
      const vp = new T.Vector4(), sc = new T.Vector4()
      gl.getViewport(vp); gl.getScissor(sc)
      cur.push({ scene, camera, vp, sc, scissorTest: gl.getScissorTest(), target: gl.getRenderTarget(), autoClear: gl.autoClear })
    }
    return orig.call(this, scene, camera)
  }
  const loop = () => { if (cur.length) { H.frame = cur; H.frames++ } cur = []; requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  const px = new Uint8Array(4)
  H.sync = () => { gl.setRenderTarget(null); ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px) }
  H.replayOnce = (calls = H.frame) => {
    H.recording = false
    for (const c of calls) {
      // A render target's pass keeps the target's own viewport and scissor, as setRenderTarget sets them live
      // (the recorded ones are the canvas's): else a bake replays into the wrong texels (tides-0oi.5).
      gl.setRenderTarget(c.target)
      if (!c.target) { gl.setViewport(c.vp); gl.setScissor(c.sc); gl.setScissorTest(c.scissorTest) }
      const ac = gl.autoClear; gl.autoClear = c.autoClear
      orig.call(gl, c.scene, c.camera)
      gl.autoClear = ac
    }
    H.recording = true
  }
  // K replays of the recorded frame between syncs: wall ms/frame (CPU submit + GPU, synced) and GPU ms/frame.
  H.replay = async (K = 10, calls = H.frame) => {
    H.replayOnce(calls); H.sync()
    const q = ext ? ctx.createQuery() : null
    if (q) ctx.beginQuery(ext.TIME_ELAPSED_EXT, q)
    const t0 = performance.now()
    for (let i = 0; i < K; i++) H.replayOnce(calls)
    if (q) ctx.endQuery(ext.TIME_ELAPSED_EXT)
    H.sync()
    const wall = (performance.now() - t0) / K
    let gpu = null
    if (q) {
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 4))
        if (ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) {
          if (!ctx.getParameter(ext.GPU_DISJOINT_EXT)) gpu = ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6 / K
          break
        }
      }
      ctx.deleteQuery(q)
    }
    return { wall, gpu }
  }
  H.variants = { base: { on() {}, off() {} } }
  H.reg = (name, on, off) => { H.variants[name] = { on, off } }
  const med = (xs) => { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
  const min = (xs) => { const s = xs.filter((x) => x != null && isFinite(x)); return s.length ? Math.min(...s) : null }
  const f3 = (x) => (x == null ? null : +x.toFixed(3))
  H.med = med
  // Interleaved A/B over named variants (rotating order per round). Reports per variant median/min and the
  // median of per-round paired differences vs the first variant.
  H.ab = async (names, K = 10, N = 12) => {
    const calls = H.frame.slice()
    const rows = []
    for (let n = 0; n < N; n++) {
      const order = names.map((_, i) => names[(i + n) % names.length])
      const row = {}
      for (const nm of order) {
        const v = H.variants[nm]
        v.on(); await new Promise((r) => setTimeout(r, 0))
        H.replayOnce(calls) // first draw after a program swap compiles; keep it out of the timing
        row[nm] = await H.replay(K, calls)
        v.off()
      }
      rows.push(row)
    }
    const b = names[0]
    const out = {}
    for (const nm of names) out[nm] = {
      gpuMed: f3(med(rows.map((r) => r[nm].gpu))), gpuMin: f3(min(rows.map((r) => r[nm].gpu))),
      wallMed: f3(med(rows.map((r) => r[nm].wall))), wallMin: f3(min(rows.map((r) => r[nm].wall))),
      dGpu: nm === b ? 0 : f3(med(rows.map((r) => (r[nm].gpu == null || r[b].gpu == null ? null : r[nm].gpu - r[b].gpu)))),
      dWall: nm === b ? 0 : f3(med(rows.map((r) => r[nm].wall - r[b].wall))),
    }
    return out
  }
  H.renderables = () => {
    const set = new Set(), list = []
    for (const c of H.frame) {
      if (set.has(c.scene)) continue
      set.add(c.scene)
      c.scene.traverseVisible((o) => { if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.material && (o.isSprite || o.geometry?.attributes?.position?.count > 0)) list.push(o) })
    }
    return list
  }
  H.key = (o) => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material
    let k = ''
    try { k = String(m.customProgramCacheKey?.() || '') } catch {}
    if (/onBeforeCompile|^\s*$/.test(k) || k.includes('{')) k = ''
    const chain = []
    for (let p = o; p && chain.length < 3; p = p.parent) if (p.name) chain.push(p.name)
    const geo = (o.geometry?.type || '').replace('Geometry', '').replace('Buffer', 'B')
    return (m.type.replace('Material', '') + ':' + (m.name || k.slice(0, 30) || '') + '@' + (chain.join('<') || o.parent?.type || '?') + '/' + geo + (m.side === 2 ? '/2s' : m.side === 1 ? '/back' : '')).slice(0, 90)
  }
  // Hide each group of renderables (grouped by H.key or opts.by) and time the frame without it.
  H.breakdown = async (K = 6, N = 6, { by = H.key, minCount = 1, top = 40 } = {}) => {
    const groups = new Map()
    for (const o of H.renderables()) { const k = by(o); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o) }
    const names = ['base']
    for (const [k, objs] of groups) {
      if (objs.length < minCount) continue
      const nm = 'hide:' + k + ' x' + objs.length
      // layers.mask=0 skips only this object's draw; visible=false would also hide its whole subtree (children).
      H.reg(nm, () => objs.forEach((o) => { o.__m = o.layers.mask; o.layers.mask = 0 }), () => objs.forEach((o) => { o.layers.mask = o.__m }))
      names.push(nm)
    }
    const r = await H.ab(names, K, N)
    const base = r.base
    const rows = Object.entries(r).filter(([n]) => n !== 'base').map(([n, v]) => ({ group: n.slice(5), saveGpu: v.dGpu == null ? null : f3(-v.dGpu), saveWall: f3(-v.dWall) }))
    rows.sort((a, b) => (b.saveGpu ?? b.saveWall) - (a.saveGpu ?? a.saveWall))
    return { base, rows: rows.slice(0, top) }
  }
  // Fragment/vertex text replacement variant on every material matching filter(material, object). A pair's `from`
  // is a string (all occurrences) or a RegExp (String.replace). hits() counts replacements at compile: check it's > 0.
  H.shaderVariant = (filter, pairs, name, { stage = 'fragmentShader' } = {}) => {
    const mats = new Set()
    for (const o of H.renderables()) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => filter(m, o) && mats.add(m)) }
    const saved = new Map()
    let hits = 0
    const on = () => {
      for (const m of mats) {
        saved.set(m, { obc: m.onBeforeCompile, key: m.customProgramCacheKey })
        const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey
        m.onBeforeCompile = function (sh, r) {
          prev && prev.call(this, sh, r)
          for (const [a, b] of pairs) { const st = sh[stage]; const re = a instanceof RegExp; if (re ? a.test(st) : st.includes(a)) hits++; sh[stage] = re ? st.replace(a, b) : st.split(a).join(b) }
        }
        m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|v:' + name }
        m.needsUpdate = true
      }
    }
    const off = () => { for (const m of mats) { const s = saved.get(m); m.onBeforeCompile = s.obc; m.customProgramCacheKey = s.key; m.needsUpdate = true } }
    H.reg(name, on, off)
    return { materials: mats.size, hits: () => hits }
  }
  // Same-tick pixel A/B/A2 on the canvas: for each name, render base, the variant, base again (no rAF between),
  // read the whole buffer each time. AA must be 0 (else the pose isn't frozen); AB isolates the variant.
  // Returns per name { AA, AB } with px (any channel differs), px8 (>8), max, mean over differing px.
  H.pixels = async (names) => {
    const w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight
    const grab = () => { gl.setRenderTarget(null); const b = new Uint8Array(w * h * 4); ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, b); return b }
    const shot = async (nm) => { const v = H.variants[nm]; v.on(); await new Promise((r) => setTimeout(r, 0)); H.replayOnce(); H.replayOnce(); const b = grab(); v.off(); return b }
    const cmp = (a, b) => { let n = 0, n8 = 0, mx = 0, sum = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); if (d) { n++; sum += d; if (d > 8) n8++; if (d > mx) mx = d } } return { px: n, px8: n8, max: mx, mean: n ? +(sum / n).toFixed(2) : 0 } }
    const out = {}
    for (const nm of names) { const A = await shot('base'), B = await shot(nm), A2 = await shot('base'); out[nm] = { AA: cmp(A, A2), AB: cmp(A, B) } }
    return out
  }
  // Note: __vram's total sums allocations since load (deletes aren't subtracted; cube faces are under-counted), so
  // read it as "what this pose has allocated"; liveMB is what is resident now (textures only, no renderbuffers).
  H.vram = () => {
    const V = window.__vram, by = {}
    for (const [k, v] of Object.entries(V.byFmt)) by[k] = +(v / 1048576).toFixed(1)
    return { totalMB: +(V.total / 1048576).toFixed(1), liveMB: +(V.live / 1048576).toFixed(1), liveTextures: V.liveN, compressedMB: +(V.compressed / 1048576).toFixed(1), n: V.n, byFmtMB: by, gl: { ...gl.info.memory }, programs: gl.info.programs?.length }
  }
  H.programs = () => (gl.info.programs || []).map((p) => ({ name: p.name, key: (p.cacheKey || '').slice(0, 80), used: p.usedTimes }))
  H.earth = () => store.getState().earth?.current
  // Stop/restart R3F's loop: pause after settling so this page draws nothing while others time (replays still work).
  H.root = rootState
  // With ?idlehz=auto the frameloop is already 'never' and IdleRate's rAF driver draws (tides-0oi.31): hold that
  // instead (setFrameloop would also zero the clock under it).
  H.pause = () => (window.__idleRate ? window.__idleRate.hold(true) : H.root().setFrameloop('never'))
  H.resume = () => (window.__idleRate ? window.__idleRate.hold(false) : H.root().setFrameloop('always'))
  H.freeze = () => {
    store.getState().setTimeScale?.(0)
    for (const o of H.renderables()) {
      const u = o.material?.uniforms?.uCloudShift
      if (u && !u.__frozen) { Object.defineProperty(u, 'value', { get: () => 0, set() {} }); u.__frozen = true }
    }
  }
  // Uncapped rAF frame intervals over ms (needs launch without vsync for a cost reading).
  H.raf = (ms = 3000) => new Promise((res) => {
    const t = []; let last = performance.now(); const end = last + ms
    const step = (now) => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(step); else { t.sort((a, b) => a - b); res({ n: t.length, med: f3(t[t.length >> 1]), p90: f3(t[Math.floor(t.length * 0.9)]), p99: f3(t[Math.floor(t.length * 0.99)]), max: f3(t[t.length - 1]) }) } }
    requestAnimationFrame(step)
  })
  H.summary = () => ({
    calls: H.frame.length,
    perCall: H.frame.map((c) => ({ cam: c.camera.type + (c.camera.fov ? '/' + c.camera.fov.toFixed(0) : ''), vp: [c.vp.x, c.vp.y, c.vp.z, c.vp.w], target: c.target ? (c.target.width + 'x' + c.target.height) : 'canvas', objs: (() => { let n = 0; c.scene.traverseVisible((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) n++ }); return n })() })),
    dpr: gl.getPixelRatio(), canvas: [gl.domElement.width, gl.domElement.height], gpuTimer: !!ext,
    info: { ...gl.info.render }, programs: gl.info.programs?.length, progLinks: window.__progCount,
  })
}

// System view: each frame after the controls, put the main camera over lat/lon at km altitude, looking at
// Earth's centre (tilt: degrees from straight down toward north; pass null to clear the hook).
async function poseMain(page, pose) {
  await page.evaluate((pose) => {
    if (!pose) { window.__mainPose = null; return }
    const T = window.__H.T
    const d = Math.PI / 180
    window.__mainPose = (camera) => {
      const earth = window.__H.earth()
      if (!earth) return
      let ground = null
      earth.traverse((o) => { if (!ground && o.isMesh && o.material?.isMeshPhongMaterial) ground = o })
      if (!ground) return
      ground.updateWorldMatrix(true, false)
      const c = new T.Vector3().setFromMatrixPosition(ground.matrixWorld)
      if (!ground.geometry.boundingSphere) ground.geometry.computeBoundingSphere()
      const s = new T.Vector3(); ground.getWorldScale(s)
      const R = ground.geometry.boundingSphere.radius * s.x
      const la = pose.lat * d, lo = pose.lon * d
      const up = new T.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).transformDirection(ground.matrixWorld)
      const pos = c.clone().addScaledVector(up, R + (pose.km * R) / 6371)
      camera.position.copy(pos)
      const north = new T.Vector3(0, 1, 0).transformDirection(ground.matrixWorld)
      const look = c.clone()
      if (pose.tilt) { const east = north.clone().cross(up).normalize(); const n2 = up.clone().cross(east).normalize(); look.copy(pos).addScaledVector(up, -Math.cos(pose.tilt * d)).addScaledVector(n2, Math.sin(pose.tilt * d)) }
      camera.up.copy(north)
      camera.lookAt(look)
      camera.updateMatrixWorld()
    }
  }, pose)
}

// Ship mode held at a pose over lat/lon: km altitude, nose east, pitch degrees (+up), heading degrees from east toward north.
async function openShip(page, pose, params = {}) {
  await open(page, { ship: '1', ...params }, { waitMs: 9000 })
  for (const sel of ['button:has-text("Fly")', 'text=Fly']) {
    try { await page.locator(sel).last().click({ timeout: 1500 }); break } catch {}
  }
  await page.waitForTimeout(800)
  await setShipPose(page, pose)
}
async function setShipPose(page, pose) {
  await page.evaluate((pose) => {
    window.__shipPoseArgs = pose
    if (window.__shipPose) return
    window.__shipPose = (state, earth) => {
      const p = window.__shipPoseArgs
      if (!p || !earth || !window.__H) return
      const T = window.__H.T, d = Math.PI / 180
      const la = p.lat * d, lo = p.lon * d
      const up = new T.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(earth.spin)
      const north0 = new T.Vector3(0, 1, 0).applyQuaternion(earth.spin)
      const east = north0.clone().cross(up).normalize()
      const north = up.clone().cross(east).normalize()
      state.position.copy(earth.position).addScaledVector(up, earth.radius + (p.km * earth.radius) / 6371)
      state.velocity.set(0, 0, 0); state.angularVelocity.set(0, 0, 0)
      const h = (p.heading || 0) * d, pi = (p.pitch || 0) * d
      const flat = east.clone().multiplyScalar(Math.cos(h)).addScaledVector(north, Math.sin(h))
      const fwd = flat.multiplyScalar(Math.cos(pi)).addScaledVector(up, Math.sin(pi)).normalize()
      const camUp = up.clone().addScaledVector(fwd, -up.dot(fwd)).normalize()
      const right = fwd.clone().cross(camUp).normalize()
      state.orientation.setFromRotationMatrix(new T.Matrix4().makeBasis(right, camUp, fwd.clone().negate()))
    }
  }, pose)
}

async function settle(page, ms) { await page.waitForTimeout(ms) }

// Cross-agent GPU mutex: only one of this audit's agents times at once. Hold it only around timing.
async function withGpuLock(fn, { who = process.env.WHO || String(process.pid), staleMs = 180000 } = {}) {
  const lock = LOCK_DIR
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), who + ' ' + Date.now()); break } catch {
      try { const [, t] = fs.readFileSync(path.join(lock, 'owner'), 'utf8').split(' '); if (Date.now() - +t > staleMs) fs.rmSync(lock, { recursive: true, force: true }) } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  try { return await fn() } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}

// CDP CPU profile of the live page for ms; returns top self-time functions (ms) and total busy share.
async function cpuProfile(page, ms = 4000, top = 25) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await page.waitForTimeout(ms)
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dts = profile.timeDeltas
  let idle = 0, total = 0
  profile.samples.forEach((id, i) => {
    const n = byId.get(id), dt = (dts[i] || 0) / 1000
    total += dt
    const fn = n.callFrame.functionName || '(anon)'
    if (fn === '(idle)' || fn === '(program)' && false) idle += dt
    const k = fn + ' ' + (n.callFrame.url || '').split('/').slice(-1)[0] + ':' + n.callFrame.lineNumber
    self.set(k, (self.get(k) || 0) + dt)
  })
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +v.toFixed(1)])
  return { ms: +total.toFixed(0), busyShare: +(1 - idle / total).toFixed(3), top: rows }
}

module.exports = { launch, open, hook, poseMain, openShip, setShipPose, settle, withGpuLock, cpuProfile, BASE_URL, DEFAULTS }
