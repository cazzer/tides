// tides-0oi.13: the low tier's paced pixel ratio (src/paced-dpr.ts) end to end, on the phone viewport with vsync on
// (390x844, native dpr 3, quality=low, system view). Three phases, each under the GPU lock, as the controller reads
// frame intervals that other streams' GPU work would disturb:
//   a) raise:    the system view reaches the display's 3 (it starts there since tides-0oi.38).
//   c) negative: CDP CPU throttling (x30) makes frames miss on the main thread; the ratio must not drop (one CPU
//                probe a level down, restored as 'cpu' when the CPU time doesn't fall, is expected).
//   b) drop:     a fill-heavy full-screen quad is added to the main view, sized
//                so the frame misses vsync at dpr 2 (alpha ~1e-5, so it blends to the same pixels); the ratio should fall to 1.5-1.75, then climb back to 3 once the
//                quad is removed.
// Prints window.__dprctl.changes per phase and the longest rAF interval within 500 ms after each change (the resize
// hitch). Env: DPRCTL (the ?dprctl= value, default empty: the defaults), QUAD_DPR2_VSYNCS (the quad's cost at dpr 2 in vsyncs, 1.3),
// THROTTLE (30: x6 doesn't make an M4's frames miss), plus lib.cjs's BASE_URL / PLAYWRIGHT_CORE / GPU_LOCK / WHO.
//
//   cd scripts/perf-audit && node dprctl.cjs
const H = require('./lib.cjs')

const DPRCTL = process.env.DPRCTL || ''
const QUAD_VSYNCS = +(process.env.QUAD_DPR2_VSYNCS || 1.3)
const THROTTLE = +(process.env.THROTTLE || 30)

// In page: a rAF interval log and the quad.
const SETUP = () => {
  const log = (window.__rafLog = [])
  let last = null
  const step = (t) => { if (last != null) log.push([t, t - last]); last = t; requestAnimationFrame(step) }
  requestAnimationFrame(step)
  window.__dprAt = () => ({ dpr: __H.gl.getPixelRatio(), state: { dpr: __dprctl.state.dpr, kind: __dprctl.state.kind, dwellMs: __dprctl.state.dwellMs, cpuEwma: +__dprctl.state.cpuEwma.toFixed(2) } })
  // The longest interval ending within 500 ms after each change, and the p99 of the 2 s before it.
  window.__hitches = (since) => __dprctl.changes.filter((c) => c.at >= since).map((c) => {
    const after = log.filter(([t]) => t > c.at && t <= c.at + 500).map(([, d]) => d)
    const before = log.filter(([t]) => t > c.at - 2000 && t <= c.at).map(([, d]) => d).sort((a, b) => a - b)
    return { at: Math.round(c.at), from: c.from, to: c.to, reason: c.reason, bounced: c.bounced, n: c.n, p50: c.p50 && +c.p50.toFixed(1), p95: c.p95 && +c.p95.toFixed(1), misses: c.misses, vsync: c.vsyncMs && +c.vsyncMs.toFixed(2), dwell: c.dwellMs, maxAfterMs: after.length ? +Math.max(...after).toFixed(1) : null, p99BeforeMs: before.length ? +before[Math.floor(before.length * 0.99)].toFixed(1) : null }
  })
  window.__waitFor = (pred, ms) => new Promise((res) => { const end = performance.now() + ms; const tick = () => { if (pred() || performance.now() > end) res(pred()); else setTimeout(tick, 200) }; tick() })
  window.__stable = (ms, maxMs) => new Promise((res) => {
    // Resolves once the ratio hasn't changed for ms (or after maxMs).
    const end = performance.now() + maxMs
    const tick = () => { const lastAt = __dprctl.changes.length ? __dprctl.changes[__dprctl.changes.length - 1].at : 0; if (performance.now() - lastAt > ms || performance.now() > end) res(__dprAt()); else setTimeout(tick, 250) }
    tick()
  })
  const T = __H.T
  const main = __H.frame.filter((c) => !c.target).sort((a, b) => b.vp.z * b.vp.w - a.vp.z * a.vp.w)[0]
  const material = new T.ShaderMaterial({
    uniforms: { uIter: { value: 0 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform float uIter;
      void main() {
        vec3 c = vec3(gl_FragCoord.xy * 1e-3, 0.5);
        for (int i = 0; i < 16384; i++) { if (float(i) >= uIter) break; c = fract(c.yzx * 1.013 + sin(c * 7.1) * 0.31); }
        // Alpha ~1e-5, not 0: blends to the same 8-bit pixel, but a constant 0 lets the Metal compiler see the
        // output is dead under the blend and drop the loop.
        gl_FragColor = vec4(c, c.x * 1e-5);
      }`,
    transparent: true, depthTest: false, depthWrite: false,
  })
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  quad.renderOrder = 1e6
  window.__quad = { quad, material, scene: main.scene }
}

async function phase(page, name, fn) {
  const t0 = await page.evaluate(() => performance.now())
  const out = await H.withGpuLock(fn)
  const changes = await page.evaluate((t0) => __hitches(t0), t0)
  console.log(`phase ${name}`, JSON.stringify(out))
  for (const c of changes) console.log(`  change ${JSON.stringify(c)}`)
  return changes
}

;(async () => {
  const { browser, page } = await H.launch({ phone: true })
  try {
    await H.open(page, { dprctl: DPRCTL }, { waitMs: 9000 })
    const info = await H.hook(page)
    await page.evaluate(SETUP)
    console.log('start', JSON.stringify({ dprctl: DPRCTL, canvas: info.canvas, gpuTimer: info.gpuTimer, ...(await page.evaluate(() => __dprAt())) }))
    // The settle before this let the opening move finish; the window starts from the state the page reached.

    await phase(page, 'a-raise', () => page.evaluate(async () => {
      const t0 = performance.now()
      const ok = await __waitFor(() => __dprctl.state.dpr >= 3, 60000)
      return { reached3: ok, ms: Math.round(performance.now() - t0), ...__dprAt() }
    }))

    const cdp = await page.context().newCDPSession(page)
    await phase(page, 'c-cpu-throttle', async () => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
      const r = await page.evaluate(async () => {
        const n0 = __rafLog.length
        await new Promise((r) => setTimeout(r, 15000))
        const ds = __rafLog.slice(n0).map(([, d]) => d).sort((a, b) => a - b)
        const s = __dprctl.state
        return { frames: ds.length, p50: +ds[ds.length >> 1].toFixed(1), p95: +ds[Math.floor(ds.length * 0.95)].toFixed(1), windowCpuBound: s.count - s.kept, window: s.count, ...__dprAt() }
      })
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      return r
    })

    // Calibrate the quad: its GPU cost per iteration at the current ratio, from a replay of the paused frame.
    const cal = await H.withGpuLock(() => page.evaluate(async (vsyncs) => {
      const { quad, material, scene } = __quad
      const dpr = __H.gl.getPixelRatio()
      __H.pause()
      const cost = async (iter) => { material.uniforms.uIter.value = iter; __H.replayOnce(); const r = await __H.replay(4); return r.gpu ?? r.wall }
      scene.add(quad)
      const base = await cost(0)
      const with256 = await cost(256)
      scene.remove(quad)
      __H.resume()
      const perIter = (with256 - base) / 256
      // Fill-bound: cost goes as dpr^2; aim for `vsyncs` vsyncs of quad alone at dpr 2.
      const target = vsyncs * (1000 / __dprctl.config.targetHz)
      const iter = Math.min(16384, Math.round(target / (perIter * (2 / dpr) ** 2)))
      material.uniforms.uIter.value = iter
      return { dpr, baseMs: +base.toFixed(3), quad256Ms: +(with256 - base).toFixed(3), iter, predictedMsAt: Object.fromEntries([3, 2, 1.75, 1.5].map((d) => [d, +(perIter * iter * (d / dpr) ** 2).toFixed(1)])) }
    }, QUAD_VSYNCS))
    console.log('quad', JSON.stringify(cal))

    await phase(page, 'b1-drop', () => page.evaluate(async () => {
      __quad.scene.add(__quad.quad)
      const t0 = performance.now()
      await __waitFor(() => __dprctl.changes.some((c) => c.at > t0), 20000)
      const r = await __stable(8000, 90000)
      return { ms: Math.round(performance.now() - t0), ...r }
    }))
    await phase(page, 'b2-climb-back', () => page.evaluate(async () => {
      __quad.scene.remove(__quad.quad)
      const t0 = performance.now()
      const ok = await __waitFor(() => __dprctl.state.dpr >= 3, 150000)
      return { reached3: ok, ms: Math.round(performance.now() - t0), ...__dprAt() }
    }))
  } finally {
    await browser.close()
  }
})().catch((e) => { console.error(e); process.exit(1) })
