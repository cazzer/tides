// tides-0oi.15: same-tick pixel A/B/A2 and paired wall timing of the REAL glow pass (src/renderers/glow/glow-pass.ts
// createGlowPass) around the recorded View draws, flipping its glowPassSwitches. Frame replay (__H.replay/ab) is
// invalid on glow frames (glow-pass-only.js), so this draws a fresh pass instance on the main View's scene and camera.
//
//   VARS=noScissor,glowOff PARAMS='{"quality":"high"}' NOTIME=1 node glow-ab.cjs                 # glow-2 exact?
//   VARS=noScissor,noInvalidate,half,glowOff PARAMS='{"quality":"low","glow":"1"}' node glow-ab.cjs  # timing
//
// Variants (B against base = every switch on):
//   noScissor      glowPassSwitches.scissor off (glow-2)
//   noInvalidate   glowPassSwitches.invalidateDepth off (glow-6)
//   half           glowPassSwitches.compactTargets off: RGBA16F targets (glow-4; not exact, board)
//   panelStandinsOff  the side panels' glow stand-ins hidden (tides-64u.6, on a build that still makes them)
//   glowOff        control: the main View's sources emptied for the frame, so no glow
// Env: POSE (JSON for poseMain; omit for the default system view), PARAMS (URL params JSON), VIEW ("phone" 390x844
// dpr3 | "desk" 1512x860 dpr2), VARS, NOTIME=1 (pixels only), K, N, SETTLE, SHOT (png of the pose), PASSONLY=1 (time
// prepare+composite without the View draws), BOARD=<dir> (before|after|heatmap composite and a 3x crop per variant,
// before = the variant), TAG (label and file prefix).
const fs = require('fs')
const path = require('path')
const H = require('./lib.cjs')
const GLOW_JS = fs.readFileSync(path.join(__dirname, 'glow-pass-only.js'), 'utf8')

const POSE = process.env.POSE ? JSON.parse(process.env.POSE) : null
const PARAMS = JSON.parse(process.env.PARAMS || '{}')
const VIEW = process.env.VIEW || 'phone'
const VARS = (process.env.VARS || 'noScissor,glowOff').split(',').filter(Boolean)
const K = +(process.env.K || 8), N = +(process.env.N || 12)
const TAG = process.env.TAG || 'x'

;(async () => {
  const launchOpts = VIEW === 'desk' ? { width: 1512, height: 860, dpr: 2 } : { phone: true }
  const { browser, page } = await H.launch(launchOpts)
  try {
    await H.open(page, { ...(POSE ? { focus: 'earth' } : {}), ...PARAMS })
    await H.hook(page)
    if (POSE) await H.poseMain(page, POSE)
    await H.settle(page, +(process.env.SETTLE || 15000))
    await page.evaluate(() => { __H.freeze() })
    await page.waitForTimeout(400)
    await page.evaluate(() => __H.pause())
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
    await page.evaluate(`(${GLOW_JS})()`)
    const info = await page.evaluate(async (vars) => {
      const H = window.__H, G = window.__G, gl = H.gl, ctx = H.ctx
      const names = performance.getEntriesByType('resource').map((e) => e.name)
      const url = names.find((n) => /\/src\/renderers\/glow\/glow-pass\.ts/.test(n))
      const mod = await import(url)
      const S = mod.glowPassSwitches
      const defaults = { ...S }
      const pass = mod.createGlowPass()
      // The main View: the largest canvas (not render-target) scene draw.
      const mc = G.viewCalls().filter((c) => !c.target).reduce((a, b) => (b.vp.z * b.vp.w > a.vp.z * a.vp.w ? b : a))
      const mv = { scene: mc.scene, camera: mc.camera }
      const vp = { left: mc.vp.x, bottom: mc.vp.y, width: mc.vp.z, height: mc.vp.w }
      const cssH = gl.domElement.height / gl.getPixelRatio(), cssW = gl.domElement.width / gl.getPixelRatio()
      const canvasBox = { left: 0, top: 0, width: cssW, height: cssH }
      const track = { getBoundingClientRect: () => ({ left: vp.left, top: cssH - (vp.bottom + vp.height), width: vp.width, height: vp.height }) }
      const list = G.glowSources.glowSourcesOf(mv.scene)
      let saved = null
      const V = {
        base: { on() {}, off() {} },
        noScissor: { on() { S.scissor = false }, off() { S.scissor = defaults.scissor } },
        noInvalidate: { on() { S.invalidateDepth = false }, off() { S.invalidateDepth = defaults.invalidateDepth } },
        half: { on() { S.compactTargets = false }, off() { S.compactTargets = defaults.compactTargets } },
        // The side panels' glow stand-ins hidden (tides-64u.6 on the old build).
        panelStandinsOff: {
          on() { for (const c of G.viewCalls()) if (!c.target && c.scene !== mv.scene) c.scene.traverse((o) => { if (o.layers.mask === 1 << 30 && o.visible) { o.visible = false; o.__hid = true } }) },
          off() { for (const c of G.viewCalls()) c.scene.traverse((o) => { if (o.__hid) { o.visible = true; delete o.__hid } }) },
        },
        // Control: no glow at all (the main View's sources emptied for the frame).
        glowOff: { on() { saved = list.splice(0, list.length) }, off() { list.push(...saved); saved = null } },
      }
      const draw = () => {
        H.recording = false
        pass.prepare(gl, mv.scene, mv.camera, track, canvasBox)
        if (!window.__passOnly) for (const c of G.viewCalls()) {
          gl.setRenderTarget(c.target)
          if (!c.target) { gl.setViewport(c.vp); gl.setScissor(c.sc); gl.setScissorTest(c.scissorTest) }
          const ac = gl.autoClear; gl.autoClear = c.autoClear; H.origRender.call(gl, c.scene, c.camera); gl.autoClear = ac
        }
        pass.composite(gl)
        gl.setRenderTarget(null)
        H.recording = true
      }
      const frameOf = (nm) => () => { V[nm].on(); draw(); V[nm].off() }
      window.__T = { V, draw, frameOf, pass, S, defaults }
      for (let e = ctx.getError(), i = 0; e && i < 50; e = ctx.getError(), i++);
      // warm both programs/targets
      for (const nm of ['base', ...vars]) { frameOf(nm)(); frameOf(nm)() }
      frameOf('base')(); const sc = new H.T.Vector4(); gl.getScissor(sc)
      H.sync()
      const errs = []; for (let e = ctx.getError(); e; e = ctx.getError()) errs.push(e)
      const layer30 = G.viewCalls().filter((c) => !c.target).map((c) => { let n = 0, mats = new Set(), geos = new Set(); c.scene.traverse((o) => { if (o.layers.mask === 1 << 30) { n++; if (o.material) mats.add(o.material); if (o.geometry) geos.add(o.geometry) } }); return { main: c.scene === mv.scene, vp: [c.vp.x, c.vp.y, c.vp.z, c.vp.w], standins: n, materials: mats.size, geometries: geos.size, sources: G.glowSources.glowSourcesOf(c.scene).length } })
      return { layer30, programs: gl.info.programs?.length, mem: { ...gl.info.memory }, vp, scissor: [sc.x, sc.y, sc.z, sc.w], scissorFrac: +((sc.z * sc.w) / (vp.width * vp.height)).toFixed(3), canvas: [gl.domElement.width, gl.domElement.height], ratio: gl.getPixelRatio(), sources: list.length, emitting: list.filter((s) => s.emits).length, switches: defaults, errs,
        ext: { cbf: !!ctx.getExtension('EXT_color_buffer_float'), fb: !!ctx.getExtension('EXT_float_blend') }, renderer: ctx.getParameter(ctx.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? ctx.RENDERER) }
    }, VARS)
    console.log(JSON.stringify({ tag: TAG, pose: POSE || 'system', params: PARAMS, view: VIEW, ...info }))

    // Pixels: A (base) B (variant) A2 (base), whole canvas, same tick.
    const px = await page.evaluate(async ([vars, board]) => {
      const H = window.__H, gl = H.gl, ctx = H.ctx, T = window.__T
      const w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight
      const grab = (nm) => { T.frameOf(nm)(); T.frameOf(nm)(); gl.setRenderTarget(null); const b = new Uint8Array(w * h * 4); ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, b); return b }
      const cmp = (a, b) => {
        let n = 0, n2 = 0, n8 = 0, n16 = 0, mx = 0
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
          if (d) { n++; if (d > 2) n2++; if (d > 8) n8++; if (d > 16) n16++; if (d > mx) mx = d }
        }
        const pct = (x) => +((100 * x) / (w * h)).toFixed(3)
        return { px: n, pct: pct(n), pctOver2: pct(n2), pctOver8: pct(n8), pctOver16: pct(n16), max: mx }
      }
      const toPng = async (rgba, W, Hh) => {
        const c = new OffscreenCanvas(W, Hh), g = c.getContext('2d'), im = g.createImageData(W, Hh)
        im.data.set(rgba); g.putImageData(im, 0, 0)
        const blob = await c.convertToBlob({ type: 'image/png' })
        const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
        return btoa(s)
      }
      // GL rows are bottom-up: flip into a top-down RGBA image.
      const flip = (b) => { const o = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) o.set(b.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o }
      const heat = (a, b) => {
        const o = new Uint8ClampedArray(a.length)
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
          let c = [a[i] * 0.5, a[i + 1] * 0.5, a[i + 2] * 0.5]
          if (d >= 1 && d <= 2) c = [150, 150, 150]
          else if (d >= 3 && d <= 8) c = [255, 230, 0]
          else if (d >= 9 && d <= 16) c = [255, 140, 0]
          else if (d > 16) c = [255, 0, 0]
          o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2]; o[i + 3] = 255
        }
        return o
      }
      const side = (imgs, W, Hh, gap = 8) => {
        const CW = W * imgs.length + gap * (imgs.length - 1), o = new Uint8ClampedArray(CW * Hh * 4)
        for (let k = 0; k < imgs.length; k++) for (let y = 0; y < Hh; y++) o.set(imgs[k].subarray(y * W * 4, (y + 1) * W * 4), (y * CW + k * (W + gap)) * 4)
        return { o, CW }
      }
      const crop = (img, x0, y0, cw, ch, s) => {
        const o = new Uint8ClampedArray(cw * s * ch * s * 4)
        for (let y = 0; y < ch * s; y++) for (let x = 0; x < cw * s; x++) {
          const si = ((y0 + Math.floor(y / s)) * w + x0 + Math.floor(x / s)) * 4, di = (y * cw * s + x) * 4
          o[di] = img[si]; o[di + 1] = img[si + 1]; o[di + 2] = img[si + 2]; o[di + 3] = 255
        }
        return o
      }
      const out = {}
      for (const nm of vars) {
        const A = grab('base'), B = grab(nm), A2 = grab('base')
        out[nm] = { AA: cmp(A, A2), AB: cmp(A, B) }
        if (board) {
          // before = the variant (old behaviour), after = base (new): for 'half', B is RGBA16F.
          const before = flip(B), after = flip(A), hm = heat(before, after)
          const { o, CW } = side([before, after, hm], w, h)
          out[nm].png = await toPng(o, CW, h)
          // crop: the 64 px cell with most >2 diffs, a 3x crop of 160x160 around it
          const cs = 64, gx = Math.ceil(w / cs), gy = Math.ceil(h / cs), cnt = new Array(gx * gy).fill(0)
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const d = Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2])); if (d > 2) cnt[Math.floor(y / cs) * gx + Math.floor(x / cs)]++ }
          let best = 0; for (let k = 1; k < cnt.length; k++) if (cnt[k] > cnt[best]) best = k
          const cw = 160, cx = Math.min(w - cw, Math.max(0, (best % gx) * cs + cs / 2 - cw / 2)), cy = Math.min(h - cw, Math.max(0, Math.floor(best / gx) * cs + cs / 2 - cw / 2))
          const s = 3, c3 = side([crop(before, cx, cy, cw, cw, s), crop(after, cx, cy, cw, cw, s), crop(hm, cx, cy, cw, cw, s)], cw * s, cw * s)
          out[nm].crop = await toPng(c3.o, c3.CW, cw * s)
          out[nm].cropAt = { x: cx, y: cy, size: cw, scale: s, cellDiffs: cnt[best] }
        }
      }
      return out
    }, [VARS, !!process.env.BOARD])
    for (const nm of VARS) {
      const r = px[nm]
      if (process.env.BOARD) {
        fs.mkdirSync(process.env.BOARD, { recursive: true })
        const f = path.join(process.env.BOARD, `${TAG}-${nm}.png`), fc = path.join(process.env.BOARD, `${TAG}-${nm}-crop.png`)
        fs.writeFileSync(f, Buffer.from(r.png, 'base64')); fs.writeFileSync(fc, Buffer.from(r.crop, 'base64'))
        console.log('board', f, fc, JSON.stringify(r.cropAt))
      }
      console.log('pixels', TAG, nm.padEnd(12), 'A vs A2', JSON.stringify(r.AA), ' A vs B', JSON.stringify(r.AB))
    }
    if (process.env.PASSONLY) await page.evaluate(() => { window.__PASSONLY = true })
    if (!process.env.NOTIME) {
      const r = await H.withGpuLock(() => page.evaluate(([vars, K, N]) => {
        window.__passOnly = !!window.__PASSONLY
        const T = window.__T, fns = { base: T.frameOf('base') }
        for (const nm of vars) fns[nm] = T.frameOf(nm)
        return window.__G.ab(fns, K, N)
      }, [VARS, K, N]))
      await page.evaluate(() => { window.__passOnly = false })
      for (const [n, v] of Object.entries(r)) console.log('timing', TAG, n.padEnd(12), JSON.stringify(v))
    }
  } finally {
    await browser.close()
  }
})()
