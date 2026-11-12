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
/** Where a page answers for its own load (isLoadAlive). */
export const LIVENESS_CHANNEL = 'tides.exit'
/** How long a duplicated tab waits for the page whose heartbeat it copied. */
export const LIVENESS_MS = 250
/**
 * An in-place reload after a kill comes within seconds; an older heartbeat
 * is a restored session or a long-closed tab, worth the console alone.
 */
export const NOTICE_MAX_S = 60

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

/** The snapshot's fields are missing before the canvas mounts, or where reading them threw. */
export interface Heartbeat extends Partial<ExitSnapshot> {
  v: 1
  /** The page load that wrote it (a duplicated tab copies it). */
  loadId: string
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
    typeof r.loadId === 'string' &&
    typeof r.t === 'number' &&
    Number.isFinite(r.t) &&
    typeof r.state === 'string' &&
    STATES.includes(r.state)
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

/**
 * A foreground kill whose page still answers (`isAlive`) wasn't one: this tab
 * is a duplicate, and copied the live page's heartbeat with its sessionStorage.
 */
export async function settleExit(
  result: ExitResult,
  isAlive: (loadId: string) => Promise<boolean>
): Promise<ExitResult> {
  if (result.kind !== 'foreground' || !result.record) return result
  return (await isAlive(result.record.loadId)) ? { kind: 'none' } : result
}

/** Whether the on-page notice shows: a recent foreground kill. */
export function showsNotice(result: ExitResult | null): boolean {
  return (
    result?.kind === 'foreground' &&
    result.secondsSince != null &&
    result.secondsSince < NOTICE_MAX_S
  )
}

const fixed = (n: number, digits: number) => (Number.isFinite(n) ? n.toFixed(digits) : String(n))

/** An unclean exit's last heartbeat as label and value pairs; empty for none or clean. */
export function exitDetails(result: ExitResult): [string, string][] {
  const r = result.record
  if (!r || (result.kind !== 'foreground' && result.kind !== 'background')) return []
  const details: [string, string][] = [
    ['last heartbeat', `${result.secondsSince} s before this load, page ${r.state}`],
    ['build', `${r.sha}, up ${r.uptimeS} s, ${r.navType}`],
  ]
  const { view, pose, mem, canvas } = r
  if (!view || !mem || !canvas) {
    details.push(['snapshot', 'none (before the canvas, or reading it failed)'])
    return details
  }
  const heap =
    mem.jsHeapMB != null ? `, JS heap ${mem.jsHeapMB}${mem.jsLimitMB != null ? `/${mem.jsLimitMB}` : ''} MB` : ''
  details.push(
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
    ['dpr', `${r.dpr}, canvas ${canvas[0]}×${canvas[1]}`],
    ['GL', `${mem.textures} textures, ${mem.geometries} geometries, ${mem.programs} programs${heap}`],
    ['context lost', r.ctxLost ? 'yes' : 'no']
  )
  return details
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

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ExitWatchOptions {
  storage: KeyStore | null
  doc: EventTarget & { visibilityState: DocumentVisibilityState }
  win: EventTarget
  /** Wall clock, epoch ms. */
  now: () => number
  /** The page's state; null before there is one (the canvas not mounted). */
  snapshot: () => ExitSnapshot | null
  loadId: string
  sha: string
  navType: string
  /** When the page started, epoch ms; now() by default. */
  startedAt?: number
  /** For each write's cost. */
  perfNow?: () => number
}

/**
 * Writes the heartbeat every HEARTBEAT_MS while the page is visible: 'hidden'
 * (and no more writes) once it hides, 'clean' on pagehide, 'visible' again
 * when it shows or comes back from the back-forward cache. A snapshot that
 * throws leaves a record without its fields; the first storage failure
 * removes the record and turns the watch off. Returns the stop.
 */
export function createExitWatch({
  storage,
  doc,
  win,
  now,
  snapshot,
  loadId,
  sha,
  navType,
  startedAt = now(),
  perfNow = () => performance.now(),
}: ExitWatchOptions): () => void {
  if (storage == null) {
    console.info('[exit] heartbeat off: storage unavailable')
    return () => {}
  }
  const store = storage
  let timer: ReturnType<typeof setInterval> | null = null
  let off = false
  let snapshotWarned = false
  let lastWriteMs = 0
  // From pagehide until the page shows again: unloading fires
  // visibilitychange to hidden after pagehide, which must not overwrite 'clean'.
  let exited = false

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  const read = (): ExitSnapshot | null => {
    try {
      return snapshot()
    } catch (error) {
      if (!snapshotWarned) console.warn('[exit] heartbeat snapshot failed', error)
      snapshotWarned = true
      return null
    }
  }

  const write = (state: HeartbeatState) => {
    if (off) return
    const start = perfNow()
    const t = now()
    const record: Heartbeat = {
      v: 1,
      loadId,
      sha,
      t,
      uptimeS: Math.round((t - startedAt) / 1000),
      state,
      navType,
      ...read(),
      writeMs: lastWriteMs,
    }
    try {
      store.setItem(HEARTBEAT_KEY, JSON.stringify(record))
    } catch (error) {
      // A stale 'visible' left behind would read as a kill.
      try {
        store.removeItem(HEARTBEAT_KEY)
      } catch {
        // Nothing more to do: the store is gone.
      }
      off = true
      stopTimer()
      console.info('[exit] heartbeat off: storage unavailable', error)
      return
    }
    lastWriteMs = Math.round((perfNow() - start) * 1000) / 1000
  }

  const startTimer = () => {
    if (off || timer !== null) return
    timer = setInterval(() => write('visible'), HEARTBEAT_MS)
  }

  const show = () => {
    exited = false
    write('visible')
    startTimer()
  }
  const hide = () => {
    stopTimer()
    if (!exited) write('hidden')
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? hide() : show())
  const onPageHide = () => {
    stopTimer()
    write('clean')
    exited = true
  }
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return
    if (doc.visibilityState === 'hidden') {
      exited = false
      write('hidden')
    } else {
      show()
    }
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

interface ChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}
export type ChannelCtor = new (name: string) => ChannelLike

const defaultChannel = (): ChannelCtor | undefined =>
  typeof BroadcastChannel === 'function' ? (BroadcastChannel as unknown as ChannelCtor) : undefined

const isMessage = (data: unknown, type: 'ping' | 'pong', loadId: string) =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === type &&
  (data as { loadId?: unknown }).loadId === loadId

/** Answers isLoadAlive for `loadId` on LIVENESS_CHANNEL. Returns the stop. */
export function answerPings(loadId: string, Channel: ChannelCtor | undefined = defaultChannel()): () => void {
  if (!Channel) return () => {}
  let channel: ChannelLike
  try {
    channel = new Channel(LIVENESS_CHANNEL)
  } catch {
    return () => {}
  }
  channel.onmessage = (event) => {
    if (isMessage(event.data, 'ping', loadId)) channel.postMessage({ type: 'pong', loadId })
  }
  return () => channel.close()
}

/**
 * Whether a page of this origin answers for `loadId` within `timeoutMs`;
 * false without BroadcastChannel.
 */
export function isLoadAlive(
  loadId: string,
  { Channel = defaultChannel(), timeoutMs = LIVENESS_MS }: { Channel?: ChannelCtor; timeoutMs?: number } = {}
): Promise<boolean> {
  if (!Channel) return Promise.resolve(false)
  let channel: ChannelLike
  try {
    channel = new Channel(LIVENESS_CHANNEL)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const done = (alive: boolean) => {
      clearTimeout(timer)
      channel.onmessage = null
      channel.close()
      resolve(alive)
    }
    channel.onmessage = (event) => {
      if (isMessage(event.data, 'pong', loadId)) done(true)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    channel.postMessage({ type: 'ping', loadId })
  })
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

const newLoadId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

// Across a dev module reload (HMR) the page is the same load: the report it
// read stays, and it isn't read again from this load's own heartbeat.
interface HotData {
  loadId?: string
  startedAt?: number
  settled?: ExitResult | null
  dismissed?: boolean
  watched?: Camera | null
  source?: (() => ExitSnapshot) | null
}
const hotData: HotData = (import.meta.hot?.data as HotData | undefined) ?? {}

export const LOAD_ID = hotData.loadId ?? newLoadId()
const startedAt = hotData.startedAt ?? Date.now()
let settled: ExitResult | null = hotData.settled ?? null
let dismissed = hotData.dismissed ?? false
let watched: Camera | null = hotData.watched ?? null
let source: (() => ExitSnapshot) | null = hotData.source ?? null
const listeners = new Set<() => void>()

/** The last load's exit, once settled (a duplicated tab's checked) and until dismissed; else null. */
export function currentExitReport(): ExitResult | null {
  return dismissed ? null : settled
}

export function subscribeExitReport(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const notify = () => listeners.forEach((listener) => listener())

export function dismissExitReport(): void {
  if (dismissed) return
  dismissed = true
  notify()
}

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

/** The heartbeat's snapshot (renderers/ExitWatch.tsx, once the canvas is up). Returns the unregister. */
export function setExitSnapshot(snapshot: () => ExitSnapshot): () => void {
  source = snapshot
  return () => {
    if (source === snapshot) source = null
  }
}

function readLastExit(): ExitResult {
  let raw: string | null = null
  try {
    raw = sessionStore()?.getItem(HEARTBEAT_KEY) ?? null
  } catch {
    raw = null
  }
  return classifyExit(raw, Date.now())
}

// At import, before this load's first heartbeat overwrites the last load's.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const stopAnswering = answerPings(LOAD_ID)
  if (!settled) {
    void settleExit(readLastExit(), (loadId) => isLoadAlive(loadId)).then((result) => {
      settled = result
      const line = describeExit(result)
      if (line) console.warn(`[exit] ${line}; this load ${navigationType()}`)
      notify()
    })
  }
  const stopWatch = createExitWatch({
    storage: sessionStore(),
    doc: document,
    win: window,
    now: Date.now,
    snapshot: () => source?.() ?? null,
    loadId: LOAD_ID,
    sha: __BUILD_SHA__,
    navType: navigationType(),
    startedAt,
  })
  import.meta.hot?.dispose((data: HotData) => {
    stopWatch()
    stopAnswering()
    Object.assign(data, { loadId: LOAD_ID, startedAt, settled, dismissed, watched, source })
  })
}
