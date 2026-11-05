// Ship-mode body maps on approach (tides-0oi.7): resident texture memory, same-tick pixel A/B of the mip-tail proxies
// against their full maps, and approach runs that log when a body's full map is swapped in. See README.md.
//
//   MODE=vram     POSES=sea,earth node body-maps.cjs            # V.live (resident bytes) + three's texture count
//   MODE=pixels   POSES=sea,earth node body-maps.cjs            # fullMaps (B) vs proxies (A), proxyBlack control
//   MODE=approach TARGET=mars PHONE=0 node body-maps.cjs        # paused A/Bs at RADII px, then a live approach
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
const pose = (name) => (POSES[name] ? { name, ...POSES[name] } : { name: 'custom', ...JSON.parse(name) })

// In page: the bodies whose surface material samples uMap, and the fullMaps / proxyBlack variants.
const BODIES = () => {
  const H = window.__H, T = H.T, gl = H.gl, V = window.__vram
  const B = (window.__B = {})
  const fullOf = (tex) => tex?.userData?.fullMap
  const nameOf = (mesh, tex) => {
    if (mesh.userData.focus) return mesh.userData.focus
    const img = (fullOf(tex) ?? tex)?.image
    const src = img?.src || img?.currentSrc || ''
    const m = src.match(/\/([a-z]+)-[12]k\.(jpg|png)/)
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
        body: nameOf(m, tex), tier: full ? 'proxy' : 'full', w: tex.image?.width, h: tex.image?.height,
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
  return true
}

async function openAt(p, { phone }) {
  const { browser, page } = await H.launch({ phone })
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

;(async () => {
  const mode = process.env.MODE || 'vram'
  const phone = process.env.PHONE !== '0'
  if (mode === 'approach') await approach(phone)
  else await vramOrPixels(mode, phone)
})()
