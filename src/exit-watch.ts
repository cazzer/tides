import { Vector3, type Camera, type Object3D } from 'three'
import { earthLatLon } from './surface-ground'

// Unclean exits (tides-8h7.4): iOS reloads a tab in place when it kills its
// WebContent process, and the page gets no event. A heartbeat in
// sessionStorage, which WebKit keeps outside that process, says on the next
// load in the tab whether the last one ended cleanly (pagehide) or not, and
// where the camera was. Nothing leaves the device.

export const HEARTBEAT_KEY = 'tides.exit.heartbeat'
/** Run on a timer, not the frame loop, so the idle cap (IdleRate) can't stall it. */
export const HEARTBEAT_MS = 2000

const EARTH_KM = 6371
const RAD = 180 / Math.PI

export type HeartbeatState = 'visible' | 'hidden' | 'clean'

/** Where the eye is over Earth. */
export interface GeoPose {
  latDeg: number
  lonDeg: number
  /** Over the sphere, scaled to Earth's 6371 km. */
  altKm: number
  /** 0 looking straight down at Earth's centre, 90 at the horizon. */
  tiltDeg: number
}

export interface ExitView {
  focus: string
  closeZoom: boolean
  closeZoomTiles: boolean
  ship: boolean
  /** The running demo's id. */
  demo: string | null
}

/** What the page reads for each heartbeat. */
export interface ExitSnapshot {
  view: ExitView
  pose: GeoPose | null
  dpr: number
  /** The drawing buffer, device pixels. */
  canvas: [number, number]
  mem: {
    textures: number
    geometries: number
    programs: number
    jsHeapMB?: number
    jsLimitMB?: number
  }
  ctxLost: boolean
}

export interface Heartbeat extends ExitSnapshot {
  v: 1
  sha: string
  /** Wall clock, epoch ms. */
  t: number
  uptimeS: number
  state: HeartbeatState
  /** The navigation type of the load that wrote it. */
  navType: string
  /** The previous write's cost. */
  writeMs: number
}

export type ExitKind = 'none' | 'clean' | 'foreground' | 'background'

export interface ExitResult {
  kind: ExitKind
  record?: Heartbeat
  secondsSince?: number
}

const STATES: readonly string[] = ['visible', 'hidden', 'clean']

function isHeartbeat(value: unknown): value is Heartbeat {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<Heartbeat>
  return (
    r.v === 1 &&
    typeof r.t === 'number' &&
    Number.isFinite(r.t) &&
    typeof r.state === 'string' &&
    STATES.includes(r.state) &&
    typeof r.view === 'object' &&
    r.view !== null &&
    typeof r.mem === 'object' &&
    r.mem !== null &&
    Array.isArray(r.canvas)
  )
}

/**
 * The last load's heartbeat (`raw`, as stored) read at `nowMs`: none, a clean
 * exit, or a kill while the page was in the foreground or the background.
 */
export function classifyExit(raw: string | null, nowMs: number): ExitResult {
  if (raw == null) return { kind: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'none' }
  }
  if (!isHeartbeat(parsed)) return { kind: 'none' }
  const kind: ExitKind =
    parsed.state === 'clean' ? 'clean' : parsed.state === 'hidden' ? 'background' : 'foreground'
  return { kind, record: parsed, secondsSince: Math.round((nowMs - parsed.t) / 100) / 10 }
}

const fixed = (n: number, digits: number) => (Number.isFinite(n) ? n.toFixed(digits) : String(n))

/** An unclean exit's last heartbeat as label and value pairs; empty for none or clean. */
export function exitDetails(result: ExitResult): [string, string][] {
  const r = result.record
  if (!r || (result.kind !== 'foreground' && result.kind !== 'background')) return []
  const { view, pose, mem } = r
  const heap =
    mem.jsHeapMB != null ? `, JS heap ${mem.jsHeapMB}${mem.jsLimitMB != null ? `/${mem.jsLimitMB}` : ''} MB` : ''
  return [
    ['last heartbeat', `${result.secondsSince} s before this load, page ${r.state}`],
    ['build', `${r.sha}, up ${r.uptimeS} s, ${r.navType}`],
    [
      'view',
      `focus ${view.focus}, close zoom ${view.closeZoom ? 'on' : 'off'}` +
        `${view.closeZoomTiles ? ' (tiles)' : ''}${view.ship ? ', ship' : ''}${view.demo ? `, demo ${view.demo}` : ''}`,
    ],
    [
      'pose',
      pose
        ? `${fixed(pose.latDeg, 3)}°, ${fixed(pose.lonDeg, 3)}°, ${fixed(pose.altKm, 2)} km, tilt ${fixed(pose.tiltDeg, 1)}°`
        : 'none',
    ],
    ['dpr', `${r.dpr}, canvas ${r.canvas[0]}×${r.canvas[1]}`],
    ['GL', `${mem.textures} textures, ${mem.geometries} geometries, ${mem.programs} programs${heap}`],
    ['context lost', r.ctxLost ? 'yes' : 'no'],
  ]
}

/** One line for the console; null for none or clean. */
export function describeExit(result: ExitResult): string | null {
  const details = exitDetails(result)
  if (details.length === 0) return null
  return `unclean exit (${result.kind}): ${details.map(([k, v]) => `${k} ${v}`).join('; ')}`
}

const _centre = new Vector3()
const _local = new Vector3()
const _toCentre = new Vector3()
const _look = new Vector3()

/**
 * The eye at `eye` (world) looking along `lookDir`, over `earth` (whose local
 * frame earthLatLon reads) of scene radius `earthRadius`; null where it has no
 * meaning.
 */
export function geoPose(eye: Vector3, lookDir: Vector3, earth: Object3D, earthRadius: number): GeoPose | null {
  earth.getWorldPosition(_centre)
  const r = eye.distanceTo(_centre)
  if (!(r > 0) || !(earthRadius > 0)) return null
  const [lat, lon] = earthLatLon(earth.worldToLocal(_local.copy(eye)).normalize())
  _toCentre.subVectors(_centre, eye).normalize()
  _look.copy(lookDir).normalize()
  const cos = Math.min(1, Math.max(-1, _look.dot(_toCentre)))
  return {
    latDeg: lat * RAD,
    lonDeg: lon * RAD,
    altKm: (r / earthRadius - 1) * EARTH_KM,
    tiltDeg: Math.acos(cos) * RAD,
  }
}

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

export interface ExitWatchOptions {
  storage: KeyStore | null
  doc: EventTarget & { visibilityState: DocumentVisibilityState }
  win: EventTarget
  /** Wall clock, epoch ms. */
  now: () => number
  snapshot: () => ExitSnapshot
  sha: string
  navType: string
  /** For each write's cost. */
  perfNow?: () => number
}

/**
 * Writes the heartbeat every HEARTBEAT_MS while the page is visible: 'hidden'
 * (and no more writes) once it hides, 'clean' on pagehide, 'visible' again
 * when it shows or comes back from the back-forward cache. The first storage
 * failure turns it off. Returns the stop.
 */
export function createExitWatch({
  storage,
  doc,
  win,
  now,
  snapshot,
  sha,
  navType,
  perfNow = () => performance.now(),
}: ExitWatchOptions): () => void {
  const startedAt = now()
  let timer: ReturnType<typeof setInterval> | null = null
  let off = storage == null
  let lastWriteMs = 0
  // From pagehide until a back-forward cache restore: unloading fires
  // visibilitychange after pagehide, which must not overwrite 'clean'.
  let exited = false

  const disable = (error: unknown) => {
    off = true
    stopTimer()
    console.info('[exit] heartbeat off: storage unavailable', error)
  }
  if (off) {
    console.info('[exit] heartbeat off: storage unavailable')
    return () => {}
  }

  const write = (state: HeartbeatState) => {
    if (off) return
    const start = perfNow()
    try {
      const t = now()
      const record: Heartbeat = {
        v: 1,
        sha,
        t,
        uptimeS: Math.round((t - startedAt) / 1000),
        state,
        navType,
        ...snapshot(),
        writeMs: lastWriteMs,
      }
      storage!.setItem(HEARTBEAT_KEY, JSON.stringify(record))
    } catch (error) {
      disable(error)
      return
    }
    lastWriteMs = Math.round((perfNow() - start) * 1000) / 1000
  }

  function stopTimer() {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  const startTimer = () => {
    if (off || timer !== null) return
    timer = setInterval(() => write('visible'), HEARTBEAT_MS)
  }

  const show = () => {
    write('visible')
    startTimer()
  }
  const hide = () => {
    stopTimer()
    write('hidden')
  }
  const onVisibility = () => {
    if (exited) return
    if (doc.visibilityState === 'hidden') hide()
    else show()
  }
  const onPageHide = () => {
    stopTimer()
    write('clean')
    exited = true
  }
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return
    exited = false
    if (doc.visibilityState === 'hidden') write('hidden')
    else show()
  }

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pagehide', onPageHide)
  win.addEventListener('pageshow', onPageShow)
  if (doc.visibilityState === 'hidden') write('hidden')
  else show()

  return () => {
    stopTimer()
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('pagehide', onPageHide)
    win.removeEventListener('pageshow', onPageShow)
  }
}

/** This tab's sessionStorage, or null where reaching it throws. */
export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** This load's navigation type ('navigate', 'reload', 'back_forward', ...). */
export function navigationType(): string {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return entry?.type ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

let report: ExitResult | null = null
let dismissed = false
const listeners = new Set<() => void>()

/**
 * The last load's exit, read once per page (before this load's first
 * heartbeat, so a StrictMode remount never reads its own), and logged.
 */
export function loadExitReport(): ExitResult {
  if (report) return report
  let raw: string | null = null
  try {
    raw = sessionStore()?.getItem(HEARTBEAT_KEY) ?? null
  } catch {
    raw = null
  }
  report = classifyExit(raw, Date.now())
  const line = describeExit(report)
  if (line) console.warn(`[exit] ${line}; this load ${navigationType()}`)
  return report
}

/** The last load's exit until dismissed, then null. */
export function currentExitReport(): ExitResult | null {
  return dismissed ? null : loadExitReport()
}

export function subscribeExitReport(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dismissExitReport(): void {
  if (dismissed) return
  dismissed = true
  listeners.forEach((listener) => listener())
}

let watched: Camera | null = null

/** The camera the heartbeat reads the pose from. Returns the unregister. */
export function watchCamera(camera: Camera): () => void {
  watched = camera
  return () => {
    if (watched === camera) watched = null
  }
}

export function watchedCamera(): Camera | null {
  return watched
}

// Read at import, before anything mounts.
if (typeof window !== 'undefined') loadExitReport()
