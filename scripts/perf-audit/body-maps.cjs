// Ship-mode body maps on approach (tides-0oi.7): resident texture memory, same-tick pixel A/B of the mip-tail proxies
// against their full maps, and approach runs that log when a body's full map is swapped in. See README.md.
//
//   MODE=vram     POSES=sea,earth node body-maps.cjs            # V.live (resident bytes) + three's texture count
//   MODE=pixels   POSES=sea,earth node body-maps.cjs            # fullMaps (B) vs proxies (A), proxyBlack control
//   MODE=approach TARGET=mars PHONE=0 node body-maps.cjs        # paused A/Bs at RADII px, then a live approach
//   MODE=entry | MODE=exit | MODE=reentry [PLANETS_BETWEEN=0]    # ship entry, exit and re-entry (see each below)
//   MODE=system                                                 # tides-0oi.14: planets-on load time, all 26 maps resident
//   MODE=board IMAGES='mars:50+mars:500;jupiter:326*' OUT=dir     # tides-0oi.14: JPEG | KTX2 | heat composites, system view
//   MASK=astc,bptc,s3tc (ETC2 path) | MASK=all (the JPEGs)       # hides compressed-texture extensions before load
//
// Env: POSES (names below, or a JSON pose for H.openShip), SETTLE ms (15000), TARGET (a planet or moon key),
// RADII (comma list, default 1,4,7,7.9), FROM/TO px and SECONDS for the live approach (2 -> 20 over 8 s),
// PHONE (default 1), PARAMS (JSON URL params), SHOT (png prefix), TIME=1 (pixels mode: paired timing, K, N). Only the live approach's frame times take the GPU lock.
const H = require('./lib.cjs')

const POSES = {
  // Low tier's ship floor is ~450 km: 600 km over the Pacific, nose east, a little below the horizon.
  sea: { lat: 20, lon: -150, km: 600, heading: 0, pitch: -8 },
  // 20 000 km out, looking straight down at Earth.
  earth: { lat: 20, lon: -150, km: 20000, heading: 0, pitch: -90 },
  // 20 000 km out facing Earth, with a planet (and its moons) `off` degrees up from the view's centre, ~6 degrees
  // above the limb, so the pixel control has bodies on screen.
  earthJupiter: { lat: 20, lon: -150, km: 20000, earthFacing: 'jupiter', off: 20 },
}
const PARAMS = JSON.parse(process.env.PARAMS || '{}')
const SETTLE = +(process.env.SETTLE || 15000)
const EXT = { astc: ['WEBGL_compressed_texture_astc'], bptc: ['EXT_texture_compression_bptc'], etc: ['WEBGL_compressed_texture_etc'],
  etc1: ['WEBGL_compressed_texture_etc1'], s3tc: ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'], pvrtc: ['WEBGL_compressed_texture_pvrtc'] }
const MASK = (process.env.MASK || '').split(',').filter(Boolean).flatMap((k) => (k === 'all' ? Object.values(EXT).flat() : EXT[k]))
async function launch(opts) {
  const r = await H.launch(opts)
  if (MASK.length) await r.page.addInitScript((hidden) => {
    const P = WebGL2RenderingContext.prototype, ge = P.getExtension, gs = P.getSupportedExtensions
    P.getExtension = function (n) { return hidden.includes(n) ? null : ge.call(this, n) }
    P.getSupportedExtensions = function () { return gs.call(this).filter((n) => !hidden.includes(n)) }
  }, MASK)
  return r
}
const pose = (name) => (POSES[name] ? { name, ...POSES[name] } : { name: 'custom', ...JSON.parse(name) })

// In page: the bodies whose surface material samples uMap, and the fullMaps / proxyBlack variants.
const BODIES = () => {
  const H = window.__H, T = H.T, gl = H.gl, V = window.__vram
  const B = (window.__B = {})
  const fullOf = (tex) => tex?.userData?.fullMap
  const nameOf = (mesh, tex) => {
    if (mesh.userData.focus) return mesh.userData.focus
    const t = fullOf(tex) ?? tex, img = t?.image
    const src = t?.name || img?.src || img?.currentSrc || ''
    const m = src.match(/\/([a-z]+)-[12]k\.(jpg|png|ktx2)/)
    return m ? m[1] : '?'
  }
  B.meshes = () => {
    const out = [], seen = new Set()
    for (const c of H.frame) c.scene.traverse((o) => {
      const u = o.isMesh && o.material?.uniforms?.uMap
      if (!u || !u.value || seen.has(o) || !o.material.uniforms.uDetailStyle) return
      seen.add(o)
      out.push(o)
    })
    return out
  }
  B.nameOf = (m) => nameOf(m, m.material.uniforms.uMap.value)
  // Every globe material's mesh, textured or not yet (a moon whose uMap is still null).
  B.meshesAll = () => {
    const out = [], seen = new Set()
    for (const c of H.frame) c.scene.traverse((o) => {
      if (o.isMesh && o.material?.uniforms?.uMap && o.material.uniforms.uDetailStyle && !seen.has(o)) { seen.add(o); out.push(o) }
    })
    return out
  }
  B.camera = () => H.frame.find((c) => !c.target && c.camera.isPerspectiveCamera)?.camera ?? H.frame[0].camera
  const _p = new T.Vector3(), _s = new T.Vector3()
  B.radiusPx = (mesh, camera = B.camera()) => {
    mesh.getWorldPosition(_p); mesh.getWorldScale(_s)
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
    const R = mesh.geometry.boundingSphere.radius * _s.x
    const d = camera.position.distanceTo(_p)
    const ppr = gl.domElement.height / 2 / Math.tan((camera.fov / 2) * Math.PI / 180)
    return Math.asin(Math.min(1, R / d)) * ppr
  }
  B.liveOf = (tex) => { const w = tex && gl.properties.get(tex).__webglTexture; return w ? V.liveOf(w) : 0 }
  B.list = () => {
    const cam = B.camera()
    cam.updateMatrixWorld()
    const fr = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
    return B.meshes().map((m) => {
      const tex = m.material.uniforms.uMap.value
      const full = fullOf(tex)
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere()
      const sphere = m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld)
      return {
        body: nameOf(m, tex), tier: full ? 'proxy' : 'full', w: tex.image?.width, h: tex.image?.height, fmt: tex.isCompressedTexture ? '0x' + tex.format.toString(16) : 'rgba',
        rPx: +B.radiusPx(m, cam).toFixed(2), onScreen: m.visible && fr.intersectsSphere(sphere),
        liveMB: +(B.liveOf(tex) / 1048576).toFixed(2), fullLiveMB: full ? +(B.liveOf(full) / 1048576).toFixed(2) : null,
      }
    })
  }
  // B: every proxy-bound material samples its full map instead (A, the base, is the proxies as shipped).
  const swapped = new Map()
  H.reg('fullMaps', () => {
    for (const m of B.meshes()) { const u = m.material.uniforms.uMap, f = fullOf(u.value); if (f) { swapped.set(u, u.value); u.value = f } }
  }, () => {
    // Back off the GPU as the app left them, so a later approach still uploads its map at the switch.
    for (const [u, v] of swapped) { u.value.dispose(); u.value = v }
    swapped.clear()
  })
  const black = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  black.needsUpdate = true
  const blacked = new Map()
  H.reg('proxyBlack', () => {
    for (const m of B.meshes()) { const u = m.material.uniforms.uMap; if (fullOf(u.value)) { blacked.set(u, u.value); u.value = black } }
  }, () => { for (const [u, v] of blacked) u.value = v; blacked.clear() })
  B.vram = () => ({ ...H.vram(), textures: gl.info.memory.textures })
  // tides-0oi.14: each compressed full map's JPEG, loaded and uploaded (B.loadJpegs), and the variant binding them.
  B.jpegs = new Map()
  B.loadJpegs = async () => {
    const loader = new T.TextureLoader()
    await Promise.all(B.meshes().map(async (m) => {
      const map = m.material.uniforms.uMap.value
      if (!map?.isCompressedTexture || fullOf(map) || B.jpegs.has(map)) return
      const url = map.name.replace('/assets/bodies/', '/assets/').replace(/\.ktx2$/, '.jpg')
      const t = await loader.loadAsync(url)
      t.colorSpace = map.colorSpace; t.anisotropy = map.anisotropy; t.wrapS = map.wrapS; t.wrapT = map.wrapT
      gl.initTexture(t)
      B.jpegs.set(map, t)
    }))
    return B.jpegs.size
  }
  const jpegd = new Map()
  H.reg('jpegMaps', () => {
    for (const m of B.meshes()) { const u = m.material.uniforms.uMap, j = B.jpegs.get(u.value); if (j) { jpegd.set(u, u.value); u.value = j } }
  }, () => { for (const [u, v] of jpegd) u.value = v; jpegd.clear() })
  // System view: the main camera sunward of `target`, which shows `r` px in radius (window.__boardAt = { target, r }).
  window.__mainPose = (camera) => {
    const at = window.__boardAt
    const mesh = at && B.meshesAll().find((x) => B.nameOf(x) === at.target)
    if (!mesh) return
    const c = new T.Vector3(), sc = new T.Vector3()
    mesh.getWorldPosition(c); mesh.getWorldScale(sc)
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
    const R = mesh.geometry.boundingSphere.radius * sc.x
    const ppr = B.viewOf(camera).h / 2 / Math.tan((camera.fov / 2) * Math.PI / 180)
    const d = R / Math.sin(at.r / ppr)
    const dir = c.clone().negate().normalize(), side = new T.Vector3(0, 1, 0).cross(dir).normalize()
    dir.addScaledVector(side, at.side ?? 0.35).addScaledVector(new T.Vector3(0, 1, 0), at.up ?? 0.15).normalize()
    camera.position.copy(c).addScaledVector(dir, d)
    camera.up.set(0, 1, 0)
    camera.lookAt(c)
    camera.near = Math.max(1e-6, (d - R) * 0.1)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }
  // The camera's View in canvas px, bottom-up (the main view is a part of the phone layout's canvas).
  B.viewOf = (camera) => {
    const call = H.frame.find((c) => c.camera === camera && !c.target), k = gl.getPixelRatio()
    return call ? { x: call.vp.x * k, y: call.vp.y * k, w: call.vp.z * k, h: call.vp.w * k } : { x: 0, y: 0, w: gl.domElement.width, h: gl.domElement.height }
  }
  B.centrePx = (target) => {
    const mesh = B.meshesAll().find((x) => B.nameOf(x) === target)
    const cam = B.camera(), c = new T.Vector3(), v = B.viewOf(cam)
    mesh.getWorldPosition(c); c.project(cam)
    const R = (() => { const s = new T.Vector3(); mesh.getWorldScale(s); return mesh.geometry.boundingSphere.radius * s.x })()
    const r = Math.asin(Math.min(1, R / cam.position.distanceTo(mesh.getWorldPosition(new T.Vector3())))) * v.h / 2 / Math.tan((cam.fov / 2) * Math.PI / 180)
    return [Math.round(v.x + (c.x * 0.5 + 0.5) * v.w), Math.round(v.y + (c.y * 0.5 + 0.5) * v.h), +r.toFixed(1)]
  }
  // Board panels (canvas buffers are bottom row first).
  const W = gl.domElement.width, Hh = gl.domElement.height
  const dmax = (a, b, i) => Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
  const panel = (b, x0, y0, w, h, scale, f) => {
    const out = new ImageData(w * scale, h * scale)
    for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
      const s = ((y0 + h - 1 - Math.floor(y / scale)) * W + x0 + Math.floor(x / scale)) * 4, o = (y * w * scale + x) * 4
      const c = f(s)
      out.data[o] = c[0]; out.data[o + 1] = c[1]; out.data[o + 2] = c[2]; out.data[o + 3] = 255
    }
    return out
  }
  const img = (b) => (s) => [b[s], b[s + 1], b[s + 2]]
  const heat = (a, b) => (s) => {
    const d = dmax(a, b, s)
    if (d > 16) return [255, 30, 30]
    if (d > 8) return [255, 140, 0]
    if (d > 2) return [255, 230, 0]
    if (d > 0) return [150, 150, 150]
    return [a[s] * 0.5, a[s + 1] * 0.5, a[s + 2] * 0.5]
  }
  B.grab = () => { gl.setRenderTarget(null); const b = new Uint8Array(W * Hh * 4); const c = gl.getContext(); c.readPixels(0, 0, W, Hh, c.RGBA, c.UNSIGNED_BYTE, b); return b }
  B.shot = async (nm) => { const v = H.variants[nm]; v.on(); await new Promise((r) => setTimeout(r, 0)); H.replayOnce(); H.replayOnce(); const b = B.grab(); v.off(); return b }
  B.stats = (a, b, x0 = 0, y0 = 0, w = W, h = Hh) => {
    const o = { px: 0, gt2: 0, gt4: 0, gt8: 0, gt16: 0, max: 0, of: w * h }
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const d = dmax(a, b, (y * W + x) * 4)
      if (d) o.px++
      if (d > 2) o.gt2++
      if (d > 4) o.gt4++
      if (d > 8) o.gt8++
      if (d > 16) o.gt16++
      if (d > o.max) o.max = d
    }
    return o
  }
  B.png = async (rows) => {
    const gap = 8
    const w = Math.max(...rows.map((r) => r.reduce((s, p) => s + p.width, 0) + gap * (r.length - 1)))
    const h = rows.reduce((s, r) => s + Math.max(...r.map((p) => p.height)), 0) + gap * (rows.length - 1)
    const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h)
    let y = 0
    for (const r of rows) { let x = 0; for (const p of r) { g.putImageData(p, x, y); x += p.width + gap } y += Math.max(...r.map((p) => p.height)) + gap }
    const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let str = ''; for (let i = 0; i < buf.length; i += 0x8000) str += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    return btoa(str)
  }
  // One row for `target`: before (B, the JPEG) | after (A, shipped) | heat, cropped around it; A vs A2 too.
  // With `crop`, a 3x strip around the largest difference instead.
  B.row = async (target, extent, crop) => {
    const [cx, cy, r] = B.centrePx(target)
    const A = await B.shot('base'), J = await B.shot('jpegMaps'), A2 = await B.shot('base')
    const side = Math.min(W, Hh, Math.max(160, Math.round(2 * r * extent)))
    let x0 = Math.min(Math.max(cx - (side >> 1), 0), W - side), y0 = Math.min(Math.max(cy - (side >> 1), 0), Hh - side), w = side, h = side, scale = 1
    const stats = B.stats(J, A, x0, y0, w, h)
    if (crop) {
      let best = -1, bx = cx, by = cy
      for (let y = y0; y < y0 + h; y += 2) for (let x = x0; x < x0 + w; x += 2) {
        let sum = 0
        for (let j = -6; j <= 6; j += 3) for (let i = -6; i <= 6; i += 3) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < W && yy < Hh) sum += dmax(J, A, (yy * W + xx) * 4) }
        if (sum > best) { best = sum; bx = x; by = y }
      }
      w = h = 110; scale = 3
      x0 = Math.min(Math.max(bx - 55, 0), W - w); y0 = Math.min(Math.max(by - 55, 0), Hh - h)
    }
    return { target, r, AA: B.stats(A, A2), AB: stats, crop: [x0, y0, w, h], panels: [panel(J, x0, y0, w, h, scale, img(J)), panel(A, x0, y0, w, h, scale, img(A)), panel(J, x0, y0, w, h, scale, heat(J, A))] }
  }
  return true
}

async function openAt(p, { phone }) {
  const { browser, page } = await launch({ phone })
  await H.openShip(page, p, PARAMS)
  await H.hook(page)
  await page.evaluate(BODIES)
  if (p.earthFacing) await faceEarth(page, p)
  return { browser, page }
}

// Holds the ship km above Earth looking at its centre, turned so that body p.earthFacing shows p.off degrees up.
async function faceEarth(page, p) {
  await page.evaluate((p) => {
    const T = window.__H.T, d = Math.PI / 180
    window.__shipPose = (state, earth) => {
      const body = window.__ship?.bodies?.find((b) => b.key === p.earthFacing)
      if (!body || !earth) return
      const w = body.position.clone().sub(earth.position).normalize()
      const n = new T.Vector3(0, 1, 0).cross(w).normalize()
      const fwd = w.clone().multiplyScalar(Math.cos(p.off * d)).addScaledVector(n, Math.sin(p.off * d))
      state.position.copy(earth.position).addScaledVector(fwd, -(earth.radius + (p.km * earth.radius) / 6371))
      state.velocity.set(0, 0, 0); state.angularVelocity.set(0, 0, 0)
      const up = w.clone().addScaledVector(fwd, -w.dot(fwd)).normalize()
      const right = fwd.clone().cross(up).normalize()
      state.orientation.setFromRotationMatrix(new T.Matrix4().makeBasis(right, up, fwd.clone().negate()))
    }
  }, p)
}

const summary = (list) => {
  const n = (f) => list.filter(f).length
  return { proxy: n((b) => b.tier === 'proxy'), full: n((b) => b.tier === 'full'), onScreen: list.filter((b) => b.onScreen).map((b) => `${b.body}:${b.tier}:${b.rPx}`) }
}

async function vramOrPixels(mode, phone) {
  for (const name of (process.env.POSES || 'sea,earth').split(',')) {
    const p = pose(name)
    const { browser, page } = await openAt(p, { phone })
    try {
      await H.settle(page, SETTLE)
      await page.evaluate(() => { __H.freeze() })
      await page.waitForTimeout(400)
      await page.evaluate(() => __H.pause())
      if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${p.name}.png` })
      const list = await page.evaluate(() => __B.list())
      const out = { pose: p, ...summary(list) }
      if (mode === 'vram') {
        out.vram = await page.evaluate(() => __B.vram())
        if (process.env.LIST) out.bodies = list
      } else {
        out.pixels = await page.evaluate(() => __H.pixels(['fullMaps', 'proxyBlack']))
        // TIME=1: paired frame cost of the proxies (base) against the full maps.
        if (process.env.TIME) {
          const K = +(process.env.K || 8), N = +(process.env.N || 12)
          out.timing = await H.withGpuLock(() => page.evaluate(([K, N]) => __H.ab(['base', 'fullMaps'], K, N), [K, N]))
        }
      }
      console.log(JSON.stringify(out))
    } finally {
      await browser.close()
    }
  }
}

// Holds the ship sunward of TARGET looking at it, at a distance that shows it `r` px in radius (window.__approachPx).
async function holdAt(page, target) {
  await page.evaluate((target) => {
    const T = window.__H.T
    window.__shipPose = (state) => {
      const body = window.__ship?.bodies?.find((b) => b.key === target)
      const r = window.__approachPx
      if (!body || r == null) return
      const cam = window.__B.camera()
      const ppr = window.__H.gl.domElement.height / 2 / Math.tan((cam.fov / 2) * Math.PI / 180)
      const d = body.radius / Math.sin(r / ppr)
      // Sunward (the Sun is at the origin) and a little off, so the disk is lit and not dead centre.
      const dir = body.position.clone().negate().normalize()
      const side = new T.Vector3(0, 1, 0).cross(dir).normalize()
      dir.addScaledVector(side, 0.25).normalize()
      state.position.copy(body.position).addScaledVector(dir, d)
      state.velocity.set(0, 0, 0); state.angularVelocity.set(0, 0, 0)
      const fwd = dir.clone().negate()
      const up = new T.Vector3(0, 1, 0).addScaledVector(fwd, -fwd.y).normalize()
      const right = fwd.clone().cross(up).normalize()
      state.orientation.setFromRotationMatrix(new T.Matrix4().makeBasis(right, up, fwd.clone().negate()))
    }
  }, target)
}


// Entering, leaving and re-entering ship mode through the store (as ship-session.ts's patches do), with the system
// view's planets on (`planets`), and a per-frame log of what the bodies bind.
const enterShip = (page) => page.evaluate(() => {
  const s = __H.store.getState()
  __H.store.setState({ shipMode: true, shipSaved: { cameraFocus: s.cameraFocus, timeScale: s.timeScale, showPlanets: s.showPlanets }, showPlanets: true, timeScale: 1, jumpDate: null })
})
const exitShip = (page, planets) => page.evaluate((planets) => {
  const s = __H.store.getState()
  __H.store.setState({ shipMode: false, shipSaved: null, ...s.shipSaved, showPlanets: planets })
}, planets)
// n frames of { dt, live, moons bound to nothing, proxies, fulls, and `watch`'s tier and radius }.
const record = (page, n, watch) => page.evaluate(([n, watch]) => new Promise((resolve) => {
  const rows = []
  let last = performance.now(), mesh = null
  const step = (now) => {
    const ms = __B.meshesAll()
    const moons = ms.filter((m) => m.userData.focus)
    if (watch && !mesh) mesh = __B.meshes().find((m) => __B.nameOf(m) === watch) || null
    const row = { dt: +(now - last).toFixed(1), live: window.__vram.live, moonsBare: moons.filter((m) => !m.material.uniforms.uMap.value).length,
      moons: moons.length, ship: !!__H.store.getState().shipMode, views: __H.frame.length, proxies: ms.filter((m) => m.material.uniforms.uMap.value?.userData?.fullMap).length, bodies: ms.length }
    if (mesh) {
      const tex = mesh.material.uniforms.uMap.value
      row.watch = tex?.userData?.fullMap ? 'proxy' : tex?.image?.src || tex?.isCompressedTexture ? 'full' : 'other'
      row.r = +__B.radiusPx(mesh).toFixed(2)
      const cam = __B.camera(), T = __H.T
      cam.updateMatrixWorld()
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
      row.on = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
        .intersectsSphere(mesh.geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld))
      // Not yet placed by its orbit: drawn at the Sun's spot, not where it is.
      row.placed = new T.Vector3().setFromMatrixPosition(mesh.matrixWorld).lengthSq() > 0
    }
    rows.push(row)
    last = now
    if (rows.length < n) requestAnimationFrame(step)
    else resolve(rows)
  }
  requestAnimationFrame(step)
}), [n, watch])
const MB = (b) => +(b / 1048576).toFixed(2)
const steps = (rows) => rows.flatMap((row, i) => (i > 0 && row.live !== rows[i - 1].live ? [[i, MB(row.live - rows[i - 1].live)]] : []))

// (a) Entry from the system view (planets on): no moon bound to nothing in the first frames, then a same-tick A/B
// ~10 frames in, facing Earth with Jupiter and its moons in view.
async function entry(phone) {
  const { browser, page } = await launch({ phone })
  try {
    await H.open(page, { planets: '1' }, { waitMs: 16000 })
    await H.hook(page)
    await page.evaluate(BODIES)
    await faceEarth(page, POSES.earthJupiter)
    const live0 = await page.evaluate(() => window.__vram.live)
    const rows = await H.withGpuLock(async () => {
      const pending = record(page, +(process.env.FRAMES || 10), null)
      await enterShip(page)
      return pending
    })
    await page.evaluate(() => __H.pause())
    const list = await page.evaluate(() => __B.list())
    const pixels = await page.evaluate(() => __H.pixels(['fullMaps', 'proxyBlack']))
    await page.evaluate(() => __H.resume())
    const more = await record(page, 60, null)
    const all = rows.concat(more)
    // The ship's frames: one View (the system view has three, and draws until the ship View mounts).
    const drawn = all.filter((r) => r.moons > 0 && r.ship && r.views <= 2)
    console.log(JSON.stringify({ mode: 'entry', phone, framesWithMoons: drawn.length, firstMoonFrame: all.findIndex((r) => r.moons > 0 && r.ship && r.views <= 2), viewsByFrame: all.slice(0, 12).map((r) => `${r.ship ? 's' : 'x'}${r.views}:${r.moons}/${r.moonsBare}`),
      maxMoonsBare: Math.max(...drawn.map((r) => r.moonsBare)), bareFrames: drawn.filter((r) => r.moonsBare > 0).length,
      atAB: { frame: rows.length, ...summary(list) }, pixels,
      first10: { dts: rows.slice(1, 11).map((r) => r.dt), max: Math.max(...rows.slice(1, 11).map((r) => r.dt)), sum: +rows.slice(1, 11).reduce((a, r) => a + r.dt, 0).toFixed(1) },
      liveMB: { before: MB(live0), after10: MB(rows[rows.length - 1].live), after70: MB(all[all.length - 1].live), peak: MB(Math.max(...all.map((r) => r.live))) } }))
  } finally {
    await browser.close()
  }
}

// (b) Leaving a flight that retired the maps for the system view with planets on: frame times and the maps'
// return, one upload a frame.
async function exit(phone) {
  const { browser, page } = await openAt(POSES.sea, { phone })
  try {
    await H.settle(page, SETTLE)
    const before = await page.evaluate(() => ({ live: window.__vram.live, ...((l) => ({ proxy: l.filter((b) => b.tier === 'proxy').length }))(__B.list()) }))
    const rows = await H.withGpuLock(async () => {
      const pending = record(page, +(process.env.FRAMES || 180), null)
      await exitShip(page, true)
      return pending
    })
    const dts = rows.slice(1).map((r) => r.dt)
    const st = steps(rows)
    const after = await page.evaluate(() => ({ proxies: __B.meshesAll().filter((m) => m.material.uniforms.uMap.value?.userData?.fullMap).length, bodies: __B.meshesAll().length }))
    console.log(JSON.stringify({ mode: 'exit', phone, before: { liveMB: MB(before.live), proxy: before.proxy },
      maxDt: Math.max(...dts), over50: dts.filter((d) => d > 50).length, over33: dts.filter((d) => d > 33.4).length,
      top5: [...dts].sort((a, b) => b - a).slice(0, 5), over33At: dts.flatMap((d, i) => (d > 33.4 ? [`${i + 1}:${d}`] : [])),
      firstRestore: st.length ? st[0][0] : null, liveSteps: st, maxStepMB: Math.max(0, ...st.map(([, m]) => m)),
      framesWithProxies: rows.filter((r) => r.proxies > 0).length, after, liveAfterMB: MB(rows[rows.length - 1].live) }))
  } finally {
    await browser.close()
  }
}

// (c) Re-entry held near Jupiter (RPX px, default 20): Jupiter binds its full map from its first placed frame.
// PLANETS_BETWEEN=0 leaves the system view's planets off between flights, so Jupiter is still retired at re-entry.
async function reentry(phone) {
  const between = process.env.PLANETS_BETWEEN !== '0'
  const { browser, page } = await openAt(POSES.sea, { phone })
  try {
    await H.settle(page, SETTLE)
    // Jupiter's full map, from its proxy in this first flight.
    await page.evaluate(() => {
      const m = __B.meshesAll().find((x) => __B.nameOf(x) === 'jupiter')
      window.__jupiterMap = m.material.uniforms.uMap.value.userData.fullMap ?? m.material.uniforms.uMap.value
    })
    await exitShip(page, between)
    await page.waitForTimeout(6000)
    const retiredAtEntry = await page.evaluate(async () => {
      const mod = await import('/tides/src/ship/body-map-residency.ts')
      return mod.isRetiredMap(window.__jupiterMap)
    })
    await holdAt(page, 'jupiter')
    await page.evaluate((r) => { window.__approachPx = r }, +(process.env.RPX || 20))
    // Recording from the frame before entry, so the first ship frame's time is in the log.
    const pending = record(page, 14, 'jupiter')
    await enterShip(page)
    const rows = (await pending).filter((r) => r.ship && r.views <= 2)
    await page.evaluate(() => __H.pause())
    const pixels = await page.evaluate(() => __H.pixels(['fullMaps', 'proxyBlack']))
    const list = await page.evaluate(() => __B.list())
    console.log(JSON.stringify({ mode: 'reentry', phone, planetsBetween: between, retiredAtEntry,
      frames: rows.map((r) => `${r.watch ?? '-'}@${r.r ?? '-'}${r.on ? ':on' : ':off'}${r.placed ? '' : ':unplaced'}:${r.dt}ms`), jupiter: list.find((b) => b.body === 'jupiter'), pixels }))
  } finally {
    await browser.close()
  }
}

async function approach(phone) {
  const target = process.env.TARGET || 'mars'
  const { browser, page } = await openAt(POSES.sea, { phone })
  try {
    await holdAt(page, target)
    await page.evaluate(() => { window.__approachPx = 1 })
    await H.settle(page, SETTLE)
    await page.evaluate(() => { __H.freeze() })
    const find = (target) => {
      const i = __B.list().findIndex((b) => b.body === target)
      return i < 0 ? null : __B.meshes()[i]
    }
    // Paused A/Bs, ascending (promotion is sticky, so none of these may cross PROMOTE).
    for (const r of (process.env.RADII || '1,4,7,7.9').split(',').map(Number)) {
      await page.evaluate((r) => { window.__approachPx = r }, r)
      await page.waitForTimeout(1500)
      await page.evaluate(() => __H.pause())
      const row = await page.evaluate(([target, find]) => {
        const m = (0, eval)(find)(target)
        const b = __B.list().find((x) => x.body === target)
        return { at: m ? +__B.radiusPx(m).toFixed(3) : null, tier: b?.tier, onScreen: b?.onScreen }
      }, [target, `(${find})`])
      if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${target}-${r}.png` })
      const px = await page.evaluate(() => __H.pixels(['fullMaps', 'proxyBlack']))
      console.log(JSON.stringify({ target, phone, wantPx: r, ...row, pixels: px }))
      await page.evaluate(() => __H.resume())
    }
    // Live approach: FROM -> TO px geometrically over SECONDS, logging each rAF.
    const from = +(process.env.FROM || 2), to = +(process.env.TO || 20), secs = +(process.env.SECONDS || 8)
    // Frame times: held under the shared GPU lock (~SECONDS + 1 s).
    const log = await H.withGpuLock(() => page.evaluate(([target, find, from, to, secs]) => new Promise((resolve) => {
      const m = (0, eval)(find)(target)
      const u = m.material.uniforms.uMap
      const rows = []
      const t0 = performance.now()
      let last = t0
      const step = (now) => {
        const s = (now - t0) / 1000
        window.__approachPx = from * Math.pow(to / from, Math.min(1, s / secs))
        rows.push({ dt: +(now - last).toFixed(2), r: +__B.radiusPx(m).toFixed(3), tier: u.value.userData?.fullMap ? 'proxy' : 'full', live: window.__vram.live })
        last = now
        if (s < secs + 0.5) requestAnimationFrame(step)
        else resolve(rows)
      }
      requestAnimationFrame(step)
    }), [target, `(${find})`, from, to, secs]))
    const sw = log.findIndex((row) => row.tier === 'full')
    const near = sw < 0 ? [] : log.slice(Math.max(0, sw - 5), sw + 6)
    const MB = (b) => +(b / 1048576).toFixed(3)
    console.log(JSON.stringify({
      target, phone, frames: log.length, switchFrame: sw,
      rAtSwitch: sw < 0 ? null : log[sw].r, rFrameBefore: sw > 0 ? log[sw - 1].r : null,
      maxDtNearSwitch: near.length ? Math.max(...near.map((x) => x.dt)) : null,
      dtNearSwitch: near.map((x) => x.dt), maxDtAll: Math.max(...log.slice(1).map((x) => x.dt)),
      // The upload runs in the frame before the uniform swap shows (React commits it after the frame callback).
      liveGrowMB: sw < 0 ? null : MB(log[Math.min(log.length - 1, sw + 5)].live - log[Math.max(0, sw - 2)].live),
      fullAfter: await page.evaluate(() => __B.list().filter((b) => b.tier === 'full').map((b) => `${b.body}:${b.rPx}`)),
      liveSteps: log.flatMap((row, i) => (i > 0 && row.live !== log[i - 1].live ? [`${i}:r${row.r}:${MB(row.live - log[i - 1].live)}MB`] : [])),
    }))
    if (process.env.LOG) console.log(JSON.stringify(log))
  } finally {
    await browser.close()
  }
}

// tides-0oi.14: system view with planets on. Load time (planets switched on -> all 26 maps bound), frame times while
// loading, then every body's full map forced resident and summed, and the formats each took.
async function system(phone) {
  const { browser, page } = await launch({ phone })
  try {
    await H.open(page, { planets: '0', ...PARAMS }, { waitMs: 14000 })
    await H.hook(page)
    await page.evaluate(BODIES)
    const load = await page.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now(), dts = []
      let last = t0
      __H.store.setState({ showPlanets: true })
      const step = (now) => {
        dts.push(+(now - last).toFixed(1)); last = now
        const ms = __B.meshesAll(), bound = ms.filter((m) => m.material.uniforms.uMap.value)
        if ((bound.length >= 26 && new Set(bound.map(__B.nameOf)).size >= 26) || now - t0 > 30000) {
          resolve({ loadMs: Math.round(now - t0), frames: dts.length, maxDt: Math.max(...dts.slice(1)), over33: dts.filter((d) => d > 33.4).length, bound: bound.length })
        } else requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }))
    await page.waitForTimeout(3000)
    const res = await page.evaluate(() => {
      const maps = new Set(__B.meshesAll().map((m) => { const t = m.material.uniforms.uMap.value; return t?.userData?.fullMap ?? t }).filter(Boolean))
      for (const t of maps) __H.gl.initTexture(t)
      let bytes = 0; const fmts = {}
      for (const t of maps) { bytes += __B.liveOf(t); const f = t.isCompressedTexture ? '0x' + t.format.toString(16) : 'rgba'; fmts[f] = (fmts[f] || 0) + 1 }
      const cpu = [...maps].reduce((s, t) => s + (t.isCompressedTexture ? t.mipmaps.reduce((a, l) => a + l.data.byteLength, 0) : 0), 0)
      return { maps: maps.size, bodyMapsMB: +(bytes / 1048576).toFixed(1), fmts, cpuMipsMB: +(cpu / 1048576).toFixed(1), vram: __H.vram() }
    })
    const assets = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/(bodies|moons)\/|\/assets\/[a-z]+-2k\.jpg/.test(e.name) && /\.(ktx2|jpg)/.test(e.name))
      .reduce((o, e) => { const k = e.name.match(/\.(ktx2|jpg)/)[1]; o[k] = (o[k] || 0) + 1; return o }, {}))
    console.log(JSON.stringify({ mode: 'system', mask: MASK.length, params: PARAMS, load, assets, ...res }))
  } finally {
    await browser.close()
  }
}

async function board(phone) {
  const fs = require('fs'), path = require('path')
  const OUT = process.env.OUT || '.'
  fs.mkdirSync(OUT, { recursive: true })
  const { browser, page } = await launch({ phone })
  try {
    await H.open(page, { planets: '1', ...PARAMS }, { waitMs: 18000 })
    await H.hook(page)
    await page.evaluate(BODIES)
    for (const spec of (process.env.IMAGES || 'mars:50').split(';')) {
      const rows = []
      for (const item of spec.split('+')) {
        const crop = item.endsWith('*')
        const [target, r, extent] = item.replace('*', '').split(':')
        await page.evaluate(([target, r]) => { window.__boardAt = { target, r: +r } }, [target, r])
        await page.evaluate(() => __H.resume())
        await page.waitForTimeout(2500)
        await page.evaluate(() => { __H.freeze() })
        await page.waitForTimeout(600)
        await page.evaluate(() => __H.pause())
        await H.hook(page)
        const n = await page.evaluate(() => __B.loadJpegs())
        const row = await page.evaluate(async ([t, e, c]) => { const x = await __B.row(t, e, c); window.__rows = (window.__rows || []).concat([x.panels]); delete x.panels; return x }, [target, +(extent || 1.3), crop])
        row.jpegs = n
        rows.push(row)
        if (process.env.TIME) {
          const K = +(process.env.K || 8), N = +(process.env.N || 10)
          row.timing = await H.withGpuLock(() => page.evaluate(([K, N]) => __H.ab(['base', 'jpegMaps'], K, N), [K, N]))
        }
      }
      const name = (process.env.TAG ? process.env.TAG + '_' : '') + spec.replace(/[:+*]/g, (c) => ({ ':': '-', '+': '__', '*': 'x3' })[c]) + '.png'
      const b64 = await page.evaluate(async () => { const p = await __B.png(window.__rows); window.__rows = []; return p })
      fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'))
      console.log(JSON.stringify({ image: path.join(OUT, name), mask: MASK.length ? process.env.MASK : 'none', rows }))
    }
  } finally {
    await browser.close()
  }
}

;(async () => {
  const mode = process.env.MODE || 'vram'
  if (mode === 'system') return system(process.env.PHONE !== '0')
  if (mode === 'board') return board(process.env.PHONE !== '0')
  const phone = process.env.PHONE !== '0'
  if (mode === 'approach') await approach(phone)
  else if (mode === 'entry') await entry(phone)
  else if (mode === 'exit') await exit(phone)
  else if (mode === 'reentry') await reentry(phone)
  else await vramOrPixels(mode, phone)
})()
