// Same-tick pixel A/B/A2 + paired timing of shader variants at one pose (tides-0oi.2 harness). See README.md.
//
//   VARIANTS=cloudSeaEarlyOut,cloudSkip POSE='{"lat":27.9,"lon":86.9,"km":20,"tilt":60}' node ab.cjs
//
// Env: VARIANTS (names from VARFILE, default variants/top10.cjs), POSE (JSON: lat, lon, km, tilt for a close-zoom
// pose; add "ship": true for ship mode with pitch/heading), PARAMS (JSON URL params, e.g. {"t":"2026-03-20T03:00:00Z"}),
// PHONE (default 1: 390x844 dpr3; 0 = 960x600), SETTLE ms (default 15000; 20000+ at low altitude), K renders per
// burst (8), N rounds (12), SHOT (path for a screenshot of the pose), NOTIME=1 (pixels only).
const path = require('path')
const H = require('./lib.cjs')

const VARFILE = process.env.VARFILE ? path.resolve(process.env.VARFILE) : path.join(__dirname, 'variants/top10.cjs')
const ALL = require(VARFILE)
const NAMES = (process.env.VARIANTS || '').split(',').filter(Boolean)
if (!NAMES.length) { console.error('VARIANTS=a,b required; available:', Object.keys(ALL).join(', ')); process.exit(2) }
for (const n of NAMES) if (!ALL[n]) { console.error('unknown variant', n); process.exit(2) }
const POSE = JSON.parse(process.env.POSE || '{"lat":30,"lon":-100,"km":100}')
const PARAMS = JSON.parse(process.env.PARAMS || '{}')
const K = +(process.env.K || 8), N = +(process.env.N || 12)

;(async () => {
  const { browser, page } = await H.launch({ phone: process.env.PHONE !== '0' })
  try {
    if (POSE.ship) await H.openShip(page, POSE, PARAMS)
    else await H.open(page, { focus: 'earth', ...PARAMS })
    await H.hook(page)
    if (!POSE.ship) await H.poseMain(page, POSE)
    await H.settle(page, +(process.env.SETTLE || 15000))
    await page.evaluate(() => { __H.freeze() })
    await page.waitForTimeout(400)
    await page.evaluate(() => __H.pause())
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
    const specs = NAMES.map((n) => [n, ALL[n].match, ALL[n].pairs.map(([a, b]) => [typeof a === 'string' ? a : { re: a.re, flags: a.flags || '' }, b])])
    const reg = await page.evaluate((specs) => {
      const out = {}
      for (const [name, match, pairs] of specs) {
        const fn = (0, eval)(match)
        const ps = pairs.map(([a, b]) => [typeof a === 'string' ? a : new RegExp(a.re, a.flags), b])
        out[name] = __H.shaderVariant(fn, ps, name)
      }
      window.__abReg = out
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.materials]))
    }, specs)
    const pixels = await page.evaluate((names) => __H.pixels(names), NAMES)
    const hits = await page.evaluate(() => Object.fromEntries(Object.entries(window.__abReg).map(([k, v]) => [k, v.hits()])))
    const info = await page.evaluate(() => ({ dpr: __H.gl.getPixelRatio(), canvas: [__H.gl.domElement.width, __H.gl.domElement.height], calls: __H.frame.length }))
    console.log(JSON.stringify({ pose: POSE, params: PARAMS, ...info, materials: reg, hits }))
    for (const n of NAMES) console.log('pixels', n.padEnd(20), 'A vs A2', JSON.stringify(pixels[n].AA), ' A vs B', JSON.stringify(pixels[n].AB))
    for (const [n, h] of Object.entries(hits)) if (!h) console.log('WARNING: variant', n, 'made 0 replacements: its text no longer matches the shader')
    if (!process.env.NOTIME) {
      const r = await H.withGpuLock(() => page.evaluate(([names, K, N]) => __H.ab(['base', ...names], K, N), [NAMES, K, N]))
      for (const [n, v] of Object.entries(r)) console.log('timing', n.padEnd(20), `gpu ${v.gpuMed} wall ${v.wallMed}  dGpu ${v.dGpu} dWall ${v.dWall} (ms/frame, median of ${N} paired rounds)`)
    }
  } finally {
    await browser.close()
  }
})()
