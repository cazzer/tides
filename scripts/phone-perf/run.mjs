#!/usr/bin/env node
// One-command frame-time profile of tides on a phone (Chrome over adb) or on
// desktop Chrome with phone emulation. See README.md for the knobs.
//
//   npm run perf:phone                        # the phone over adb
//   TARGET=desktop npm run perf:phone         # desktop Chrome, 390x844 @3, low tier
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
import { summariseFrames } from './stats.mjs'
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
}

const log = (...args) => console.log(...args)
const children = []

async function main() {
  if (!['phone', 'desktop'].includes(config.target)) throw new Error(`TARGET must be phone or desktop, not ${config.target}`)
  const items = expandPoses(POSES, { tiers: config.tiers, only: config.poses })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = config.out ?? path.join(HERE, 'runs', `${stamp}-${config.target}`)
  fs.mkdirSync(outDir, { recursive: true })

  const base = config.baseUrl ?? `http://localhost:${config.vitePort}/tides/`
  if (config.serve !== 'none') await startServer()

  const device = config.target === 'phone' ? await openPhone() : await openDesktop()
  const connection = await CdpConnection.open((await browserWsUrl(config.cdpPort)).url)
  const browserVersion = await connection.send('Browser.getVersion')
  log(`browser: ${browserVersion.product} (${config.target})`)

  const meta = {
    startedAt: new Date().toISOString(),
    target: config.target,
    git: await gitHead(),
    serve: config.serve,
    base,
    browser: browserVersion.product,
    userAgent: browserVersion.userAgent,
    device: device.info,
    config: { ...config, chrome: undefined },
  }
  const results = []
  try {
    for (let round = 0; round < config.runs; round++) {
      for (const item of roundOrder(items, round)) {
        const record = await measureWithGuards(connection, device, item, base, round)
        results.push(record)
        fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 1))
        if (config.gapMs) await sleep(config.gapMs)
      }
    }
  } finally {
    meta.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 1))
    const report = writeReport(outDir, { meta, results })
    log(`\nreport: ${report}`)
    connection.close()
    await device.close()
  }
}

async function measureWithGuards(connection, device, item, base, round) {
  let thermalBefore = null
  if (device.serial) {
    const cooled = await adb.coolDown(device.serial, {
      maxC: config.cooldownC,
      timeoutMs: config.cooldownTimeoutMs,
      log,
    })
    thermalBefore = { ...cooled.thermal, waitedMs: cooled.waitedMs, cool: cooled.cool }
  }
  log(`\n[round ${round + 1}/${config.runs}] ${item.key}${thermalBefore ? ` (${adb.thermalLine(thermalBefore)})` : ''}`)
  const measure = () => measurePose(connection, device, item, base)
  let record
  try {
    record = config.gpuLock && !device.serial ? await withGpuLock(config.gpuLock, measure) : await measure()
  } catch (error) {
    log(`  FAILED: ${error.message}`)
    record = { error: error.message }
  }
  const thermalAfter = device.serial ? await adb.readThermal(device.serial).catch(() => null) : null
  return { key: item.key, pose: item.id, label: item.label, tier: item.tier, round, thermalBefore, thermalAfter, ...record }
}

async function measurePose(connection, device, item, base) {
  const page = await CdpPage.create(connection)
  try {
    if (device.emulate) await device.emulate(page)
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      // The ship's how-to-fly dialog covers the view on first entry; mark it seen.
      source: `${INIT_SCRIPT};try{sessionStorage.setItem('tides.shipControlsSeen','1')}catch{}`,
    })
    await page.send('Page.bringToFront')
    const url = poseUrl(base, item)
    const loadStart = Date.now()
    await page.navigate(url, 120000)
    await page.waitForExpression(
      `!!(window.__ppHandles?.getState && !document.querySelector('.loading-overlay'))`,
      { timeoutMs: 120000 }
    )
    const loadMs = Date.now() - loadStart
    await page.evaluate(PROBE_SCRIPT)
    if (item.setup) await page.evaluate(item.setup)
    if (item.params.ship) {
      await page.waitForExpression(`!!window.__ship`, { timeoutMs: 20000 }).catch(() => {
        throw new Error('Ship mode never stepped (no window.__ship): did ?ship=1 enter ship mode?')
      })
    }
    await sleep(item.settleMs * config.settleScale)
    const visibility = await page.evaluate('document.visibilityState')
    if (visibility !== 'visible') throw new Error(`Page is ${visibility}; rAF would not run (is the screen on and the tab in front?)`)

    if (item.beforeSample) await page.evaluate(item.beforeSample)
    log(`  sampling ${config.durationMs} ms`)
    const sample = await page.evaluate(`window.__ppProbe.sample(${config.durationMs})`, {
      timeoutMs: config.durationMs + 30000,
    })
    const refreshHz = config.refreshHz ?? device.info.displayFps
    const frames = summariseFrames(sample.deltas, refreshHz ? 1000 / refreshHz : undefined)
    const gpu = sample.gpuMs.length ? summariseFrames(sample.gpuMs) : null

    log(`  tracing ${config.traceMs} ms`)
    const { trace, traceFrames } = await captureTrace(connection, page)
    const traceSummary = summariseTrace(trace, { urlFragment: '/tides/', frames: traceFrames })
    if (config.keepTrace) {
      fs.writeFileSync(path.join(config.out ?? os.tmpdir(), `trace-${item.key}-${Date.now()}.json`), JSON.stringify(trace))
    }

    log(`  profiling ${config.profileMs} ms`)
    const profile = await captureProfile(page)

    const replay = await page.evaluate(`window.__ppProbe.replay(${config.replayK}, 7)`, { timeoutMs: 120000 })

    const result = {
      url,
      loadMs,
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
    await page.close()
  }
}

async function captureTrace(connection, page) {
  const events = []
  const offData = connection.on('Tracing.dataCollected', ({ value }) => events.push(...value))
  await connection.send('Tracing.start', {
    traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: 'recordAsMuchAsPossible' },
    transferMode: 'ReportEvents',
  })
  let traceFrames
  try {
    const sample = await page.evaluate(`window.__ppProbe.sample(${config.traceMs})`, { timeoutMs: config.traceMs + 30000 })
    traceFrames = sample.deltas.length
  } finally {
    const complete = connection.waitFor('Tracing.tracingComplete', undefined, 120000)
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

async function startServer() {
  const vite = path.join(REPO, 'node_modules/.bin/vite')
  const configFile = path.join(HERE, 'vite.config.mjs')
  const dist = path.join(HERE, '.dist')
  if (config.serve === 'build') {
    log('building (vite build with the harness hooks)…')
    await runToEnd(vite, ['build', '--config', configFile, '--outDir', dist, '--emptyOutDir'], { cwd: REPO })
  }
  const args =
    config.serve === 'build'
      ? ['preview', '--config', configFile, '--outDir', dist, '--port', String(config.vitePort), '--strictPort', '--host']
      : ['--config', configFile, '--port', String(config.vitePort), '--strictPort', '--host']
  const server = spawn(vite, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(server)
  let output = ''
  server.stdout.on('data', (d) => (output += d))
  server.stderr.on('data', (d) => (output += d))
  const url = `http://localhost:${config.vitePort}/tides/`
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited (${server.exitCode}):\n${output}`)
    if (await fetch(url).then((r) => r.ok).catch(() => false)) {
      log(`serving ${url} (${config.serve})`)
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

async function openPhone() {
  const serial = adb.pickSerial(await adb.adb(null, "devices", "-l"), env.ADB_SERIAL ?? env.ANDROID_SERIAL)
  log(`phone: ${serial}`)
  const prepared = await adb.prepareDevice(serial, { cdpPort: config.cdpPort, vitePort: config.vitePort })
  const info = { kind: 'phone', serial, ...(await adb.deviceInfo(serial)), thermalAtStart: await adb.readThermal(serial) }
  log(`  ${info.model}, Android ${info.android}, Chrome ${info.chrome}, battery ${info.battery}%, ${adb.thermalLine(info.thermalAtStart)}`)
  return {
    serial,
    info,
    close: () => adb.releaseDevice(serial, { cdpPort: config.cdpPort, vitePort: config.vitePort, stayOn: prepared.stayOn }),
  }
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
      try {
        const [holder, at] = fs.readFileSync(owner, 'utf8').split(' ')
        if (Date.now() - Number(at) > staleMs) fs.rmSync(lock, { recursive: true, force: true })
        else if (Date.now() - waitedSince > 30000) {
          log(`  waiting for GPU lock (held by ${holder})`)
          waitedSince = Date.now()
        }
      } catch {}
      await sleep(500)
    }
  }
  const refresh = setInterval(() => {
    try {
      fs.writeFileSync(owner, `${who} ${Date.now()}`)
    } catch {}
  }, 30000)
  try {
    return await fn()
  } finally {
    clearInterval(refresh)
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

function runToEnd(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} exited ${code}`))))
  })
}

async function gitHead() {
  const { execFileSync } = await import('node:child_process')
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO }).toString().trim()
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return null
  }
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : '–')
const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '–')

function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill()
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}

main().then(
  () => {
    cleanup()
    process.exit(0)
  }
).catch((error) => {
  console.error(error.stack ?? error.message)
  cleanup()
  process.exit(1)
})
