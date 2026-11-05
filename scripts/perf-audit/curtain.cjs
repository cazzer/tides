// tides-0oi.5's proof: the aurora curtain bake against the live noise at one pose (shape of ab.cjs). See README.md.
//
//   POSE='{"lat":76,"lon":120,"km":400}' OUT=<dir> TAG=P1 node curtain.cjs
//
// Every aurora material's defines are swapped in page (__H.reg), with uTime pinned to T (default 600) so runs and
// pages agree. Variants: live<N> (the march's own noise, N steps; live10 is the old low tier), bake<N> (the table,
// N steps), ref (live, 128 steps), old10 (fragment.frag's text at OLD_SHA, inlined, 10 steps: live10 must match it),
// and with ROWS=r,c: bake<N>@<c>x<r> (an in-page table of c angles x r rows per hemisphere). control hides the
// aurora meshes; bakeOff hides the bake's quad (the replay still counts it otherwise).
// Env (beyond ab.cjs's POSE/PARAMS/SETTLE/K/N/NOTIME/SHOT): OUT dir for PNGs, TAG for their names, BOARD=1 for the
// two composites (before | bake<before steps> | heat, then that | bake<SHIP> | heat; one row if they match), CROP=1 for the 3x strip of the brightest arc,
// PRE=<js file> evaluated after the pause (e.g. a Kp 7 storm), STEPS list for timing (default 10,12,14,16,20),
// ROWS (e.g. 512,512 or 512,1024), BEFORE (the timing's before, default live10).
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const H = require('./lib.cjs')

const POSE = JSON.parse(process.env.POSE || '{"lat":76,"lon":120,"km":400}')
const PARAMS = JSON.parse(process.env.PARAMS || '{}')
const K = +(process.env.K || 6), N = +(process.env.N || 10)
const OUT = process.env.OUT || __dirname
const TAG = process.env.TAG || 'pose'
const T = +(process.env.T || 600)
const STEPS = (process.env.STEPS || '10,12,14,16,20').split(',').map(Number)
const ROWS = process.env.ROWS ? process.env.ROWS.split(',').map(Number) : null
const OLD_SHA = process.env.OLD_SHA || '2b6fa89'
// The timing's "before": live10 is the old low tier, live24 the high one (add 24 to STEPS).
const BEFORE = process.env.BEFORE || 'live10'
// The shipped steps (the board's second row and the crop): 14 on the low tier, 24 on the high.
const SHIP = +(process.env.SHIP || 14)

// The old fragment shader with its includes inlined (vite-plugin-glsl inlines them the same way).
function oldFragment() {
  const root = path.join(__dirname, '../..')
  const show = (p) => execSync(`git -C ${root} show ${OLD_SHA}:${p}`, { encoding: 'utf8' })
  return show('src/shaders/aurora/fragment.frag')
    .replace('#include ./noise3.glsl', show('src/shaders/aurora/noise3.glsl'))
    .replace('#include ../shell/face.glsl', show('src/shaders/shell/face.glsl'))
}

const SETUP = async ([T, STEPS, ROWS, OLD]) => {
  const Tm = __H.T, gl = __H.gl, ctx = __H.ctx
  const isA = (m) => m && m.uniforms && m.uniforms.uOval && m.defines && m.defines.STEPS !== 6
  const mats = new Set(), meshes = []
  for (const o of __H.renderables()) if (isA(o.material)) { mats.add(o.material); meshes.push(o) }
  // The bake: the recorded call whose scene draws the curtain table.
  const bakeIdx = __H.frame.findIndex((c) => c.scene.children[0]?.material?.defines?.CURTAIN_ROWS != null && !c.scene.children[0].material.uniforms.uOval)
  const bakeCall = __H.frame[bakeIdx]
  const bakeMat = bakeCall?.scene.children[0].material
  const bakeCalls = __H.frame.filter((c) => c.scene.children[0]?.material === bakeMat).length
  for (const m of mats) m.uniforms.uTime.value = T
  if (bakeMat) bakeMat.uniforms.uTime.value = T
  const base = [...mats][0]
  const baseDefines = { ...base.defines }
  const baseTex = base.uniforms.uCurtain?.value
  const quad = bakeCall?.scene.children[0]
  // The live variants skip the bake too, so they time as the old shader did.
  const set = (defines, frag, tex) => () => {
    if (!defines.CURTAIN_BAKE && quad) { quad.__m = quad.layers.mask; quad.layers.mask = 0 }
    for (const m of mats) {
      m.__saved = { defines: m.defines, frag: m.fragmentShader }
      m.defines = defines
      if (frag) m.fragmentShader = frag
      m.needsUpdate = true
    }
    if (tex) base.uniforms.uCurtain.value = tex
  }
  const unset = () => {
    if (quad && quad.__m != null) { quad.layers.mask = quad.__m; quad.__m = null }
    for (const m of mats) { m.defines = m.__saved.defines; m.fragmentShader = m.__saved.frag; m.needsUpdate = true }
    if (baseTex) base.uniforms.uCurtain.value = baseTex
  }
  const bakeDefs = (s, w = baseDefines.CURTAIN_WIDTH, r = baseDefines.CURTAIN_ROWS) => ({ STEPS: s, CURTAIN_BAKE: 1, CURTAIN_WIDTH: w, CURTAIN_ROWS: r })
  for (const s of STEPS) {
    __H.reg('live' + s, set({ STEPS: s }), unset)
    __H.reg('bake' + s, set(bakeDefs(s)), unset)
  }
  __H.reg('ref', set({ STEPS: 128 }), unset)
  __H.reg('old10', set({ STEPS: 10 }, OLD), unset)
  if (ROWS) {
    const [r, w] = ROWS
    const rt = new Tm.WebGLRenderTarget(w, 2 * r, { type: Tm.HalfFloatType, format: Tm.RGBAFormat, minFilter: Tm.LinearFilter, magFilter: Tm.LinearFilter,
      generateMipmaps: false, wrapS: Tm.RepeatWrapping, wrapT: Tm.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false })
    const m2 = bakeMat.clone(); m2.defines = { CURTAIN_WIDTH: w, CURTAIN_ROWS: r }; m2.uniforms.uTime.value = T
    const sc = new Tm.Scene(); const q = new Tm.Mesh(bakeCall.scene.children[0].geometry, m2); q.frustumCulled = false; sc.add(q)
    const prev = gl.getRenderTarget(); gl.setRenderTarget(rt); __H.origRender.call(gl, sc, bakeCall.camera); gl.setRenderTarget(prev)
    for (const s of [10, 16]) __H.reg(`bake${s}@${w}x${r}`, set(bakeDefs(s, w, r), null, rt.texture), unset)
  }
  __H.reg('control', () => meshes.forEach((o) => { o.__m = o.layers.mask; o.layers.mask = 0 }), () => meshes.forEach((o) => { o.layers.mask = o.__m }))
  __H.reg('bakeOff', () => { quad.__m = quad.layers.mask; quad.layers.mask = 0 }, () => { quad.layers.mask = quad.__m })

  // --- images
  const W = ctx.drawingBufferWidth, Hh = ctx.drawingBufferHeight
  const shots = (window.__shots = {})
  window.__shot = async (nm) => {
    if (shots[nm]) return shots[nm]
    const v = __H.variants[nm]; v.on(); await new Promise((r) => setTimeout(r, 0))
    __H.replayOnce(); __H.replayOnce()
    gl.setRenderTarget(null); const b = new Uint8Array(W * Hh * 4); ctx.readPixels(0, 0, W, Hh, ctx.RGBA, ctx.UNSIGNED_BYTE, b); v.off()
    return (shots[nm] = b)
  }
  const dmax = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
  window.__cmp = (a, b) => {
    let n = 0, n2 = 0, n8 = 0, n16 = 0, mx = 0
    for (let i = 0; i < a.length; i += 4) { const d = dmax(a, b, i); if (d) n++; if (d > 2) n2++; if (d > 8) n8++; if (d > 16) n16++; if (d > mx) mx = d }
    const pc = (x) => +((100 * x) / (a.length / 4)).toFixed(4)
    return { px: n, pct2: pc(n2), pct8: pc(n8), pct16: pc(n16), max: mx }
  }
  // Against ref, where the aurora shows (ref differs from the aurora hidden by more than 2/255).
  window.__quality = (x, ref, ctrl) => {
    let n = 0, se = 0, n8 = 0; const errs = []
    for (let i = 0; i < x.length; i += 4) {
      if (dmax(ref, ctrl, i) <= 2) continue
      n++
      for (let c = 0; c < 3; c++) se += (x[i + c] - ref[i + c]) ** 2
      const d = dmax(x, ref, i); errs.push(d); if (d > 8) n8++
    }
    errs.sort((a, b) => a - b)
    return { maskPx: n, rmse: n ? +Math.sqrt(se / (3 * n)).toFixed(3) : 0, p99: n ? errs[Math.floor(0.99 * (n - 1))] : 0, over8: n8, over8pct: n ? +((100 * n8) / n).toFixed(3) : 0 }
  }
  // Panels as ImageData, top row first.
  const flip = (b, x0 = 0, y0 = 0, w = W, h = Hh, scale = 1) => {
    const out = new ImageData(w * scale, h * scale)
    for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
      const sx = x0 + Math.floor(x / scale), sy = Hh - 1 - (y0 + Math.floor(y / scale))
      const s = (sy * W + sx) * 4, o = (y * w * scale + x) * 4
      out.data[o] = b[s]; out.data[o + 1] = b[s + 1]; out.data[o + 2] = b[s + 2]; out.data[o + 3] = 255
    }
    return out
  }
  const heat = (a, b) => {
    const out = new ImageData(W, Hh)
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const s = ((Hh - 1 - y) * W + x) * 4, o = (y * W + x) * 4
      const d = dmax(a, b, s)
      const g = 0.3 * (0.3 * a[s] + 0.59 * a[s + 1] + 0.11 * a[s + 2])
      let c = [g, g, g]
      if (d > 16) c = [255, 30, 30]; else if (d > 8) c = [255, 140, 0]; else if (d > 2) c = [255, 230, 0]; else if (d > 0) c = [150, 150, 150]
      out.data[o] = c[0]; out.data[o + 1] = c[1]; out.data[o + 2] = c[2]; out.data[o + 3] = 255
    }
    return out
  }
  const png = async (rows) => {
    const gap = 8
    const w = Math.max(...rows.map((r) => r.reduce((s, p) => s + p.width, 0) + gap * (r.length - 1)))
    const h = rows.reduce((s, r) => s + Math.max(...r.map((p) => p.height)), 0) + gap * (rows.length - 1)
    const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h)
    let y = 0
    for (const r of rows) { let x = 0; for (const p of r) { g.putImageData(p, x, y); x += p.width + gap } y += Math.max(...r.map((p) => p.height)) + gap }
    const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    return btoa(s)
  }
  // before | bake (same steps) | heat, then bake | bake at the shipped steps | heat.
  window.__board = async (before, b10, b16) => png(b10 === b16 ? [[flip(before), flip(b10), heat(before, b10)]] : [[flip(before), flip(b10), heat(before, b10)], [flip(b10), flip(b16), heat(b10, b16)]])
  // 3x crop around the brightest aurora pixel in ref: before | shipped | ref.
  window.__crop = async (before, b16, ref, ctrl) => {
    let best = -1, bi = 0
    for (let i = 0; i < ref.length; i += 4) { const g = ref[i + 1] - ctrl[i + 1]; if (g > best) { best = g; bi = i } }
    const px = (bi / 4) % W, py = Hh - 1 - Math.floor(bi / 4 / W)
    const cw = 200, ch = 140, x0 = Math.min(Math.max(px - cw / 2, 0), W - cw), y0 = Math.min(Math.max(py - ch / 2, 0), Hh - ch)
    return { at: [px, py], png: await png([[flip(before, x0, y0, cw, ch, 3), flip(b16, x0, y0, cw, ch, 3), flip(ref, x0, y0, cw, ch, 3)]]) }
  }
  return {
    mats: mats.size, meshes: meshes.length, baseDefines, bakeIdx, bakeCalls, calls: __H.frame.length,
    glowDefines: (() => { for (const o of __H.renderables()) if (o.material?.uniforms?.uOval && o.material.defines.STEPS === 6) return o.material.defines; return null })(),
    canvas: [W, Hh],
  }
}

;(async () => {
  const { browser, page } = await H.launch({ phone: process.env.PHONE !== '0' })
  const log = (...a) => console.log(TAG, ...a)
  try {
    if (POSE.ship) await H.openShip(page, POSE, PARAMS)
    else await H.open(page, { focus: 'earth', ...PARAMS })
    await H.hook(page)
    if (!POSE.ship) await H.poseMain(page, POSE)
    await H.settle(page, +(process.env.SETTLE || 15000))
    await page.evaluate(() => { __H.freeze() })
    await page.waitForTimeout(400)
    await page.evaluate(() => __H.pause())
    if (process.env.PRE) log('pre', JSON.stringify(await page.evaluate(fs.readFileSync(process.env.PRE, 'utf8'))))
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
    const info = await page.evaluate(SETUP, [T, STEPS, ROWS, oldFragment()])
    log('info', JSON.stringify({ pose: POSE, params: PARAMS, ...info }))
    const r = await page.evaluate(async ([STEPS, ROWS, SHIP]) => {
      const s = window.__shot, c = window.__cmp, q = window.__quality
      const A = await s('base')
      const out = { control: c(A, await s('control')), bakeOff: c(A, await s('bakeOff')) }
      const live10 = await s('live10')
      out.old10_vs_live10 = c(await s('old10'), live10)
      out['base_vs_bake' + SHIP] = c(A, await s('bake' + SHIP))
      out.live10_vs_bake10 = c(live10, await s('bake10'))
      out[`live${SHIP}_vs_bake${SHIP}`] = c(await s('live' + SHIP), await s('bake' + SHIP))
      out['bake10_vs_bake' + SHIP] = c(await s('bake10'), await s('bake' + SHIP))
      if (ROWS) for (const k of Object.keys(__H.variants).filter((k) => k.includes('@'))) out[(k.startsWith('bake10') ? 'live10' : 'live16') + '_vs_' + k] = c(await s(k.startsWith('bake10') ? 'live10' : 'live16'), await s(k))
      const ref = await s('ref'), ctrl = await s('control')
      out.quality = {}
      for (const nm of ['live10', 'bake10', 'live' + SHIP, 'bake' + SHIP, ...(ROWS ? Object.keys(__H.variants).filter((k) => k.includes('@')) : [])]) out.quality[nm] = q(await s(nm), ref, ctrl)
      delete window.__shots.base
      out.AA = c(A, await s('base'))
      return out
    }, [STEPS, ROWS, SHIP])
    log('pixels', JSON.stringify(r))
    fs.mkdirSync(OUT, { recursive: true })
    if (process.env.BOARD) {
      const b1 = 'bake' + BEFORE.slice(4), b2 = 'bake' + SHIP
      const b64 = await page.evaluate(async ([a, b, c]) => window.__board(await window.__shot(a), await window.__shot(b), await window.__shot(c)), [BEFORE, b1, b2])
      const f = path.join(OUT, b1 === b2 ? `${TAG}_before-${b1}-heat.png` : `${TAG}_before-${b1}-heat__${b1}-${b2}-heat.png`)
      fs.writeFileSync(f, Buffer.from(b64, 'base64')); log('board', f)
    }
    if (process.env.CROP) {
      const c = await page.evaluate(async ([a, b]) => window.__crop(await window.__shot(a), await window.__shot(b), await window.__shot('ref'), await window.__shot('control')), [BEFORE, 'bake' + SHIP])
      const f = path.join(OUT, `${TAG}_crop3x_before-bake${SHIP}-ref.png`)
      fs.writeFileSync(f, Buffer.from(c.png, 'base64')); log('crop', f, JSON.stringify(c.at))
    }
    await page.evaluate(() => { window.__shots = null })
    if (!process.env.NOTIME) {
      const names = ['base', ...new Set([BEFORE, 'live10']), ...STEPS.map((s) => 'bake' + s), 'control', 'bakeOff']
      const [t, alone] = await H.withGpuLock(() => page.evaluate(async ([names, K, N]) => {
        const r = await __H.ab(names, K, N)
        // The bake's own call (clear + quad), replayed alone.
        const call = __H.frame.filter((c) => c.scene.children[0]?.material?.defines?.CURTAIN_ROWS != null && !c.scene.children[0].material.uniforms.uOval)
        const a = []
        for (let i = 0; i < 5; i++) a.push(await __H.replay(40, call))
        return [r, { wall: __H.med(a.map((x) => x.wall)), gpu: __H.med(a.map((x) => x.gpu)) }]
      }, [names, K, N]))
      const ctrl = t.control.wallMed
      const before = t[BEFORE].wallMed - ctrl
      for (const [n, v] of Object.entries(t)) log('timing', n.padEnd(10), `gpu ${v.gpuMed} wall ${v.wallMed} dGpu ${v.dGpu} dWall ${v.dWall} aurora ${(v.wallMed - ctrl).toFixed(3)} x${((v.wallMed - ctrl) / before).toFixed(3)}`)
      log('timing', 'bake alone', JSON.stringify({ replayWall: +alone.wall.toFixed(4), replayGpu: alone.gpu == null ? null : +alone.gpu.toFixed(4), baseMinusBakeOffWall: -t.bakeOff.dWall, baseMinusBakeOffGpu: t.bakeOff.dGpu == null ? null : -t.bakeOff.dGpu }))
    }
  } finally {
    await browser.close()
  }
})().catch((e) => { console.error(e); process.exit(1) })
