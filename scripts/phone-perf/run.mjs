#!/usr/bin/env node
// One-command frame-time profile of tides on a phone (Chrome over adb) or on
// desktop Chrome with phone emulation. See README.md for the knobs.
//
//   npm run perf:phone                        # the phone over adb
//   TARGET=desktop npm run perf:phone         # desktop Chrome, 390x844 @3, low tier
//   BUILDS=before=../a,after=../b npm run perf:phone   # A/B two source trees, interleaved
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as adb from './adb.mjs'
import { CdpConnection, CdpPage, browserWsUrl, sleep } from './cdp.mjs'
import { INIT_SCRIPT, PROBE_SCRIPT } from './inpage.mjs'
import { POSES, expandPoses, poseUrl, roundOrder } from './poses.mjs'
import { writeReport } from './report.mjs'
import { estimateRefreshPeriod, summariseFrames } from './stats.mjs'
import { TRACE_CATEGORIES, summariseProfile, summariseTrace } from './trace.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const env = process.env
const num = (name, fallback) => (env[name] === undefined ? fallback : Number(env[name]))

const config = {
  target: env.TARGET ?? 'phone',
  // Strides uses 52xx and adb's 9222; perf-audit uses 5391.
  vitePort: num('VITE_PORT', 5393),
  cdpPort: num('CDP_PORT', 9393),
  serve: env.SERVE ?? 'build', // build (vite build + preview) | dev | none (BASE_URL already serving)
  baseUrl: env.BASE_URL,
  poses: env.POSES ? env.POSES.split(',').map((s) => s.trim()) : null,
  tiers: env.TIERS ? env.TIERS.split(',').map((s) => s.trim()) : null,
  runs: num('RUNS', 3),
  durationMs: num('DURATION_MS', 10000),
  traceMs: num('TRACE_MS', 4000),
  profileMs: num('PROFILE_MS', 4000),
  replayK: num('REPLAY_K', 10),
  refreshHz: env.REFRESH_HZ ? Number(env.REFRESH_HZ) : null,
  settleScale: num('SETTLE_SCALE', 1),
  cooldownC: num('COOL_C', 36),
  cooldownTimeoutMs: num('COOL_TIMEOUT_MS', 5 * 60000),
  gapMs: num('GAP_MS', 5000),
  gpuLock: env.GPU_LOCK,
  chrome: env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headed: env.HEADED === '1',
  keepTrace: env.KEEP_TRACE === '1',
  out: env.OUT,
  // name=path,name=path: source trees to build and compare, each served on
  // its own port (VITE_PORT, +1, ...); the first is the "before".
  builds: env.BUILDS ? env.BUILDS.split(',').map(parseBuild) : null,
  // A query string added to every pose URL (overrides): PARAMS='dprctl=systemMax:3'.
  params: env.PARAMS ?? '',
}

function parseBuild(spec) {
  const at = spec.indexOf('=')
  if (at < 1) throw new Error(`BUILDS entries are name=path, not ${spec}`)
  const name = spec.slice(0, at).trim()
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Build name ${name} must be letters, digits, . _ or -`)
  return { name, root: path.resolve(spec.slice(at + 1).trim()) }
}

const log = (...args) => console.log(...args)
const children = []
// What shutdown() must undo however the run ends (error, Ctrl-C).
const active = { device: null, connection: null, page: null, lock: null }

async function main() {
  if (!['phone', 'desktop'].includes(config.target)) throw new Error(`TARGET must be phone or desktop, not ${config.target}`)
  const items = expandPoses(POSES, { tiers: config.tiers, only: config.poses })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = config.out ?? path.join(HERE, 'runs', `${stamp}-${config.target}`)
  fs.mkdirSync(outDir, { recursive: true })

  if (config.builds && config.serve !== 'build') {
    // dev servers would share one optimizer cache through a symlinked node_modules.
    throw new Error('BUILDS builds and previews each tree; it needs SERVE=build')
  }
  if (config.builds && config.runs % 2) log(`note: RUNS=${config.runs} is odd, so the build order is not balanced across rounds`)
  if (config.builds && new Set(config.builds.map((b) => b.name)).size !== config.builds.length) {
    throw new Error('BUILDS names must be unique')
  }
  const builds = (config.builds ?? [{ name: null, root: REPO }]).map((b, i) => {
    const port = config.vitePort + i
    const base = !config.builds && config.baseUrl ? config.baseUrl : `http://localhost:${port}/tides/`
    return { ...b, port, base }
  })
  for (const build of builds) checkTree(build)
  if (config.serve !== 'none') for (const build of builds) await startServer(build)

  const device = config.target === 'phone' ? await openPhone(builds.map((b) => b.port)) : await openDesktop()
  active.device = device
  const connection = await CdpConnection.open((await browserWsUrl(config.cdpPort)).url)
  active.connection = connection
  const browserVersion = await connection.send('Browser.getVersion')
  log(`browser: ${browserVersion.product} (${config.target})`)

  const meta = {
    startedAt: new Date().toISOString(),
    target: config.target,
    git: await gitHead(REPO),
    serve: config.serve,
    base: builds[0].base,
    builds: config.builds
      ? await Promise.all(builds.map(async (b) => ({ name: b.name, root: b.root, git: await gitHead(b.root), base: b.base })))
      : null,
    browser: browserVersion.product,
    userAgent: browserVersion.userAgent,
    device: device.info,
    config: { ...config, chrome: undefined },
  }
  const results = []
  try {
    for (let round = 0; round < config.runs; round++) {
      for (const item of roundOrder(items, round)) {
        // Builds run back to back per pose, the order alternating each
        // round, so a before/after pair sees the same phone state.
        for (const build of roundOrder(builds, round)) {
          const record = await measureWithGuards(connection, device, item, build, round)
          results.push(record)
          fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 1))
          if (config.gapMs) await sleep(config.gapMs)
        }
      }
    }
  } finally {
    meta.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 1))
    const report = writeReport(outDir, { meta, results })
    log(`\nreport: ${report}`)
  }
}

async function measureWithGuards(connection, device, item, build, round) {
  const key = build.name ? `${item.key}#${build.name}` : item.key
  let thermalBefore = null
  if (device.serial) {
    const cooled = await adb.coolDown(device.serial, {
      maxC: config.cooldownC,
      timeoutMs: config.cooldownTimeoutMs,
      log,
    })
    thermalBefore = { ...cooled.thermal, waitedMs: cooled.waitedMs, cool: cooled.cool }
  }
  log(`\n[round ${round + 1}/${config.runs}] ${key}${thermalBefore ? ` (${adb.thermalLine(thermalBefore)})` : ''}`)
  const measure = () => measurePose(connection, device, item, build.base)
  let record
  try {
    record = config.gpuLock && !device.serial ? await withGpuLock(config.gpuLock, measure) : await measure()
  } catch (error) {
    log(`  FAILED: ${error.message}`)
    record = { error: error.message }
  }
  const thermalAfter = device.serial ? await adb.readThermal(device.serial).catch(() => null) : null
  return {
    key,
    poseKey: item.key,
    build: build.name,
    pose: item.id,
    label: item.label,
    tier: item.tier,
    round,
    thermalBefore,
    thermalAfter,
    ...record,
  }
}

async function measurePose(connection, device, item, base) {
  const page = await CdpPage.create(connection)
  active.page = page
  try {
    if (device.emulate) await device.emulate(page)
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      // The ship's how-to-fly dialog covers the view on first entry; mark it seen.
      source: `${INIT_SCRIPT};try{sessionStorage.setItem('tides.shipControlsSeen','1')}catch{}`,
    })
    await page.send('Page.bringToFront')
    const url = poseUrl(base, item, config.params)
    // A cold start: the HTTP cache is emptied (the GPU's own shader cache on
    // disk is not reachable from the protocol and stays warm).
    if (item.coldStart) await page.send('Network.clearBrowserCache')
    const loadStart = Date.now()
    await page.navigate(url, 120000)
    await page.waitForExpression(
      `!!(window.__ppHandles?.getState && !document.querySelector('.loading-overlay'))`,
      { timeoutMs: 120000 }
    )
    const loadMs = Date.now() - loadStart
    let startup = null
    if (item.coldStart) {
      await page.waitForExpression('window.__pp.startup.done === true', { timeoutMs: 60000 })
      startup = await page.evaluate('window.__pp.startupSummary()')
      log(
        `  cold start: first frame ${fmt(startup.firstFrameMs)} ms, loader gone ${fmt(startup.loaderGoneMs)} ms, longest block ${fmt(startup.longestTaskMs)} ms` +
          ` (after loader ${fmt(startup.longestTaskAfterLoaderMs)}), longest frame after loader ${fmt(startup.longestFrameAfterLoaderMs)} ms`
      )
    }
    await page.evaluate(PROBE_SCRIPT)
    if (item.setup) await page.evaluate(item.setup)
    if (item.params.ship) {
      await page.waitForExpression(`!!window.__ship`, { timeoutMs: 20000 }).catch(() => {
        throw new Error('Ship mode never stepped (no window.__ship): did ?ship=1 enter ship mode?')
      })
    }
    // Resident GPU memory once the pose is up, before the settle: in ship mode
    // that is what entry uploads.
    const memoryAtReady = await page.evaluate('window.__ppProbe.info().vramMB')
    await sleep(item.settleMs * config.settleScale)
    if (item.setup && /__(main|ship)Pose/.test(item.setup)) {
      // The hook must have run every frame of the settle, or the pose
      // measured the default view.
      const hits = await page.evaluate('window.__ppPoseHits ?? 0')
      if (hits < 30) throw new Error(`Pose hook ran ${hits} times during the settle; the pose did not take`)
    }
    const visibility = await page.evaluate('document.visibilityState')
    if (visibility !== 'visible') throw new Error(`Page is ${visibility}; rAF would not run (is the screen on and the tab in front?)`)

    if (item.beforeSample) await page.evaluate(item.beforeSample)
    log(`  sampling ${config.durationMs} ms`)
    const sample = await page.evaluate(`window.__ppProbe.sample(${config.durationMs})`, {
      timeoutMs: config.durationMs + 30000,
    })
    // The display's rate can change under adaptive refresh, so the faster of
    // the reported rate and the fastest steady frames sets the vsync period.
    const reportedHz = config.refreshHz ?? (device.serial ? await adb.displayFps(device.serial) : null)
    const estimated = estimateRefreshPeriod(sample.deltas)
    const periodMs = reportedHz ? Math.min(1000 / reportedHz, estimated ?? Infinity) : estimated
    const frames = summariseFrames(sample.deltas, periodMs)
    const gpu = sample.gpuMs.length ? summariseFrames(sample.gpuMs) : null

    log(`  tracing ${config.traceMs} ms`)
    const marks = [`pp:trace:start:${process.pid}:${Date.now()}`, `pp:trace:end:${process.pid}:${Date.now()}`]
    const { trace, traceFrames } = await captureTrace(connection, page, marks)
    const traceSummary = summariseTrace(trace, { targetId: page.targetId, url, frames: traceFrames, marks })
    if (traceSummary.error) log(`  trace: ${traceSummary.error}`)
    if (config.keepTrace) {
      fs.writeFileSync(path.join(config.out ?? os.tmpdir(), `trace-${item.key}-${Date.now()}.json`), JSON.stringify(trace))
    }

    log(`  profiling ${config.profileMs} ms`)
    const profile = await captureProfile(page)

    const replay = await page.evaluate(`window.__ppProbe.replay(${config.replayK}, 7)`, { timeoutMs: 120000 })
    // The low tier's dpr controller (tides-0oi.13) logs its changes when present.
    const dprTimeline = await page.evaluate(
      'window.__dprctl?.changes ? JSON.parse(JSON.stringify(window.__dprctl.changes.slice(-500))) : null'
    )

    const result = {
      url,
      loadMs,
      startup,
      memoryAtReady,
      dprTimeline,
      info: sample.info,
      frames,
      gpu: gpu && { source: sample.gpuSource, p50: gpu.p50, p95: gpu.p95, frames: gpu.frames },
      longTasks: { count: sample.longTasks.length, maxMs: Math.max(0, ...sample.longTasks) },
      trace: { ...traceSummary, frames: traceFrames },
      profile,
      replay,
    }
    log(
      `  p50 ${fmt(frames.p50)} p95 ${fmt(frames.p95)} p99 ${fmt(frames.p99)} ms, dropped ${pct(frames.droppedShare)}` +
        ` @${frames.refreshHz} Hz, dpr ${sample.info.dpr}, tier ${sample.info.quality}, gpu ${gpu ? fmt(gpu.p50) + ' ms (' + sample.gpuSource + ')' : 'n/a'}` +
        `, main ${fmt(traceSummary.main?.busyPerFrameMs)} ms/frame, replay ${fmt(replay?.ms)} ms, VRAM ${sample.info.vramMB.total} MB`
    )
    return result
  } finally {
    active.page = null
    await page.close()
  }
}

async function captureTrace(connection, page, marks) {
  const events = []
  const offData = connection.on('Tracing.dataCollected', ({ value }) => events.push(...value))
  await connection.send('Tracing.start', {
    traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: 'recordAsMuchAsPossible' },
    transferMode: 'ReportEvents',
  })
  let traceFrames
  try {
    const sample = await page.evaluate(
      `window.__ppProbe.sample(${config.traceMs}, ${JSON.stringify(marks)})`,
      { timeoutMs: config.traceMs + 30000 }
    )
    traceFrames = sample.deltas.length
  } finally {
    const complete = connection.waitFor('Tracing.tracingComplete', undefined, 120000)
    complete.catch(() => {})
    await connection.send('Tracing.end')
    await complete
    offData()
  }
  return { trace: events, traceFrames }
}

// Profiler.start itself causes one 130-170 ms stall right after it starts
// (tides-frame-hitch-measure), so this window is for where script time goes,
// not for frame times.
async function captureProfile(page) {
  await page.send('Profiler.enable')
  await page.send('Profiler.setSamplingInterval', { interval: 200 })
  await page.send('Profiler.start')
  await sleep(config.profileMs)
  const { profile } = await page.send('Profiler.stop')
  await page.send('Profiler.disable')
  const seconds = (profile.endTime - profile.startTime) / 1e6
  return { seconds, topSelfMs: summariseProfile(profile, 20) }
}

// Builds a source tree with the harness's config and serves it. Another tree
// (BUILDS) is built with its own working directory as the root, so its src/
// is what gets hooked and bundled; the app config the harness merges is this
// checkout's, so the tree's own vite.config.ts must match it.
function checkTree(build) {
  if (build.root !== REPO) {
    const own = fs.readFileSync(path.join(build.root, 'vite.config.ts'), 'utf8')
    if (own !== fs.readFileSync(path.join(REPO, 'vite.config.ts'), 'utf8')) {
      throw new Error(`${build.root}/vite.config.ts differs from this checkout's; the harness would build it with the wrong config`)
    }
    if (!fs.existsSync(path.join(build.root, 'node_modules'))) {
      throw new Error(`${build.root} has no node_modules (install, or symlink a checkout's with the same package-lock.json)`)
    }
  }
}

async function startServer(build) {
  const vite = path.join(REPO, 'node_modules/.bin/vite')
  const configFile = path.join(HERE, 'vite.config.mjs')
  const dist = path.join(HERE, build.name ? `.dist-${build.name}` : '.dist')
  const label = build.name ? ` ${build.name} (${build.root})` : ''
  if (config.serve === 'build') {
    log(`building${label} (vite build with the harness hooks)…`)
    await runToEnd(vite, ['build', '--config', configFile, '--outDir', dist, '--emptyOutDir'], { cwd: build.root })
  }
  const port = String(build.port)
  const args =
    config.serve === 'build'
      ? ['preview', '--config', configFile, '--outDir', dist, '--port', port, '--strictPort', '--host']
      : ['--config', configFile, '--port', port, '--strictPort', '--host']
  const server = spawn(vite, args, { cwd: build.root, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(server)
  let output = ''
  server.stdout.on('data', (d) => (output += d))
  server.stderr.on('data', (d) => (output += d))
  const url = `http://localhost:${build.port}/tides/`
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited (${server.exitCode}):\n${output}`)
    if (await fetch(url).then((r) => r.ok).catch(() => false)) {
      log(`serving${label} ${url} (${config.serve})`)
      return
    }
    await sleep(300)
  }
  throw new Error(`vite did not answer on ${url}:\n${output}`)
}

const DESKTOP_PHONE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; SM-G991U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}

async function openDesktop() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-perf-chrome-'))
  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${DESKTOP_PHONE.width},${DESKTOP_PHONE.height + 100}`,
  ]
  if (!config.headed) args.push('--headless=new')
  const chrome = spawn(config.chrome, [...args, 'about:blank'], { stdio: 'ignore' })
  children.push(chrome)
  return {
    info: { kind: 'desktop', emulation: DESKTOP_PHONE },
    emulate: async (page) => {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: DESKTOP_PHONE.width,
        height: DESKTOP_PHONE.height,
        deviceScaleFactor: DESKTOP_PHONE.deviceScaleFactor,
        mobile: true,
      })
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await page.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_PHONE.userAgent, platform: 'Linux armv8l' })
    },
    close: async () => {
      chrome.kill()
      await sleep(500)
      fs.rmSync(profile, { recursive: true, force: true })
    },
  }
}

async function openPhone(vitePorts) {
  const serial = adb.pickSerial(await adb.adb(null, "devices", "-l"), env.ADB_SERIAL ?? env.ANDROID_SERIAL)
  log(`phone: ${serial}`)
  const ports = { cdpPort: config.cdpPort, vitePorts }
  // Released by shutdown() from before the first change, so Ctrl-C mid-prepare
  // or a failed device read still removes the forwards and restores stay-on.
  const pending = { stayOn: null }
  const device = { serial, info: null, close: () => adb.releaseDevice(serial, { ...ports, stayOn: pending.stayOn }) }
  active.device = device
  await adb.prepareDevice(serial, ports, pending)
  device.info = { kind: 'phone', serial, ...(await adb.deviceInfo(serial)), thermalAtStart: await adb.readThermal(serial) }
  const info = device.info
  log(`  ${info.model}, Android ${info.android}, Chrome ${info.chrome}, battery ${info.battery}%, ${adb.thermalLine(info.thermalAtStart)}`)
  return device
}

// The cross-stream GPU lock (shared with the perf-audit stream): a directory
// made atomically, its owner file holding "<who> <epoch ms>"; a lock older
// than 180 s is stale. The owner time is refreshed while held.
async function withGpuLock(lock, fn, { staleMs = 180000 } = {}) {
  const who = `phone-perf:${process.pid}`
  const owner = path.join(lock, 'owner')
  let waitedSince = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lock)
      fs.writeFileSync(owner, `${who} ${Date.now()}`)
      break
    } catch {
      // A lock whose owner file is missing (its holder died between mkdir and
      // write) ages from the directory's own time.
      const readHolder = () => {
        try {
          const [holder, at] = fs.readFileSync(owner, 'utf8').split(' ')
          return { holder, at: Number(at) }
        } catch {
          try {
            return { holder: '?', at: fs.statSync(lock).mtimeMs }
          } catch {
            return null
          }
        }
      }
      const seen = readHolder()
      if (!seen) continue
      const { holder, at } = seen
      if (Date.now() - at > staleMs) {
        // Moved aside (atomic) rather than deleted in place, and only if it is
        // still the same stale lock just before the move, so a waiter that saw
        // it stale earlier does not remove a lock another has just taken
        // (a narrow window remains between the re-check and the move).
        const again = readHolder()
        if (!again || again.at !== at) continue
        const tomb = `${lock}.stale-${process.pid}-${Date.now()}`
        try {
          fs.renameSync(lock, tomb)
          fs.rmSync(tomb, { recursive: true, force: true })
          log(`  removed a stale GPU lock (held by ${holder})`)
        } catch {}
        continue
      }
      if (Date.now() - waitedSince > 30000) {
        log(`  waiting for GPU lock (held by ${holder})`)
        waitedSince = Date.now()
      }
      await sleep(500)
    }
  }
  active.lock = lock
  const refresh = setInterval(() => {
    try {
      fs.writeFileSync(owner, `${who} ${Date.now()}`)
    } catch {}
  }, 30000)
  try {
    return await fn()
  } finally {
    clearInterval(refresh)
    active.lock = null
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

function runToEnd(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} exited ${code}`))))
  })
}

async function gitHead(root) {
  const { execFileSync } = await import('node:child_process')
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root }).toString().trim()
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return null
  }
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : '–')
const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '–')

let shuttingDown = null
function shutdown() {
  shuttingDown ??= (async () => {
    // Ctrl-C mid-pose exits before withGpuLock's finally runs.
    if (active.lock) fs.rmSync(active.lock, { recursive: true, force: true })
    if (active.page) await active.page.close().catch(() => {})
    active.connection?.close()
    if (active.device) {
      log('releasing the device…')
      await active.device.close().catch((error) => log(`  release failed: ${error.message}`))
    }
    for (const child of children) if (child.exitCode === null) child.kill()
  })()
  return shuttingDown
}
process.on('exit', () => {
  for (const child of children) if (child.exitCode === null) child.kill()
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown().finally(() => process.exit(130)))
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error.stack ?? error.message)
    await shutdown()
    process.exit(1)
  })
