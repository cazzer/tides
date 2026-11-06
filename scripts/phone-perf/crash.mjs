#!/usr/bin/env node
// Crash repro on the phone (tides-8h7): holds close-zoom poses and a pinch /
// pivot gesture path for minutes on one build while recording what a GPU
// crash, a context loss or a tab kill would leave behind: adb logcat
// (filtered), dumpsys meminfo of Chrome's processes every 30 s, chrome://gpu
// once, and in-page memory every 10 s. A crash or kill is recorded and the
// page reloaded for the next path; adb itself dropping ends the run (exit 3).
//
//   ANDROID_SERIAL=ip:port ROOT=<source tree> NAME=r38 OUT=<dir> \
//     PATHS=sea,land,gesture HOLD_MS=300000 node scripts/phone-perf/crash.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as adb from './adb.mjs'
import { CdpConnection, CdpPage, browserWsUrl, sleep } from './cdp.mjs'
import { INIT_SCRIPT, PROBE_SCRIPT } from './inpage.mjs'
import { mainPose } from './poses.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const env = process.env
const cfg = {
  serial: env.ANDROID_SERIAL,
  root: path.resolve(env.ROOT ?? REPO),
  name: env.NAME ?? 'crash',
  out: path.resolve(env.OUT ?? path.join(HERE, 'runs', `crash-${Date.now()}`)),
  paths: (env.PATHS ?? 'sea,land,gesture').split(',').map((s) => s.trim()).filter(Boolean),
  holdMs: Number(env.HOLD_MS ?? 300000),
  vitePort: Number(env.VITE_PORT ?? 5393),
  cdpPort: Number(env.CDP_PORT ?? 9393),
  coolC: Number(env.COOL_C ?? 36),
}

// lib.cjs poseMain style poses (focus=earth, real weather), and the gesture path.
const PATHS = {
  sea: { pose: { lat: 20, lon: -130, km: 2, tilt: 86 }, t: '2026-11-04T21:00:00Z' },
  land: { pose: { lat: 38.5, lon: -98, km: 3, tilt: 86 }, t: '2026-11-04T18:00:00Z' },
  // Pinch into Earth to the floor, two-finger drag to the tilt limit, hold.
  gesture: { gesture: true, t: '2026-11-04T21:00:00Z' },
}

const LOGCAT_FILTER = /chromium|GPU|gpu_process|kgsl|lmkd|lowmemorykiller|context lost|Aw, Snap/i

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
fs.mkdirSync(cfg.out, { recursive: true })
const write = (file, data) => fs.writeFileSync(path.join(cfg.out, file), typeof data === 'string' ? data : JSON.stringify(data, null, 1))
const append = (file, text) => fs.appendFileSync(path.join(cfg.out, file), text)

class AdbDropped extends Error {}

async function main() {
  if (!cfg.serial) throw new Error('Set ANDROID_SERIAL')
  for (const p of cfg.paths) if (!PATHS[p]) throw new Error(`Unknown path ${p} (have ${Object.keys(PATHS).join(', ')})`)
  if (!(await adb.attached(cfg.serial))) throw new AdbDropped(`${cfg.serial} is not attached`)
  const base = await serve()
  const ports = { cdpPort: cfg.cdpPort, vitePorts: [cfg.vitePort] }
  const pending = {}
  const children = []
  const cleanup = async () => {
    for (const c of children) c.kill()
    if (pending.stayOn !== undefined) await adb.releaseDevice(cfg.serial, { ...ports, stayOn: pending.stayOn })
  }
  process.on('SIGINT', () => cleanup().finally(() => process.exit(130)))
  const summary = {
    build: { root: cfg.root, git: await git(cfg.root), name: cfg.name },
    device: null,
    startedAt: new Date().toISOString(),
    holdMs: cfg.holdMs,
    paths: [],
  }
  try {
    await adb.prepareDevice(cfg.serial, ports, pending)
    summary.device = await adb.deviceInfo(cfg.serial)
    await adb.adb(cfg.serial, 'logcat', '-c').catch(() => {})
    children.push(startLogcat())
    let connection = await CdpConnection.open((await browserWsUrl(cfg.cdpPort)).url)
    summary.browser = (await connection.send('Browser.getVersion')).product
    for (const [i, name] of cfg.paths.entries()) {
      if (!(await adb.attached(cfg.serial))) throw new AdbDropped('adb dropped')
      if (connection.closed) connection = await CdpConnection.open((await browserWsUrl(cfg.cdpPort)).url)
      const result = await runPath(connection, name, PATHS[name], base)
      summary.paths.push(result)
      write('summary.json', summary)
      if (i === 0) await chromeGpu(connection).catch((e) => log(`chrome://gpu: ${e.message}`))
    }
  } finally {
    summary.finishedAt = new Date().toISOString()
    write('summary.json', summary)
    await cleanup()
  }
  for (const p of summary.paths) {
    log(`${p.name}: ${p.crash ? `CRASH (${p.crash.kind}) at ${Math.round(p.crash.atS)} s` : 'no crash'}; context lost ${p.contextEvents.filter((e) => e.type === 'webglcontextlost').length}x; logcat hits ${p.logcatHits}`)
  }
}

// Builds the tree with the harness hooks and previews it.
async function serve() {
  if (cfg.root !== REPO) {
    const own = fs.readFileSync(path.join(cfg.root, 'vite.config.ts'), 'utf8')
    if (own !== fs.readFileSync(path.join(REPO, 'vite.config.ts'), 'utf8')) throw new Error(`${cfg.root}/vite.config.ts differs from this checkout's`)
  }
  const vite = path.join(REPO, 'node_modules/.bin/vite')
  const configFile = path.join(HERE, 'vite.config.mjs')
  const dist = path.join(HERE, `.dist-${cfg.name}`)
  log(`building ${cfg.root}…`)
  await new Promise((resolve, reject) => {
    const p = spawn(vite, ['build', '--config', configFile, '--outDir', dist, '--emptyOutDir'], { cwd: cfg.root, stdio: 'ignore' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`))))
  })
  const server = spawn(vite, ['preview', '--config', configFile, '--outDir', dist, '--port', String(cfg.vitePort), '--strictPort', '--host'], { cwd: cfg.root, stdio: 'ignore' })
  process.on('exit', () => server.kill())
  const url = `http://localhost:${cfg.vitePort}/tides/`
  for (let i = 0; i < 200; i++) {
    if (await fetch(url).then((r) => r.ok).catch(() => false)) {
      log(`serving ${url}`)
      return url
    }
    await sleep(300)
  }
  throw new Error(`vite preview did not answer on ${url}`)
}

function startLogcat() {
  const full = fs.createWriteStream(path.join(cfg.out, 'logcat-full.txt'))
  const filtered = fs.createWriteStream(path.join(cfg.out, 'logcat-filtered.txt'))
  const p = spawn('adb', ['-s', cfg.serial, 'logcat', '-v', 'threadtime'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let rest = ''
  p.stdout.on('data', (chunk) => {
    full.write(chunk)
    const lines = (rest + chunk).split('\n')
    rest = lines.pop()
    for (const line of lines) {
      if (LOGCAT_FILTER.test(line)) {
        filtered.write(line + '\n')
        logcatHits++
      }
    }
  })
  return p
}
let logcatHits = 0

// Chrome's processes and the system's free memory, from dumpsys meminfo.
async function memSnapshot(t) {
  const ps = await adb.adb(cfg.serial, 'shell', 'ps -A -o PID,NAME').catch(() => '')
  const procs = ps
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter(([pid, name]) => /^\d+$/.test(pid) && name?.startsWith('com.android.chrome'))
  const out = { t, procs: [] }
  for (const [pid, name] of procs) {
    const text = await adb.adb(cfg.serial, 'shell', 'dumpsys', 'meminfo', pid).catch(() => '')
    append('meminfo.txt', `\n===== t=${Math.round(t / 1000)} s pid ${pid} ${name}\n${text}`)
    const kb = (re) => Number(re.exec(text)?.[1] ?? NaN)
    out.procs.push({
      pid: Number(pid),
      role: /privileged_process/.test(name) ? 'gpu' : /sandboxed_process/.test(name) ? 'renderer' : name === 'com.android.chrome' ? 'browser' : name,
      name,
      totalPssKB: kb(/TOTAL PSS:\s+(\d+)/),
      totalRssKB: kb(/TOTAL RSS:\s+(\d+)/),
      graphicsKB: kb(/^\s*Graphics:\s+(\d+)/m),
      nativeHeapKB: kb(/^\s*Native Heap:\s+(\d+)/m),
      glMtrackKB: kb(/^\s*GL mtrack\s+(\d+)/m),
      eglMtrackKB: kb(/^\s*EGL mtrack\s+(\d+)/m),
    })
  }
  const mem = await adb.adb(cfg.serial, 'shell', 'cat /proc/meminfo').catch(() => '')
  out.memAvailableKB = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1] ?? NaN)
  out.memFreeKB = Number(/MemFree:\s+(\d+)/.exec(mem)?.[1] ?? NaN)
  return out
}

// The page's own memory and renderer state.
const PAGE_STATS = `(() => {
  const gl = window.__ppHandles?.getState?.().gl
  const pm = performance.memory
  return {
    usedJSHeapMB: pm ? pm.usedJSHeapSize / 1048576 : null,
    totalJSHeapMB: pm ? pm.totalJSHeapSize / 1048576 : null,
    geometries: gl?.info.memory.geometries ?? null,
    textures: gl?.info.memory.textures ?? null,
    programs: gl?.info.programs?.length ?? null,
    pixelRatio: gl?.getPixelRatio?.() ?? null,
    contextLost: gl?.getContext?.().isContextLost?.() ?? null,
    vramMB: (() => { try { return window.__ppProbe?.info().vramMB.total ?? null } catch { return null } })(),
    alt: window.__crashCam?.() ?? null,
    events: window.__crashEvents?.length ?? 0,
  }
})()`

// Context loss and restore on any canvas (capture on window: the events
// don't bubble), and the main camera's altitude and tilt from the pose hook.
const CRASH_INIT = `(() => {
  window.__crashEvents = []
  for (const type of ['webglcontextlost', 'webglcontextrestored', 'webglcontextcreationerror']) {
    window.addEventListener(type, (e) => window.__crashEvents.push({ type, t: performance.now(), target: e.target?.tagName ?? null, message: e.statusMessage ?? null }), true)
  }
})()`

const CAMERA_SPY = `(() => {
  const { THREE: T, store } = window.__ppProbe
  window.__mainPose = (camera) => { window.__crashCamera = camera }
  window.__crashCam = () => {
    const camera = window.__crashCamera
    const earth = store.getState().earth?.current
    if (!camera || !earth) return null
    let ground = null
    earth.traverse((o) => { if (!ground && o.isMesh && o.material?.isMeshPhongMaterial) ground = o })
    if (!ground) return null
    ground.updateWorldMatrix(true, false)
    const c = new T.Vector3().setFromMatrixPosition(ground.matrixWorld)
    if (!ground.geometry.boundingSphere) ground.geometry.computeBoundingSphere()
    const s = new T.Vector3(); ground.getWorldScale(s)
    const R = ground.geometry.boundingSphere.radius * s.x
    const rel = camera.position.clone().sub(c)
    const km = ((rel.length() - R) / R) * 6371
    const down = rel.clone().normalize().negate()
    const fwd = new T.Vector3(); camera.getWorldDirection(fwd)
    const tilt = (Math.acos(Math.max(-1, Math.min(1, fwd.dot(down)))) * 180) / Math.PI
    return { km, tilt }
  }
  return true
})()`

async function runPath(connection, name, spec, base) {
  const cooled = await adb.coolDown(cfg.serial, { maxC: cfg.coolC, timeoutMs: 600000, log })
  const result = {
    name,
    spec,
    thermalBefore: cooled.thermal,
    powerBefore: await adb.readBattery(cfg.serial).catch(() => null),
    gpuBefore: await adb.readGpu(cfg.serial).catch(() => null),
    samples: [],
    mem: [],
    contextEvents: [],
    crash: null,
    gesture: null,
  }
  log(`\n[${name}] ${adb.thermalLine(cooled.thermal)}, ${result.powerBefore?.ac ? 'AC' : 'battery'} ${result.powerBefore?.level}%`)
  await adb.foregroundChrome(cfg.serial).catch(() => {})
  const page = await CdpPage.create(connection)
  let crashed = null
  const t0 = Date.now()
  page.on('Inspector.targetCrashed', () => (crashed ??= { kind: 'renderer crashed (Inspector.targetCrashed)', atS: (Date.now() - t0) / 1000 }))
  page.on('Inspector.detached', (p) => (crashed ??= { kind: `detached: ${p?.reason}`, atS: (Date.now() - t0) / 1000 }))
  await page.send('Inspector.enable').catch(() => {})
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `${INIT_SCRIPT};${CRASH_INIT}` })
  await page.send('Page.bringToFront')
  const params = new URLSearchParams({ focus: 'earth', weather: 'real', t: spec.t })
  const url = `${base}?${params}`
  result.url = url
  const logcatAtStart = logcatHits
  try {
    await page.navigate(url, 120000)
    await page.waitForExpression(`!!(window.__ppHandles?.getState && !document.querySelector('.loading-overlay'))`, { timeoutMs: 180000 })
    result.loadS = (Date.now() - t0) / 1000
    await page.evaluate(PROBE_SCRIPT)
    if (spec.pose) {
      await page.evaluate(mainPose(spec.pose))
      await page.evaluate(`(() => { const f = window.__mainPose; ${CAMERA_SPY}; const spy = window.__mainPose; window.__mainPose = (c, k) => { f(c, k); spy(c, k) }; return true })()`)
    } else {
      await page.evaluate(CAMERA_SPY)
      await sleep(3000)
      result.gesture = await gestures(page)
    }
    log(`  holding ${cfg.holdMs / 1000} s`)
    const holdStart = Date.now()
    let lastMem = -Infinity
    while (Date.now() - holdStart < cfg.holdMs && !crashed) {
      const t = Date.now() - t0
      const stats = await page.evaluate(PAGE_STATS, { timeoutMs: 8000 }).catch((e) => ({ error: e.message }))
      const gpu = await adb.readGpu(cfg.serial).catch(() => null)
      const thermal = await adb.readThermal(cfg.serial).catch(() => null)
      result.samples.push({ t, stats, gpu, thermal: thermal && { status: thermal.status, skin: thermal.skin?.c } })
      if (stats.error) {
        if (!(await adb.attached(cfg.serial))) throw new AdbDropped('adb dropped during the hold')
        // An evaluate that fails or times out twice running: the page is gone.
        const prev = result.samples.at(-2)?.stats
        if (prev?.error) crashed ??= { kind: `page unresponsive: ${stats.error}`, atS: t / 1000 }
      } else if (stats.contextLost) {
        crashed ??= { kind: 'WebGL context lost', atS: t / 1000 }
      }
      if (t - lastMem >= 30000) {
        lastMem = t
        result.mem.push(await memSnapshot(t))
      }
      const s = stats.error ? stats.error : `heap ${stats.usedJSHeapMB?.toFixed(0)} MB, tex ${stats.textures}, prog ${stats.programs}, dpr ${stats.pixelRatio}, vram ${stats.vramMB}, ${stats.alt ? `${stats.alt.km.toFixed(2)} km tilt ${stats.alt.tilt.toFixed(1)}` : ''}`
      log(`  ${Math.round(t / 1000)} s: ${s}; GPU ${gpu?.curMHz} MHz lvl ${gpu?.thermalPwrlevel}; skin ${thermal?.skin?.c}`)
      await sleep(10000)
    }
  } catch (error) {
    if (error instanceof AdbDropped || !(await adb.attached(cfg.serial))) throw new AdbDropped(error.message)
    crashed ??= { kind: `error: ${error.message}`, atS: (Date.now() - t0) / 1000 }
  }
  result.crash = crashed
  result.contextEvents = await page.evaluate('window.__crashEvents ?? []', { timeoutMs: 5000 }).catch(() => [])
  result.mem.push(await memSnapshot(Date.now() - t0))
  result.logcatHits = logcatHits - logcatAtStart
  result.gpuAfter = await adb.readGpu(cfg.serial).catch(() => null)
  if (crashed) log(`  CRASH: ${crashed.kind} at ${Math.round(crashed.atS)} s`)
  await page.close()
  return result
}

const touch = (page, type, points) =>
  page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) })

// Pinch out (zoom in) on the main view until the altitude stops falling,
// then two-finger drags until the tilt stops rising.
async function gestures(page) {
  const rect = await page.evaluate(`(() => { const el = document.querySelector('.panel[data-area="main"]') ?? document.querySelector('canvas'); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const cam = () => page.evaluate('window.__crashCam?.()')
  const trail = [{ step: 'start', ...(await cam()) }]
  log(`  gesture: start ${JSON.stringify(trail[0])}`)
  let still = 0
  for (let i = 0; i < 80 && still < 3; i++) {
    await touch(page, 'touchStart', [[cx, cy - 40]])
    await touch(page, 'touchStart', [[cx, cy - 40], [cx, cy + 40]])
    for (let k = 1; k <= 12; k++) {
      const d = 40 + k * 18
      await touch(page, 'touchMove', [[cx, cy - d], [cx, cy + d]])
      await sleep(16)
    }
    await touch(page, 'touchEnd', [[cx, cy - 256]])
    await touch(page, 'touchEnd', [])
    await sleep(600)
    const now = await cam()
    const prev = trail.at(-1)
    trail.push({ step: `pinch ${i + 1}`, ...now })
    still = now && prev?.km && now.km > prev.km * 0.98 ? still + 1 : 0
  }
  log(`  gesture: floor ${JSON.stringify(trail.at(-1))} after ${trail.length - 1} pinches`)
  let dir = -1 // up the screen
  still = 0
  for (let i = 0; i < 25 && still < 3; i++) {
    const y0 = cy + 150 * -dir
    await touch(page, 'touchStart', [[cx - 60, y0]])
    await touch(page, 'touchStart', [[cx - 60, y0], [cx + 60, y0]])
    for (let k = 1; k <= 15; k++) {
      const y = y0 + dir * k * 20
      await touch(page, 'touchMove', [[cx - 60, y], [cx + 60, y]])
      await sleep(16)
    }
    await touch(page, 'touchEnd', [[cx - 60, y0 + dir * 300]])
    await touch(page, 'touchEnd', [])
    await sleep(600)
    const now = await cam()
    const prev = trail.at(-1)
    trail.push({ step: `drag ${dir < 0 ? 'up' : 'down'} ${i + 1}`, ...now })
    if (i === 0 && now && prev?.tilt !== undefined && now.tilt < prev.tilt - 0.5) dir = -dir
    still = now && prev?.tilt !== undefined && now.tilt < prev.tilt + 0.5 ? still + 1 : 0
  }
  log(`  gesture: max tilt ${JSON.stringify(trail.at(-1))}`)
  return { trail, final: trail.at(-1) }
}

async function chromeGpu(connection) {
  const page = await CdpPage.create(connection, 'chrome://gpu')
  await sleep(4000)
  // chrome://gpu renders into shadow roots; walk them for the text.
  const text = await page.evaluate(`(() => {
    const out = []
    const walk = (n) => { if (n.nodeType === 3) out.push(n.textContent); if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes ?? []) walk(c) }
    walk(document.body)
    return out.join(' ').replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n+/g, '\\n')
  })()`)
  write('chrome-gpu.txt', text)
  log(`  chrome://gpu: ${text.length} chars`)
  await page.close()
}

async function git(root) {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', root, 'rev-parse', 'HEAD'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('exit', () => resolve(out.trim()))
  })
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(error instanceof AdbDropped ? 3 : 1)
  }
)
