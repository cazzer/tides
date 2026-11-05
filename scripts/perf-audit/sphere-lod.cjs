// tides-0oi.16's proof: the Earth, Moon and Sun spheres sized to the screen (src/ship/sphere-lod.ts) against
// the top level they drew before, same tick. "before" swaps every body mesh drawing a coarser level back to a
// 128x128 sphere of its radius (its userData.segments carried, and the Sun's shell and bounding sphere), so the
// renderers' own per-draw code (EarthRenderer's displacement level, SunRenderer's uShell) reads it as the top.
//
//   cd scripts/perf-audit
//   BASE_URL=... PLAYWRIGHT_CORE=... GPU_LOCK=... WHO=tides-0oi.16 OUT=<dir> node sphere-lod.cjs
//
// Env: OUT (board PNGs + results.json), POSES (JSON list, else the default set below), NOTIME=1 (pixels only),
// K/N (timing), TIME_POSES (comma list of pose names to time; default system,earth-40,moon-40,sun-40).
// Poses: {name, system:true} the default view; {name, body:'earth'|'moon'|'sun', px, az} the main camera put so the
// body's radius is `px` device px at the main view's centre, `az` degrees round from the body's sunward side
// (90 = half lit); {name, km, lat, lon, tilt} close zoom over Earth (poseMain); reset:true poses aren't measured
// (they put the body back at its top level, so each body's sizes run from large to small).
const fs = require('fs')
const path = require('path')
const H = require('./lib.cjs')

const OUT = process.env.OUT || path.join(process.cwd(), 'sphere-lod-out')
fs.mkdirSync(OUT, { recursive: true })
const K = +(process.env.K || 8), N = +(process.env.N || 10)

const sizes = (body, az) => [
  { name: `${body}-reset`, body, px: 500, az, reset: true },
  ...[140, 125, 80, 40, 36, 30, 20].map((px) => ({ name: `${body}-${px}`, body, px, az })),
]
const DEFAULT_POSES = [
  { name: 'system', system: true },
  ...sizes('earth', 70),
  ...sizes('moon', 70),
  ...sizes('sun', 0),
  // The glint and the terminator: Earth ~40 px, near half lit.
  { name: 'earth-reset2', body: 'earth', px: 500, az: 100, reset: true },
  { name: 'earth-glint-40', body: 'earth', px: 40, az: 100 },
  // Controls, all at the top level: 0 px.
  { name: 'moon-reset2', body: 'moon', px: 500, az: 70, reset: true },
  { name: 'ctl-moon-close', body: 'moon', px: 420, az: 70 },
  { name: 'ctl-earth-100km', km: 100, lat: 30, lon: -100 },
  { name: 'ctl-sheet-20km', km: 20, lat: 30, lon: -100 },
]
const POSES = process.env.POSES ? JSON.parse(process.env.POSES) : DEFAULT_POSES
const TIME_POSES = (process.env.TIME_POSES || 'system,earth-40,moon-40,sun-40').split(',')

// In page: the body meshes, the "top" variant, per-View triangles and the same-tick diff with board images.
const SETUP = () => {
  const T = __H.T
  const L = (window.__L = {})
  L.renderables = () => __H.renderables()
  // The LOD'd bodies by their meshes: Earth's ground (and its glow, sharing the sphere), the Moon (and its
  // occluder), the Sun.
  L.bodyRadii = () => {
    const r = {}
    for (const o of L.allMeshes()) {
      const m = o.material
      const g = o.geometry
      if (m?.uniforms?.uShell) r.sun = { mesh: o, radius: m.uniforms.uRadius.value }
      else if (m?.isMeshPhongMaterial && m.displacementMap && g?.userData?.segments) r.earth = { mesh: o, radius: g.parameters.radius }
      else if (m?.isMeshPhongMaterial && m.map && !m.displacementMap && g?.userData?.segments && g.parameters.radius < 0.5 * (r.earth?.radius ?? Infinity))
        r.moon = r.moon || { mesh: o, radius: g.parameters.radius }
    }
    return r
  }
  L.allMeshes = () => {
    const out = []
    const seen = new Set()
    for (const c of __H.frame) {
      if (seen.has(c.scene)) continue
      seen.add(c.scene)
      c.scene.traverse((o) => o.isMesh && out.push(o))
    }
    return out
  }
  const shellOf = ([w, h]) => {
    const half = 0.5 * Math.hypot((2 * Math.PI) / w, Math.PI / h)
    return (1 + 0.01) / Math.cos(Math.max(half, Math.PI / Math.min(w, h)))
  }
  const tops = new Map()
  const topOf = (g) => {
    const key = g.parameters.radius + (g.userData.sunShell ? ':sun' : '')
    let top = tops.get(key)
    if (!top) {
      top = new T.SphereGeometry(g.parameters.radius, 128, 128)
      top.userData.segments = [128, 128]
      if (g.userData.sunShell) {
        top.userData.sunShell = shellOf([128, 128])
        top.computeBoundingSphere()
        top.boundingSphere.radius *= top.userData.sunShell
      }
      tops.set(key, top)
    }
    return top
  }
  // Meshes drawing a coarser level of an LOD'd body's radius.
  L.coarse = () => {
    const radii = new Set(Object.values(L.bodyRadii()).map((b) => b.radius))
    return L.allMeshes().filter((o) => {
      const s = o.geometry?.userData?.segments
      return s && s[0] < 128 && s[0] === s[1] && radii.has(o.geometry.parameters.radius)
    })
  }
  let swapped = []
  __H.reg(
    'top',
    () => {
      swapped = L.coarse().map((o) => [o, o.geometry])
      for (const [o, g] of swapped) o.geometry = topOf(g)
    },
    () => {
      for (const [o, g] of swapped) o.geometry = g
      swapped = []
    }
  )
  // Each body's level per View (the call drawing its scene).
  L.levels = () => {
    const out = {}
    const bodies = L.bodyRadii()
    __H.frame.forEach((c, i) => {
      if (c.target) return
      c.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry?.userData?.segments) return
        for (const [name, b] of Object.entries(bodies)) {
          if (o.geometry.parameters?.radius !== b.radius) continue
          if (name !== 'sun' && !o.material?.isMeshPhongMaterial) continue
          if (name === 'sun' && !o.material?.uniforms?.uShell) continue
          ;(out[name] = out[name] || []).push(`v${i}:${o.geometry.userData.segments[0]}`)
        }
      })
    })
    return out
  }
  L.views = () => __H.frame.map((c, i) => ({ i, vp: [c.vp.x, c.vp.y, c.vp.z, c.vp.w], target: !!c.target, cam: c.camera.type }))
  // Triangles per recorded call (each View's render), with the variant on.
  L.triangles = async (nm) => {
    const v = __H.variants[nm]
    v.on()
    await new Promise((r) => setTimeout(r, 0))
    const gl = __H.gl
    const out = []
    for (const c of __H.frame) {
      __H.replayOnce([c])
      out.push(gl.info.render.triangles)
    }
    v.off()
    return out
  }
  const w = () => __H.ctx.drawingBufferWidth, h = () => __H.ctx.drawingBufferHeight
  const grab = () => {
    __H.gl.setRenderTarget(null)
    const b = new Uint8Array(w() * h() * 4)
    __H.ctx.readPixels(0, 0, w(), h(), __H.ctx.RGBA, __H.ctx.UNSIGNED_BYTE, b)
    return b
  }
  const shot = async (nm) => {
    const v = __H.variants[nm]
    v.on()
    await new Promise((r) => setTimeout(r, 0))
    __H.replayOnce()
    __H.replayOnce()
    const b = grab()
    v.off()
    return b
  }
  const maxDiff = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
  const stats = (a, b, rect) => {
    const [x0, y0, rw, rh] = rect || [0, 0, w(), h()]
    let n2 = 0, n8 = 0, n16 = 0, n1 = 0, mx = 0, worst = null
    for (let y = y0; y < y0 + rh; y++)
      for (let x = x0; x < x0 + rw; x++) {
        const i = (y * w() + x) * 4
        const d = maxDiff(a, b, i)
        if (d) n1++
        if (d > 2) n2++
        if (d > 8) n8++
        if (d > 16) n16++
        if (d > mx) { mx = d; worst = [x, h() - 1 - y] }
      }
    const all = rw * rh
    const pct = (n) => +((100 * n) / all).toFixed(4)
    return { px: n1, over2: pct(n2), over8: pct(n8), over16: pct(n16), px2: n2, px8: n8, px16: n16, max: mx, worst }
  }
  // Panels before | after | heatmap of [cx, cy, size] (top-down canvas px, or the whole canvas) at `scale`.
  const toB64 = async (canvas) => {
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  }
  const composite = async (before, after, crop, scale) => {
    const [cx, cy, size] = crop || [w() / 2, h() / 2, null]
    const cw = size ? size : w(), ch = size ? size : h()
    const x0 = size ? Math.round(cx - size / 2) : 0, y0 = size ? Math.round(cy - size / 2) : 0
    const panel = new ImageData(cw * 3, ch)
    const px = (img, x, y) => (((h() - 1 - y) * w() + x) * 4)
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const sx = Math.min(w() - 1, Math.max(0, x0 + x)), sy = Math.min(h() - 1, Math.max(0, y0 + y))
        const i = px(null, sx, sy)
        const d = maxDiff(before, after, i)
        for (let p = 0; p < 3; p++) {
          const o = (y * cw * 3 + x + p * cw) * 4
          let r, g, b
          if (p === 0) [r, g, b] = [before[i], before[i + 1], before[i + 2]]
          else if (p === 1) [r, g, b] = [after[i], after[i + 1], after[i + 2]]
          else if (d === 0) [r, g, b] = [before[i] >> 1, before[i + 1] >> 1, before[i + 2] >> 1]
          else if (d <= 2) [r, g, b] = [150, 150, 150]
          else if (d <= 8) [r, g, b] = [255, 230, 0]
          else if (d <= 16) [r, g, b] = [255, 140, 0]
          else [r, g, b] = [255, 0, 0]
          panel.data[o] = r; panel.data[o + 1] = g; panel.data[o + 2] = b; panel.data[o + 3] = 255
        }
      }
    const src = new OffscreenCanvas(cw * 3, ch)
    src.getContext('2d').putImageData(panel, 0, 0)
    const out = new OffscreenCanvas(Math.round(cw * 3 * scale), Math.round(ch * scale))
    const g2 = out.getContext('2d')
    g2.imageSmoothingEnabled = false
    g2.drawImage(src, 0, 0, out.width, out.height)
    // Labels.
    g2.fillStyle = 'rgba(0,0,0,0.6)'
    const font = Math.max(10, Math.min(28, Math.round(out.width / 3 / 12)))
    g2.font = `${font}px sans-serif`
    ;['before (128)', 'after (sized)', 'heatmap'].forEach((t, k) => {
      g2.fillRect((k * out.width) / 3 + 4, 4, g2.measureText(t).width + 10, font * 1.5)
      g2.fillStyle = '#fff'
      g2.fillText(t, (k * out.width) / 3 + 9, font * 1.15)
      g2.fillStyle = 'rgba(0,0,0,0.6)'
    })
    return toB64(out)
  }
  // The pose's measurement: A (after) / B (before: top) / A2 on the whole canvas and the main view, and images.
  L.measure = async ({ crop, cropScale = 2, full = false, mainVp }) => {
    const A = await shot('base'), B = await shot('top'), A2 = await shot('base')
    const res = { AA: stats(A, A2), AB: stats(A, B), ABmain: mainVp ? stats(A, B, mainVp) : null }
    if (res.AB.px > 0 || full) {
      res.img = await composite(B, A, crop, cropScale)
      if (full) res.full = await composite(B, A, null, 1)
      if (res.AB.worst) {
        const [x, y] = res.AB.worst
        res.worstImg = await composite(B, A, [x, y, 96], 3)
      }
    }
    return res
  }
}

// Main camera put so `body`'s radius is `px` device px at the main view's centre, `az` degrees from sunward.
async function poseBody(page, pose) {
  await page.evaluate((pose) => {
    const T = __H.T
    const d = Math.PI / 180
    window.__mainPose = (camera) => {
      const bodies = __L.bodyRadii()
      const b = bodies[pose.body]
      const sun = bodies.sun
      if (!b || !sun) return
      b.mesh.updateWorldMatrix(true, false)
      sun.mesh.updateWorldMatrix(true, false)
      const c = new T.Vector3().setFromMatrixPosition(b.mesh.matrixWorld)
      const R = b.radius * b.mesh.matrixWorld.getMaxScaleOnAxis()
      const s = new T.Vector3().setFromMatrixPosition(sun.mesh.matrixWorld)
      const toSun = pose.body === 'sun' ? new T.Vector3(0, 0, 1) : s.clone().sub(c).normalize()
      const side = new T.Vector3(0, 1, 0).cross(toSun).normalize()
      const dir = toSun.clone().applyAxisAngle(new T.Vector3().crossVectors(toSun, side).normalize(), pose.az * d)
      const vpH = window.__mainVpH || 1688
      const pxPerRad = vpH / 2 / Math.tan((camera.fov / 2) * d)
      const dist = R / Math.sin(pose.px / pxPerRad)
      camera.position.copy(c).addScaledVector(dir, dist)
      camera.up.set(0, 1, 0)
      camera.lookAt(c)
      camera.updateMatrixWorld()
      window.__mainCam = camera
    }
  }, pose)
}

;(async () => {
  const { browser, page } = await H.launch({ phone: process.env.PHONE !== '0' })
  const results = []
  try {
    await H.open(page, JSON.parse(process.env.PARAMS || '{}'))
    await H.hook(page)
    await page.evaluate(SETUP)
    await H.settle(page, +(process.env.SETTLE || 12000))
    await page.evaluate(() => __H.freeze())
    for (const pose of POSES) {
      await page.evaluate(() => __H.resume())
      if (pose.system) await page.evaluate(() => { window.__mainPose = null })
      else if (pose.body) await poseBody(page, pose)
      else await H.poseMain(page, pose)
      await page.waitForTimeout(pose.reset ? 1500 : +(process.env.POSE_SETTLE || (pose.km ? 9000 : 3500)))
      // The main view's viewport: the canvas call drawn by the posed camera, else the tallest.
      await page.evaluate(() => {
        const calls = __H.frame.filter((c) => !c.target)
        const main = calls.find((c) => c.camera === window.__mainCam) || calls.sort((a, b) => b.vp.w - a.vp.w)[0]
        // Recorded viewports are in CSS px.
        const pr = __H.gl.getPixelRatio()
        window.__mainVpH = main.vp.w * pr
        window.__mainVp = [main.vp.x, main.vp.y, main.vp.z, main.vp.w].map((v) => Math.round(v * pr))
      })
      if (pose.reset) continue
      await page.evaluate(() => __H.pause())
      await page.waitForTimeout(200)
      const info = await page.evaluate(() => ({ levels: __L.levels(), views: __L.views(), coarse: __L.coarse().length, mainVp: window.__mainVp }))
      const [vx, vy, vw, vh] = info.mainVp
      const canvasH = await page.evaluate(() => __H.ctx.drawingBufferHeight)
      const centre = [vx + vw / 2, canvasH - (vy + vh / 2)]
      const crop = pose.body ? [...centre, Math.max(200, Math.min(vw, Math.round(pose.px * 5)))] : null
      const m = await page.evaluate((o) => __L.measure(o), { crop, cropScale: pose.body ? 2 : 1, full: !!pose.system, mainVp: info.mainVp })
      const triBefore = await page.evaluate(() => __L.triangles('top'))
      const triAfter = await page.evaluate(() => __L.triangles('base'))
      const row = { pose: pose.name, ...info, AA: m.AA, AB: m.AB, ABmain: m.ABmain, triBefore, triAfter }
      for (const [k, b64] of [['img', m.img], ['full', m.full], ['worstImg', m.worstImg]]) {
        if (!b64) continue
        const file = path.join(OUT, `${pose.name}${k === 'img' ? '' : '-' + k}.png`)
        fs.writeFileSync(file, Buffer.from(b64, 'base64'))
        row[k] = file
      }
      if (!process.env.NOTIME && TIME_POSES.includes(pose.name)) {
        row.timing = await H.withGpuLock(() => page.evaluate(([K, N]) => __H.ab(['base', 'top'], K, N), [K, N]))
      }
      const sum = (xs) => xs.reduce((a, b) => a + b, 0)
      console.log(
        pose.name.padEnd(18),
        JSON.stringify(info.levels),
        'AA', m.AA.px,
        'AB', JSON.stringify({ px: m.AB.px, over2: m.AB.over2, over8: m.AB.over8, over16: m.AB.over16, max: m.AB.max }),
        'main', m.ABmain && JSON.stringify({ px: m.ABmain.px, max: m.ABmain.max }),
        'tri', sum(triBefore), '->', sum(triAfter),
        row.timing ? `timing top gpu ${row.timing.top.gpuMed} base gpu ${row.timing.base.gpuMed} dGpu(after-before) ${-row.timing.top.dGpu} dWall ${-row.timing.top.dWall}` : ''
      )
      results.push(row)
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1))
    await browser.close()
  }
})()
