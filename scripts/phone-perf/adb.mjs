// adb plumbing for the phone target: device pick, port plumbing, screen,
// and thermal state.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function adb(serial, ...args) {
  const full = serial ? ['-s', serial, ...args] : args
  const { stdout } = await run('adb', full, { timeout: 30000 })
  return stdout
}

// Picks the device: ADB_SERIAL if set, else the only attached one. The same
// phone can be listed twice (an ip:port and an mDNS _adb-tls-connect entry);
// both reach one device, so prefer the ip:port form.
export function pickSerial(devicesOutput, wanted) {
  const serials = devicesOutput
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial, , ...rest]) => ({ serial, model: rest.find((r) => r.startsWith('model:')) }))
  if (wanted) {
    if (!serials.some((d) => d.serial === wanted)) {
      throw new Error(`ADB_SERIAL ${wanted} is not attached (have: ${serials.map((d) => d.serial).join(', ') || 'none'})`)
    }
    return wanted
  }
  const models = new Set(serials.map((d) => d.model))
  if (serials.length === 0) throw new Error('No adb device attached')
  if (models.size > 1) {
    throw new Error(`Several adb devices attached; set ADB_SERIAL (${serials.map((d) => d.serial).join(', ')})`)
  }
  return (serials.find((d) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(d.serial)) ?? serials[0]).serial
}

const TEMPERATURE_TYPES = { 0: 'cpu', 1: 'gpu', 2: 'battery', 3: 'skin' }

// Parses `dumpsys thermalservice`: the overall status (0 none .. 6 shutdown)
// and the hottest sensor of each type, preferring live HAL readings over the
// cached ones.
export function parseThermal(text) {
  const status = Number(/Thermal Status:\s*(\d+)/.exec(text)?.[1] ?? NaN)
  const section = (title) => {
    const start = text.indexOf(title)
    if (start < 0) return ''
    const rest = text.slice(start + title.length)
    const end = rest.search(/\n\S/)
    return end < 0 ? rest : rest.slice(0, end)
  }
  const block = section('Current temperatures from HAL:') || section('Cached temperatures:')
  const maxima = {}
  for (const match of block.matchAll(/mValue=([-\d.]+),\s*mType=(\d+),\s*mName=([^,}]+)/g)) {
    const type = TEMPERATURE_TYPES[match[2]]
    const value = Number(match[1])
    if (!type || !Number.isFinite(value)) continue
    if (maxima[type] === undefined || value > maxima[type].c) {
      maxima[type] = { c: value, sensor: match[3].trim() }
    }
  }
  return { status: Number.isFinite(status) ? status : null, ...maxima }
}

export async function readThermal(serial) {
  return parseThermal(await adb(serial, 'shell', 'dumpsys', 'thermalservice'))
}

export function thermalLine(t) {
  const part = (k) => (t[k] ? `${k} ${t[k].c.toFixed(1)}°C` : null)
  return [`status ${t.status}`, part('skin'), part('cpu'), part('gpu'), part('battery')]
    .filter(Boolean)
    .join(', ')
}

// Waits until the phone reports no thermal status and its skin (else
// battery) sensor is at or under maxC, polling every 15 s, up to timeoutMs.
// Returns the reading it settled on and how long it waited.
export async function coolDown(serial, { maxC, timeoutMs, log }) {
  const started = Date.now()
  for (;;) {
    const t = await readThermal(serial)
    const probe = t.skin ?? t.battery
    const cool = (t.status ?? 0) === 0 && (!probe || probe.c <= maxC)
    if (cool || Date.now() - started > timeoutMs) {
      return { thermal: t, waitedMs: Date.now() - started, cool }
    }
    log(`  cooling: ${thermalLine(t)} (want status 0, ≤${maxC}°C)`)
    await new Promise((r) => setTimeout(r, 15000))
  }
}

// Keeps the screen on for the run ('stayon usb' only holds while the phone is
// on USB power, and wireless adb may run on battery), and returns the
// previous setting so releaseDevice can put it back.
export async function prepareDevice(serial, { cdpPort, vitePort }) {
  const stayOn = (await adb(serial, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in')).trim()
  await adb(serial, 'shell', 'svc', 'power', 'stayon', 'true')
  await wakeAndUnlock(serial)
  await adb(serial, 'reverse', `tcp:${vitePort}`, `tcp:${vitePort}`)
  await adb(serial, 'forward', `tcp:${cdpPort}`, 'localabstract:chrome_devtools_remote')
  return { stayOn }
}

export async function wakeAndUnlock(serial) {
  const power = await adb(serial, 'shell', 'dumpsys', 'power')
  if (!/mWakefulness=Awake/.test(power)) await adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  // Dismisses a swipe-only keyguard; a PIN or pattern lock needs a person.
  await adb(serial, 'shell', 'wm', 'dismiss-keyguard')
  const window = await adb(serial, 'shell', 'dumpsys', 'window')
  if (/mDreamingLockscreen=true|isKeyguardShowing=true|mShowingLockscreen=true/.test(window)) {
    throw new Error('The phone is locked behind a PIN or pattern; unlock it once by hand')
  }
}

export async function releaseDevice(serial, { cdpPort, vitePort, stayOn }) {
  await adb(serial, 'forward', '--remove', `tcp:${cdpPort}`).catch(() => {})
  await adb(serial, 'reverse', '--remove', `tcp:${vitePort}`).catch(() => {})
  if (/^\d+$/.test(stayOn ?? '')) {
    await adb(serial, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', stayOn).catch(() => {})
  }
}

export async function deviceInfo(serial) {
  const prop = async (name) => (await adb(serial, 'shell', 'getprop', name)).trim()
  const chrome = await adb(serial, 'shell', 'dumpsys', 'package', 'com.android.chrome')
  return {
    model: await prop('ro.product.model'),
    android: await prop('ro.build.version.release'),
    soc: await prop('ro.soc.model').catch(() => ''),
    chrome: /versionName=(\S+)/.exec(chrome)?.[1] ?? null,
    battery: (await adb(serial, 'shell', 'dumpsys', 'battery')).match(/level: (\d+)/)?.[1] ?? null,
    // Samsung: refresh_rate_mode 0 = standard 60 Hz, 1 = adaptive (up to 120 Hz).
    refreshRateMode: (await adb(serial, 'shell', 'settings', 'get', 'secure', 'refresh_rate_mode')).trim(),
    displayFps: await displayFps(serial),
  }
}

// The rate the display renders at now (Samsung adaptive refresh moves it).
export async function displayFps(serial) {
  const dump = await adb(serial, 'shell', 'dumpsys', 'display').catch(() => '')
  return Number(dump.match(/renderFrameRate ([\d.]+)/)?.[1] ?? NaN) || null
}
