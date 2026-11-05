// tides-0oi.31's proof: the low tier's idle frame-rate cap (src/idle-rate.ts, src/renderers/IdleRate.tsx), on the
// phone viewport (390x844, quality=low) with ?idlehz=auto (so the page exposes window.__idleRate and its setOn switches
// the cap in the same page) and the pixel ratio pinned (?dprctl=fixed:2: the paced controller pauses under the cap, so
// unpinned the two arms could sit at different ratios).
//   MODE=board  per pose, real rAF ticks with the cap off vs on: what the screen shows each tick (the last drawn frame;
//               a held tick repeats it). Writes a 60-tick strip of a crop of the main view per arm, each tile labelled
//               with the px changed since the tick before, and a side-by-side 60 fps MP4 (off | on) of TICKS ticks
//               when ffmpeg is on the PATH. OUT (default ./idle-rate-board), POSES (system,aurora-night,ocean-close).
//   MODE=time   paired blocks of real rAF ticks, cap off vs on (setOn), in one page at one pose, each under the GPU
//               lock: GPU ms/s (a TIME_ELAPSED query over each drawn frame's effects-to-after-effects span), CPU ms/s
//               (the same span on the main thread) and draws/s. BLOCK_MS (10000), PAIRS (4), POSE (system).
//   MODE=shot   one pose's whole canvas at a frozen tick (two frames at clock time 100 s, frameloop paused), written raw to SHOT_OUT, and compared
//               with each raw file in CMP (comma-separated). For the default-off check: load the base build and this
//               one in turn (swap the files under the same vite) without ?idlehz, interleaved.
// Env: lib.cjs's BASE_URL / PLAYWRIGHT_CORE / GPU_LOCK / WHO, DPR (2), PARAMS (JSON, merged into the URL).
//
//   cd scripts/perf-audit && MODE=board node idle-rate.cjs
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const H = require('./lib.cjs')

const MODE = process.env.MODE || 'board'
const DPR = process.env.DPR || '2'
const OUT = process.env.OUT || path.join(__dirname, 'idle-rate-board')
const EXTRA = JSON.parse(process.env.PARAMS || '{}')

const POSES = {
  // The default (clock) view at real time: the aurora's and the Sun's time keep it moving.
  system: { params: { speed: '1' }, settle: 9000 },
  // tides-0oi.13's aurora-night: close zoom 300 km at 66N 20E at night, looking north across the oval.
  'aurora-night': { params: { speed: '1', focus: 'earth', t: '2026-03-20T19:00:00Z' }, pose: { lat: 66, lon: 20, km: 300, tilt: 70 }, settle: 15000 },
  // Close zoom low over the Atlantic in daylight (water, glint, clouds drifting).
  'ocean-close': { params: { speed: '1', focus: 'earth' }, pose: { lat: 10, lon: -30, km: 20, tilt: 60 }, settle: 15000 },
}

async function openPose(name, params = {}) {
  const p = POSES[name]
  if (!p) throw new Error(`unknown pose ${name}`)
  const { browser, page } = await H.launch({ phone: true })
  page.on('pageerror', (e) => console.error('pageerror', e.message))
  await H.open(page, { idlehz: 'auto', dprctl: `fixed:${DPR}`, ...p.params, ...EXTRA, ...params }, { waitMs: 6000 })
  await H.hook(page)
  if (p.pose) await H.poseMain(page, p.pose)
  await H.settle(page, p.settle)
  await page.evaluate(FX)
  return { browser, page }
}

// In page: capture what each rAF tick shows. An after-effect (it runs only on drawn ticks) copies the canvas into a
// small frame; a rAF loop started after the driver's records, each tick, the frame on screen.
const FX = () => {
  // R3F's effects: the phone-perf build's handles, else the dev server's module.
  window.__fx = window.__ppHandles?.addEffect ? window.__ppHandles : __H.fiber
  if (!window.__fx?.addAfterEffect) throw new Error('no R3F addEffect/addAfterEffect handle')
}

const CAPTURE = () => {
  const { gl } = __H
  const canvas = gl.domElement
  window.__capture = (ticks, crop, scale) => new Promise((res) => {
    const frames = []
    const shown = []
    let current = -1
    const w = Math.round(crop.w * scale), h = Math.round(crop.h * scale)
    const un = __fx.addAfterEffect(() => {
      const f = new OffscreenCanvas(w, h)
      f.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h)
      frames.push(f)
      current = frames.length - 1
    })
    const times = []
    const step = (ts) => {
      if (current >= 0) { shown.push(current); times.push(ts) }
      if (shown.length < ticks) requestAnimationFrame(step)
      else { un(); res({ frames, shown, times, w, h }) }
    }
    requestAnimationFrame(step)
  })
  const toB64 = async (c) => {
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }
  const pxDiff = (a, b) => {
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data
    let n = 0; for (let i = 0; i < da.length; i += 4) if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) n++
    return n
  }
  // One arm: settle (2.5 s: the cap starts 2 s after the last activity), capture, then a labelled strip of the first
  // 60 ticks and every tick's frame as PNG for the clip.
  window.__arm = async ({ on, ticks, label, crop, stripScale, clipScale }) => {
    __idleRate.setOn(on)
    await new Promise((r) => setTimeout(r, 2500))
    const d0 = __idleRate.draws, s0 = __idleRate.skips
    const strip = await __capture(ticks, crop, stripScale)
    const drawn = __idleRate.draws - d0, skipped = __idleRate.skips - s0
    const n = Math.min(60, strip.shown.length), cols = 10, pad = 4, cap = 14, head = 24
    const out = new OffscreenCanvas(cols * (strip.w + pad) + pad, head + Math.ceil(n / cols) * (strip.h + cap + pad) + pad)
    const g = out.getContext('2d')
    g.fillStyle = '#111'; g.fillRect(0, 0, out.width, out.height)
    g.fillStyle = '#eee'; g.font = '14px sans-serif'; g.fillText(label, pad, 17)
    const changed = []
    for (let i = 0; i < n; i++) {
      const f = strip.frames[strip.shown[i]]
      const d = i ? (strip.shown[i] === strip.shown[i - 1] ? 0 : pxDiff(strip.frames[strip.shown[i - 1]], f)) : null
      changed.push(d)
      const x = pad + (i % cols) * (strip.w + pad), y = head + Math.floor(i / cols) * (strip.h + cap + pad)
      g.drawImage(f, x, y)
      g.fillStyle = d === 0 ? '#f6a' : '#9cf'; g.font = '11px sans-serif'
      g.fillText(`${i + 1}: ${d === null ? 'first' : d ? d + ' px' : 'same'}`, x, y + strip.h + 11)
    }
    const intervals = strip.times.slice(1).map((t, i) => t - strip.times[i]).sort((a, b) => a - b)
    const stats = { drawn, skipped, ticks: strip.shown.length, distinct: new Set(strip.shown).size, tickMed: +intervals[intervals.length >> 1].toFixed(2), tickMax: +intervals[intervals.length - 1].toFixed(2), changed }
    const stripPng = await toB64(out)
    // The clip at clipScale of the crop.
    const clip = []
    if (clipScale) {
      const c = new OffscreenCanvas(Math.round(crop.w * clipScale / 2) * 2, Math.round(crop.h * clipScale / 2) * 2)
      const pngs = new Map()
      for (const k of strip.shown) if (!pngs.has(k)) {
        c.getContext('2d').drawImage(strip.frames[k], 0, 0, c.width, c.height)
        pngs.set(k, await toB64(c))
      }
      for (const k of strip.shown) clip.push(pngs.get(k))
    }
    return { stats, stripPng, clip }
  }
}

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
}

async function board() {
  fs.mkdirSync(OUT, { recursive: true })
  const ticks = +(process.env.TICKS || 120)
  const ffmpeg = hasFfmpeg()
  for (const name of (process.env.POSES || 'system,aurora-night,ocean-close').split(',')) {
    const { browser, page } = await openPose(name)
    try {
      await page.evaluate(CAPTURE)
      // The main view's canvas pixels (the system view is the top panel; close zoom too).
      const crop = await page.evaluate(() => {
        const c = __H.gl.domElement, r = c.getBoundingClientRect(), dpr = c.width / r.width
        const main = [...document.querySelectorAll('.panel')].find((p) => p.dataset.area === 'main').getBoundingClientRect()
        // readPixels-free: drawImage takes CSS-top-left canvas coordinates.
        return { x: Math.round((main.left - r.left) * dpr), y: Math.round((main.top - r.top) * dpr), w: Math.round(main.width * dpr), h: Math.round(main.height * dpr) }
      })
      const arms = {}
      for (const on of [false, true]) {
        const label = `${name}: cap ${on ? 'ON (30 Hz idle)' : 'off (every tick, today)'}; pink = same frame as the tick before`
        arms[on] = await page.evaluate((a) => __arm(a), { on, ticks, label, crop, stripScale: 0.18, clipScale: ffmpeg ? 0.5 : 0 })
        const file = path.join(OUT, `${name}-${on ? 'on' : 'off'}-strip.png`)
        fs.writeFileSync(file, Buffer.from(arms[on].stripPng, 'base64'))
        const { changed, ...rest } = arms[on].stats
        console.log(JSON.stringify({ pose: name, cap: on, file, ...rest, sameTicks: changed.filter((d) => d === 0).length }))
      }
      if (ffmpeg) {
        const dir = fs.mkdtempSync(path.join(OUT, `.${name}-`))
        const clips = {}
        for (const on of [false, true]) {
          const sub = path.join(dir, on ? 'on' : 'off'); fs.mkdirSync(sub)
          arms[on].clip.forEach((b64, i) => fs.writeFileSync(path.join(sub, `f${String(i).padStart(4, '0')}.png`), Buffer.from(b64, 'base64')))
          clips[on] = path.join(sub, 'f%04d.png')
        }
        const mp4 = path.join(OUT, `${name}-off-vs-on.mp4`)
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', clips[false], '-framerate', '60', '-i', clips[true],
          '-filter_complex', '[0:v]pad=iw+8:ih:0:0:gray[a];[a][1:v]hstack=inputs=2,format=yuv420p', '-r', '60', '-c:v', 'libx264', '-crf', '12', mp4])
        fs.rmSync(dir, { recursive: true, force: true })
        console.log(JSON.stringify({ pose: name, mp4, note: 'left: cap off, right: cap on, 60 fps' }))
      }
    } finally { await browser.close() }
  }
}

async function time() {
  const pose = process.env.POSE || 'system'
  const { browser, page } = await openPose(pose)
  try {
    await page.evaluate(() => {
      const { ctx, ext } = __H
      let q = null, t0 = 0
      const pending = []
      window.__acc = null
      __fx.addEffect(() => {
        if (!window.__acc) return
        t0 = performance.now()
        if (ext && !q) { q = ctx.createQuery(); ctx.beginQuery(ext.TIME_ELAPSED_EXT, q) }
      })
      __fx.addAfterEffect(() => {
        const acc = window.__acc
        if (!acc) { if (q) { ctx.endQuery(ext.TIME_ELAPSED_EXT); ctx.deleteQuery(q); q = null } return }
        acc.cpu += performance.now() - t0
        acc.draws++
        if (q) { ctx.endQuery(ext.TIME_ELAPSED_EXT); pending.push([q, acc]); q = null }
        for (let i = pending.length - 1; i >= 0; i--) {
          const [pq, pa] = pending[i]
          if (ctx.getQueryParameter(pq, ctx.QUERY_RESULT_AVAILABLE)) {
            if (!ctx.getParameter(ext.GPU_DISJOINT_EXT)) { pa.gpu += ctx.getQueryParameter(pq, ctx.QUERY_RESULT) / 1e6; pa.gpuN++ }
            ctx.deleteQuery(pq); pending.splice(i, 1)
          }
        }
      })
      window.__block = async (on, ms) => {
        __idleRate.setOn(on)
        await new Promise((r) => setTimeout(r, 2500))
        const acc = (window.__acc = { cpu: 0, gpu: 0, gpuN: 0, draws: 0 })
        const s0 = __idleRate.skips, start = performance.now()
        await new Promise((r) => setTimeout(r, ms))
        window.__acc = null
        const s = (performance.now() - start) / 1000
        await new Promise((r) => setTimeout(r, 300))
        // GPU ms/s scales the timed frames' mean to every drawn frame (a disjoint query is dropped).
        return { on, cpuMsPerS: acc.cpu / s, gpuMsPerS: acc.gpuN ? (acc.gpu / acc.gpuN) * acc.draws / s : null, drawsPerS: acc.draws / s, skipsPerS: (__idleRate.skips - s0) / s, cpuPerDraw: acc.cpu / acc.draws, gpuPerDraw: acc.gpuN ? acc.gpu / acc.gpuN : null }
      }
    })
    const BLOCK = +(process.env.BLOCK_MS || 10000), PAIRS = +(process.env.PAIRS || 4)
    const blocks = []
    for (let i = 0; i < PAIRS; i++) {
      const order = i % 2 ? [true, false] : [false, true]
      const pair = await H.withGpuLock(() => page.evaluate(async ({ order, BLOCK }) => {
        const out = []
        for (const on of order) out.push(await __block(on, BLOCK))
        return out
      }, { order, BLOCK }))
      blocks.push(...pair)
      // Between pairs, nothing timed: hold the driver so this page doesn't load the shared GPU.
      await page.evaluate(() => __idleRate.hold(true))
      await page.waitForTimeout(500)
      await page.evaluate(() => __idleRate.hold(false))
    }
    const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(3) : null }
    const arm = (on) => blocks.filter((b) => b.on === on)
    const sum = (on) => Object.fromEntries(['cpuMsPerS', 'gpuMsPerS', 'drawsPerS', 'skipsPerS', 'cpuPerDraw', 'gpuPerDraw'].map((k) => [k, med(arm(on).map((b) => b[k]))]))
    const pairs = []
    for (let i = 0; i < blocks.length; i += 2) {
      const [a, b] = blocks[i].on ? [blocks[i], blocks[i + 1]] : [blocks[i + 1], blocks[i]]
      pairs.push({ dCpu: a.cpuMsPerS - b.cpuMsPerS, dGpu: a.gpuMsPerS == null || b.gpuMsPerS == null ? null : a.gpuMsPerS - b.gpuMsPerS, rCpu: a.cpuMsPerS / b.cpuMsPerS, rGpu: a.gpuMsPerS && b.gpuMsPerS ? a.gpuMsPerS / b.gpuMsPerS : null })
    }
    console.log(JSON.stringify({
      pose, dpr: DPR, blockMs: BLOCK, off: sum(false), on: sum(true),
      paired: { dCpuMsPerS: med(pairs.map((p) => p.dCpu)), dGpuMsPerS: med(pairs.map((p) => p.dGpu)), cpuRatio: med(pairs.map((p) => p.rCpu)), gpuRatio: med(pairs.map((p) => p.rGpu)) },
      blocks: blocks.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))),
    }, null, 1))
  } finally { await browser.close() }
}

async function shot() {
  const pose = process.env.POSE || 'system'
  const { browser, page } = await openPose(pose, { idlehz: null, speed: '0' })
  try {
    const raw = await page.evaluate(() => {
      __H.freeze(); __H.pause()
      // Two frames at one fixed clock time, so the Sun's and the aurora's time match across loads.
      __H.root().advance(100); __H.root().advance(100)
      const { gl, ctx } = __H
      gl.setRenderTarget(null)
      const w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight, b = new Uint8Array(w * h * 4)
      ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, b)
      let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
      return { w, h, idleRate: !!window.__idleRate, frameloop: __H.root().frameloop, b64: btoa(bin) }
    })
    const buf = Buffer.from(raw.b64, 'base64')
    if (process.env.SHOT_OUT) fs.writeFileSync(process.env.SHOT_OUT, buf)
    const cmp = {}
    for (const f of (process.env.CMP || '').split(',').filter(Boolean)) {
      const o = fs.readFileSync(f)
      if (o.length !== buf.length) { cmp[path.basename(f)] = { px: -1 }; continue }
      let n = 0, mx = 0
      for (let i = 0; i < buf.length; i += 4) { const d = Math.max(Math.abs(buf[i] - o[i]), Math.abs(buf[i + 1] - o[i + 1]), Math.abs(buf[i + 2] - o[i + 2])); if (d) { n++; if (d > mx) mx = d } }
      cmp[path.basename(f)] = { px: n, max: mx }
    }
    console.log(JSON.stringify({ pose, w: raw.w, h: raw.h, idleRate: raw.idleRate, frameloop: raw.frameloop, cmp }))
  } finally { await browser.close() }
}

;({ board, time, shot })[MODE]().catch((e) => { console.error(e); process.exit(1) })
