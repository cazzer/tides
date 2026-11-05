// tides-0oi.18's proof: the low tier's side panels at the panel rate (src/panel-rate.ts, src/renderers/HeldPanel.tsx),
// on the phone viewport (390x844, quality=low) with the pixel ratio pinned (?dprctl=fixed:2) and ?panelhz= set so the
// page exposes window.__panelRate (setPaced switches drei's own draw and the paced one in the same page).
//   MODE=pixels  frames stepped by hand (frameloop 'never', the root's advance) at a frozen tick:
//                unpaced (drei) vs the paced draw frame vs the held frames after it, then again after a dpr change,
//                plus a control (the sim moved on: held panels keep the old frame, a fresh draw differs).
//   MODE=time    paired blocks of real rAF frames, pacing on vs off, each frame timed before-effect -> after-effect
//                (cpu) and to a 1 px readPixels after it (sync: the GPU's part too), split into the paced arm's draw
//                frames (a panel drew) and held frames (both filled from their copies). Under the GPU lock.
//                Frame replay (lib.cjs __H.replay) can't show held frames: it replays one recorded frame.
//   MODE=board   12-frame strips of the two panels (frames stepped at 60 Hz) at speed 1 and x86400, paced under
//                auto vs every frame vs a forced 15 Hz, as PNGs in OUT (default ./panel-rate-board).
// Env: lib.cjs's BASE_URL / PLAYWRIGHT_CORE / GPU_LOCK / WHO, DPR (2), BLOCK_MS (2000), PAIRS (8), OUT.
//
//   cd scripts/perf-audit && MODE=pixels node panel-rate.cjs
const fs = require('fs')
const path = require('path')
const H = require('./lib.cjs')

const MODE = process.env.MODE || 'pixels'
const DPR = process.env.DPR || '2'
const OUT = process.env.OUT || path.join(__dirname, 'panel-rate-board')

// In page: panel rects in canvas pixels, frame stepping and region diffs.
const SETUP = () => {
  const { gl, ctx } = __H
  const canvas = gl.domElement
  window.__rects = () => {
    const c = canvas.getBoundingClientRect(), dpr = gl.getPixelRatio()
    return [...document.querySelectorAll('.panel')].filter((p) => p.dataset.area !== 'main').map((p) => {
      const r = p.getBoundingClientRect()
      const v = new __H.T.Vector4()
      gl.setViewport(r.left - c.left, c.top + c.height - r.bottom, r.width, r.height)
      gl.getCurrentViewport(v)
      return { area: p.dataset.area, x: v.x, y: v.y, w: v.z, h: v.w, dpr }
    })
  }
  window.__read = (r) => { gl.setRenderTarget(null); const b = new Uint8Array(r.w * r.h * 4); ctx.readPixels(r.x, r.y, r.w, r.h, ctx.RGBA, ctx.UNSIGNED_BYTE, b); return b }
  window.__readAll = () => window.__read({ x: 0, y: 0, w: ctx.drawingBufferWidth, h: ctx.drawingBufferHeight })
  window.__cmp = (a, b) => { if (a.length !== b.length) return { px: -1 }; let n = 0, mx = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])); if (d) { n++; if (d > mx) mx = d } } return { px: n, max: mx } }
  window.__lit = (a) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2]) n++; return n }
  let t = 1000
  // dt 0 (pixels) holds R3F's clock too, so the frames are one tick; the strips step at 60 Hz.
  window.__dt = 1 / 60
  window.__step = (dt = window.__dt) => { t += dt; window.__panelRate.draws = 0; window.__panelRate.held = 0; __H.root().advance(t, true); return { draws: window.__panelRate.draws, held: window.__panelRate.held } }
  // A re-render of the Canvas would set frameloop back to 'always': pause again after each switch.
  window.__commit = () => new Promise((r) => setTimeout(() => { __H.pause(); r() }, 120))
}

async function openPage(params = {}) {
  const { browser, page } = await H.launch({ phone: true })
  await H.open(page, { dprctl: `fixed:${DPR}`, panelhz: 'auto', ...params })
  await H.hook(page)
  await H.settle(page, 3000)
  await page.evaluate(SETUP)
  return { browser, page }
}

async function pixels() {
  const { browser, page } = await openPage()
  try {
    await page.evaluate(() => { __H.freeze(); __H.pause(); window.__dt = 0 })
    const r = await page.evaluate(async () => {
      const set = async (on) => { __panelRate.setPaced(on); await __commit() }
      const regions = () => __rects()
      const grab = () => ({ all: __readAll(), panels: regions().map(__read) })
      const cmpP = (a, b) => a.panels.map((p, i) => __cmp(p, b.panels[i]))
      const out = { rects: regions() }
      const pass = async (label) => {
        await set(false); __step(); const A = grab(); const sA = __step(); const A1 = grab()
        await set(true)
        const sB = __step(); const B = grab()
        const held = []
        for (let i = 0; i < 3; i++) { const s = __step(); held.push({ steps: s, vsB: cmpP(B, grab()), whole: __cmp(B.all, grab().all) }) }
        await set(false); __step(); const A2 = grab()
        out[label] = {
          lit: A.panels.map(__lit), unpacedSteps: sA, pacedDrawSteps: sB,
          AvsA1: __cmp(A.all, A1.all), AvsA2: __cmp(A.all, A2.all),
          unpacedVsPacedDraw: cmpP(A, B), unpacedVsPacedDrawWhole: __cmp(A.all, B.all), held,
        }
      }
      await pass('dpr' + __H.gl.getPixelRatio())
      // A dpr change while paced: the panels must redraw at once (forced), not show a stale copy.
      await set(true); __step(); __step()
      __H.root().setDpr(1.5); await __commit()
      const s = __step(); const P = grab()
      await set(false); __step(); const U = grab()
      out.afterDprChange = { dpr: __H.gl.getPixelRatio(), steps: s, rects: regions(), pacedVsUnpaced: cmpP(U, P), whole: __cmp(U.all, P.all) }
      await pass('dpr1.5')
      // Control: the sim moves on while held, so the held panels keep the old frame and a fresh draw differs.
      await set(true); __step(); const before = grab(); __step()
      const st = __H.store.getState()
      __H.store.setState({ timestamp: st.timestamp + 6 * 3600e3 })
      const sh = __step(); const heldNew = grab()
      await set(false); __step(); const fresh = grab()
      out.control = { heldSteps: sh, heldVsBefore: cmpP(before, heldNew), heldVsFresh: cmpP(heldNew, fresh) }
      return out
    })
    console.log(JSON.stringify(r, null, 1))
  } finally { await browser.close() }
}

async function time() {
  const { browser, page } = await openPage({ speed: '1' })
  try {
    await page.evaluate(() => {
      const { ctx } = __H
      const fx = window.__ppHandles?.addEffect ? window.__ppHandles : __H.fiber
      const px = new Uint8Array(4)
      window.__log = null
      let t0 = 0
      fx.addEffect(() => { t0 = performance.now(); __panelRate.draws = 0; __panelRate.held = 0 })
      fx.addAfterEffect(() => {
        if (!window.__log) return
        const t1 = performance.now()
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px)
        window.__log.push([t1 - t0, performance.now() - t0, __panelRate.draws, __panelRate.held])
      })
      window.__block = (on, ms) => new Promise((res) => {
        __panelRate.setPaced(on)
        setTimeout(() => { window.__log = []; setTimeout(() => { const l = window.__log; window.__log = null; res(l) }, ms) }, 300)
      })
    })
    const BLOCK = +(process.env.BLOCK_MS || 2000), PAIRS = +(process.env.PAIRS || 8)
    const blocks = await H.withGpuLock(() => page.evaluate(async ({ BLOCK, PAIRS }) => {
      const out = []
      for (let i = 0; i < PAIRS; i++) for (const on of i % 2 ? [true, false] : [false, true]) out.push({ on, log: await __block(on, BLOCK) })
      __panelRate.setPaced(true)
      return out
    }, { BLOCK, PAIRS }))
    const med = (a) => { if (!a.length) return null; a = a.slice().sort((x, y) => x - y); return +a[a.length >> 1].toFixed(3) }
    const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null)
    const pick = (on, f) => blocks.filter((b) => b.on === on).flatMap((b) => b.log.filter(f))
    const off = pick(false, () => true), on = pick(true, () => true)
    const draw = pick(true, (l) => l[2] > 0), held = pick(true, (l) => l[2] === 0)
    const row = (name, l) => ({ name, n: l.length, cpuMed: med(l.map((x) => x[0])), cpuMean: mean(l.map((x) => x[0])), syncMed: med(l.map((x) => x[1])), syncMean: mean(l.map((x) => x[1])) })
    // Paired per-block mean differences (on - off), the noise-robust number.
    const pairs = []
    for (let i = 0; i < blocks.length; i += 2) {
      const [a, b] = blocks[i].on ? [blocks[i], blocks[i + 1]] : [blocks[i + 1], blocks[i]]
      pairs.push({ dCpu: mean(a.log.map((x) => x[0])) - mean(b.log.map((x) => x[0])), dSync: mean(a.log.map((x) => x[1])) - mean(b.log.map((x) => x[1])) })
    }
    console.log(JSON.stringify({
      dpr: DPR, rows: [row('off (drei every frame)', off), row('on (all)', on), row('on: draw frames', draw), row('on: held frames', held)],
      drawShare: +(draw.length / on.length).toFixed(3), panelDrawsPerFrame: +(on.reduce((s, x) => s + x[2], 0) / on.length).toFixed(3),
      paired: { dCpuMed: med(pairs.map((p) => p.dCpu)), dSyncMed: med(pairs.map((p) => p.dSync)), pairs: pairs.map((p) => [+p.dCpu.toFixed(3), +p.dSync.toFixed(3)]) },
    }, null, 1))
  } finally { await browser.close() }
}

// One strip: N frames stepped at 60 Hz, each the two panels side by side, with the px changed since the last frame.
async function strip(page, { speed, paced, label, file, n = 12, scale = 0.5 }) {
  const res = await page.evaluate(async ({ speed, paced, n, scale, label }) => {
    __panelRate.setPaced(paced); await __commit()
    __H.store.getState().setTimeScale(speed)
    for (let i = 0; i < 6; i++) __step()
    const rects = __rects()
    const fw = rects.reduce((s, r) => s + r.w, 0) + 4, fh = Math.max(...rects.map((r) => r.h))
    const cw = Math.round(fw * scale), ch = Math.round(fh * scale)
    const cols = 6, rows = Math.ceil(n / cols), pad = 6, head = 30, cap = 18
    const out = new OffscreenCanvas(cols * (cw + pad) + pad, head + rows * (ch + cap + pad) + pad)
    const g = out.getContext('2d')
    g.fillStyle = '#111'; g.fillRect(0, 0, out.width, out.height)
    g.fillStyle = '#eee'; g.font = '15px sans-serif'; g.fillText(label, pad, 20)
    const frame = new OffscreenCanvas(fw, fh), fg = frame.getContext('2d')
    let prev = null
    const changed = [], drew = []
    for (let i = 0; i < n; i++) {
      const s = __step()
      drew.push(s.draws)
      const bufs = rects.map(__read)
      let x = 0
      fg.fillStyle = '#000'; fg.fillRect(0, 0, fw, fh)
      bufs.forEach((b, k) => {
        const r = rects[k], img = new ImageData(r.w, r.h)
        for (let y = 0; y < r.h; y++) img.data.set(b.subarray((r.h - 1 - y) * r.w * 4, (r.h - y) * r.w * 4), y * r.w * 4)
        fg.putImageData(img, x, fh - r.h); x += r.w + 4
      })
      const diff = prev ? bufs.map((b, k) => __cmp(prev[k], b).px) : null
      changed.push(diff)
      prev = bufs
      const cx = pad + (i % cols) * (cw + pad), cy = head + Math.floor(i / cols) * (ch + cap + pad)
      g.drawImage(frame, cx, cy, cw, ch)
      g.fillStyle = diff && diff.every((d) => d === 0) ? '#f6a' : '#9cf'; g.font = '12px sans-serif'
      g.fillText(`${i + 1}: ${diff ? diff.map((d) => (d ? d + ' px' : 'same')).join(' | ') : 'first'}`, cx, cy + ch + 13)
    }
    const blob = await out.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { png: btoa(bin), changed, drew }
  }, { speed, paced, n, scale, label })
  fs.writeFileSync(file, Buffer.from(res.png, 'base64'))
  return { file, drew: res.drew, changed: res.changed }
}

async function board() {
  fs.mkdirSync(OUT, { recursive: true })
  const runs = [
    { panelhz: 'auto', speed: 1, paced: false, label: 'speed 1, every frame (today)', name: '1-speed1-60hz' },
    { panelhz: 'auto', speed: 1, paced: true, label: 'speed 1, paced (auto: 15 Hz)', name: '2-speed1-15hz' },
    { panelhz: 'auto', speed: 86400, paced: true, label: 'x86400, auto (full rate when fast: as today)', name: '3-day-auto' },
    { panelhz: '15', speed: 86400, paced: true, label: 'x86400, forced 15 Hz (why auto goes to full rate)', name: '4-day-forced15' },
  ]
  for (const r of runs) {
    const { browser, page } = await openPage({ panelhz: r.panelhz })
    try {
      await page.evaluate(() => { __H.pause() })
      const s = await strip(page, { speed: r.speed, paced: r.paced, label: r.label, file: path.join(OUT, r.name + '.png') })
      console.log(JSON.stringify({ name: r.name, ...s }))
    } finally { await browser.close() }
  }
}

;({ pixels, time, board })[MODE]().catch((e) => { console.error(e); process.exit(1) })
