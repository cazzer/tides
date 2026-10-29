import { create } from 'zustand'
import type { Object3D } from 'three'
import type { SkyLook } from './sky-look'
import { enterShipPatch, exitShipPatch, type ShipSaved } from './ship/ship-session'
import { resetShipInput } from './ship/ship-input'
import { resetShipTelemetry, setShipTarget } from './ship/ship-telemetry'
import { MOON_KEYS, isMoonKey, type MoonKey } from './moons/moon-keys'
import {
  demoPlayScale,
  enterDemoPatch,
  exitDemoPatch,
  goToDemoStepPatch,
  type DemoRun,
  type DemoSnapshot,
} from './demo/demo-session'
import { findDemo } from './demo/demos'
import type { TravelRun } from './demo/demo-travel'
import { requestMainCameraRestore } from './main-camera-session'
import { prefersReducedMotion } from './ship/reduced-motion'
import { holdRealTime } from './close-zoom-rules'

/** Solar order; each key is also the store slot its mesh ref registers under. */
export const PLANET_FOCUS_KEYS = [
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const
export type PlanetFocus = (typeof PLANET_FOCUS_KEYS)[number]

export const FOCUS_VALUES = [
  'clock',
  'earth',
  'sun',
  'moon',
  'location',
  ...PLANET_FOCUS_KEYS,
  // The major moons (tides-2hv.8): focused by tapping one or ?focus=titan,
  // and kept out of the menu.
  ...MOON_KEYS,
] as const
export type CameraFocus = (typeof FOCUS_VALUES)[number]
/** Foci that are a body's mesh ref; 'location' is a point on Earth instead. */
export type BodyFocus = Exclude<CameraFocus, 'location'>

export function isPlanetFocus(focus: string): focus is PlanetFocus {
  return (PLANET_FOCUS_KEYS as readonly string[]).includes(focus)
}

/** A body drawn only with the planets on: a planet or one of their moons. */
export function isSystemFocus(focus: string): focus is PlanetFocus | MoonKey {
  return isPlanetFocus(focus) || isMoonKey(focus)
}

/** Planet and moon keys only count while the planets are shown. */
export function parseFocus(
  value: string | null,
  showPlanets: boolean
): CameraFocus | null {
  if (value == null || !(FOCUS_VALUES as readonly string[]).includes(value)) {
    return null
  }
  return !showPlanets && isSystemFocus(value) ? null : (value as CameraFocus)
}
export type PanelKey = 'main' | 'top' | 'bottom'
export type WeatherSource = 'static' | 'real'
export type Layout = 'single' | 'triple'

const SPEED_VALUES = [1, 60 * 60, 60 * 60 * 24, 60 * 60 * 24 * 30] as const

function getInitialTimeScale(): number {
  if (typeof window === 'undefined') return 1
  const speed = new URLSearchParams(window.location.search).get('speed')
  if (speed == null) return 1
  const n = Number(speed)
  // 0 pauses; it has no menu entry, so it is only reachable from the URL.
  if (n === 0) return 0
  return SPEED_VALUES.includes(n as (typeof SPEED_VALUES)[number]) ? n : 1
}

// ?t= takes epoch milliseconds or anything Date.parse accepts (e.g. ISO 8601).
function getInitialTimestamp(): number | null {
  if (typeof window === 'undefined') return null
  const t = new URLSearchParams(window.location.search).get('t')
  if (t == null) return null
  const ms = /^-?\d+$/.test(t) ? Number(t) : Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

function getInitialCameraFocus(): CameraFocus {
  if (typeof window === 'undefined') return 'clock'
  const focus = new URLSearchParams(window.location.search).get('focus')
  return parseFocus(focus, getInitialShowPlanets()) ?? 'clock'
}

function getInitialPanel(): PanelKey {
  if (typeof window === 'undefined') return 'main'
  const panel = new URLSearchParams(window.location.search).get('panel')
  return (panel === 'main' || panel === 'top' || panel === 'bottom')
    ? panel
    : 'main'
}

// Real weather is the default (tides-6e8); ?weather=static opts out.
function getInitialWeatherSource(): WeatherSource {
  if (typeof window === 'undefined') return 'real'
  const weather = new URLSearchParams(window.location.search).get('weather')
  return weather === 'static' ? 'static' : 'real'
}

function getInitialLayout(): Layout {
  if (typeof window === 'undefined') return 'triple'
  const layout = new URLSearchParams(window.location.search).get('layout')
  return layout === 'single' ? 'single' : 'triple'
}

function getInitialShowPlanets(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('planets') === '1'
}

function getInitialShipMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('ship') === '1'
}

function getInitialShowConstellations(): boolean {
  if (typeof window === 'undefined') return false
  return parseConstellations(new URLSearchParams(window.location.search).get('constellations')).lines
}

/** `?constellations=1` is the stick figures; `art` adds the line-art figures. */
export function parseConstellations(param: string | null) {
  return { lines: param === '1' || param === 'art', art: param === 'art' }
}

function getInitialShowConstellationArt(): boolean {
  if (typeof window === 'undefined') return false
  return parseConstellations(new URLSearchParams(window.location.search).get('constellations')).art
}

function getInitialShowLunar(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('lunar') === '1'
}

function getInitialShowZodiac(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('zodiac') === '1'
}

/**
 * Spatial aids in the system view (tides-2hv): orbit lines, the ecliptic grid,
 * body labels, the belts, the scale readout and motion trails. Each aid's own
 * bead decides how it looks; this only says whether it is on.
 */
export const SYSTEM_AID_KEYS = [
  'orbits',
  'grid',
  'labels',
  'belts',
  'scale',
  'trails',
] as const
export type SystemAidKey = (typeof SYSTEM_AID_KEYS)[number]
export type SystemAids = Record<SystemAidKey, boolean>

// Trails are the only busy aid, so they start off; keeping the others subtle
// is each aid's job.
export const DEFAULT_SYSTEM_AIDS: Readonly<SystemAids> = {
  orbits: true,
  grid: true,
  labels: true,
  belts: true,
  scale: true,
  trails: false,
}

/**
 * `?aids=` lists the aids that are on, comma-separated (`aids=orbits,grid`);
 * an empty value turns them all off. No param means the defaults, and unknown
 * names are ignored.
 *
 * Caveat: the param lists only what is on, so an aid key added later reads as
 * off in an older shared link that carries `aids=`, whatever its default.
 */
export function parseSystemAids(param: string | null): SystemAids {
  if (param == null) return { ...DEFAULT_SYSTEM_AIDS }
  const on = new Set(param.split(','))
  return Object.fromEntries(
    SYSTEM_AID_KEYS.map((key) => [key, on.has(key)])
  ) as SystemAids
}

/** The `?aids=` value, or null when the aids are the defaults (no param). */
export function serializeSystemAids(aids: SystemAids): string | null {
  const isDefault = SYSTEM_AID_KEYS.every(
    (key) => aids[key] === DEFAULT_SYSTEM_AIDS[key]
  )
  if (isDefault) return null
  return SYSTEM_AID_KEYS.filter((key) => aids[key]).join(',')
}

function getInitialSystemAids(): SystemAids {
  if (typeof window === 'undefined') return { ...DEFAULT_SYSTEM_AIDS }
  return parseSystemAids(new URLSearchParams(window.location.search).get('aids'))
}

import { truncateLatLon } from './utils'

export type Location = { lat: number; lon: number }

function getInitialLocation(): Location | null {
  if (typeof window === 'undefined') return null
  const p = new URLSearchParams(window.location.search)
  const lat = p.get('lat')
  const lon = p.get('lon')
  if (lat == null || lon == null) return null
  const latN = parseFloat(lat)
  const lonN = parseFloat(lon)
  if (Number.isFinite(latN) && Number.isFinite(lonN) && latN >= -90 && latN <= 90 && lonN >= -180 && lonN <= 180) {
    return { lat: truncateLatLon(latN), lon: truncateLatLon(lonN) }
  }
  return null
}

export const useStore = create<{
  earth: any
  moon: any
  sun: any
  clock: any
  locationPin: any
  earthRadius: number | undefined
  timeScale: number
  /** The main view's eye is below Earth's close-zoom barrier (close-zoom.ts):
   * time runs no faster than real time there. */
  closeZoom: boolean
  /** In close zoom, the eye is low enough for the streamed surface tiles
   * (close-zoom-rules.ts isTileRange, tides-tvr.7.2). */
  closeZoomTiles: boolean
  /** Bumped each time close zoom holds time at real time, for a brief cue. */
  realTimeCue: number
  initialTimestamp: number | null
  /** Simulation time (epoch ms), written every frame by SimClock. Read it
   * with useStore.getState() inside useFrame; selecting it re-renders per frame. */
  timestamp: number | null
  cameraFocus: CameraFocus
  mainPanel: PanelKey
  /** 'real' shows NASA GIBS clouds for the sim date where imagery exists (tides-l3s). */
  weatherSource: WeatherSource
  layout: Layout
  showPlanets: boolean
  /** Major constellation stick figures, drawn in View from Earth only. */
  showConstellations: boolean
  /** Line-art figures under the stick figures (tides-sie); only drawn with them. */
  showConstellationArt: boolean
  /** Moon-phase and zodiac rings around the month ring (tides-28u). */
  showLunar: boolean
  showZodiac: boolean
  /** System-view aids; their controls show only while the planets are on. */
  systemAids: SystemAids
  location: Location | null
  /** Where View from Earth looks; null until dragged, facing the equator.
   * Written per pointer move: read it with getState() inside useFrame. */
  skyLook: SkyLook | null
  /** View from Earth's vertical field of view (degrees) while zoomed in;
   * null at the default SURFACE_FOV. Not in the URL, like skyLook. */
  skyFov: number | null
  /** Compass mode (tides-d5j): skyLook follows the phone's orientation.
   * Not in the URL; a look-around drag or double tap turns it off. */
  compass: boolean
  /** First-person ship mode (tides-3bl) fills the screen in place of the panels. */
  shipMode: boolean
  /** The view ship mode overrode, restored on exit; null outside it. */
  shipSaved: ShipSaved | null
  enterShip: () => void
  exitShip: () => void
  /** The demo running (tides-zec.5) and its step; null outside one. Demos
   * start only from the menu, never from the URL or on load. */
  demo: DemoRun | null
  /** The view the demo overrode, restored on exit; null outside one. */
  demoSaved: DemoSnapshot | null
  /** The clock travelling to a step's date; null otherwise. */
  demoTravel: TravelRun | null
  startDemo: (id: string) => void
  goToDemoStep: (index: number) => void
  exitDemo: () => void
  /** Play pauses the clock, or runs it at the step's speed. */
  toggleDemoPlaying: () => void
  setPlanet: Function
  setEarthRadius: (radius: number | undefined) => void
  setTimeScale: (value: number) => void
  setCloseZoom: (closeZoom: boolean) => void
  setCloseZoomTiles: (closeZoomTiles: boolean) => void
  setCameraFocus: (focus: CameraFocus) => void
  setMainPanel: (panel: PanelKey) => void
  setWeatherSource: (weatherSource: WeatherSource) => void
  setLayout: (layout: Layout) => void
  setShowPlanets: (showPlanets: boolean) => void
  setShowConstellations: (showConstellations: boolean) => void
  setShowConstellationArt: (showConstellationArt: boolean) => void
  setShowLunar: (showLunar: boolean) => void
  setShowZodiac: (showZodiac: boolean) => void
  setSystemAid: (key: SystemAidKey, on: boolean) => void
  setLocation: (location: Location | null) => void
  jumpDate: Date | null
  jumpDateSetAt: Date | null
  setJumpDate: (date: Date | null) => void
} & Partial<Record<PlanetFocus | MoonKey, { current: Object3D | null }>>>((set, get) => ({
  earth: undefined,
  moon: undefined,
  sun: undefined,
  clock: undefined,
  locationPin: undefined,
  earthRadius: undefined,
  timeScale: getInitialTimeScale(),
  closeZoom: false,
  closeZoomTiles: false,
  realTimeCue: 0,
  initialTimestamp: getInitialTimestamp(),
  timestamp: null,
  cameraFocus: getInitialCameraFocus(),
  mainPanel: getInitialPanel(),
  weatherSource: getInitialWeatherSource(),
  layout: getInitialLayout(),
  showPlanets: getInitialShowPlanets(),
  showConstellations: getInitialShowConstellations(),
  showConstellationArt: getInitialShowConstellationArt(),
  showLunar: getInitialShowLunar(),
  showZodiac: getInitialShowZodiac(),
  systemAids: getInitialSystemAids(),
  location: getInitialLocation(),
  skyLook: null,
  skyFov: null,
  compass: false,
  shipMode: false,
  shipSaved: null,
  enterShip: () => {
    if (get().demo) return
    const patch = enterShipPatch(get())
    if (!patch) return
    resetShipInput()
    set(patch)
  },
  exitShip: () => {
    const patch = exitShipPatch(get())
    if (!patch) return
    resetShipInput()
    resetShipTelemetry()
    setShipTarget(null)
    set(patch)
  },
  demo: null,
  demoSaved: null,
  demoTravel: null,
  startDemo: (id: string) => {
    const demo = findDemo(id)
    const patch = demo && enterDemoPatch(get(), demo)
    if (patch) set(patch)
  },
  goToDemoStep: (index: number) => {
    const run = get().demo
    const demo = run && findDemo(run.id)
    const patch = demo && goToDemoStepPatch(get(), demo, index, prefersReducedMotion())
    if (patch) set(patch)
  },
  exitDemo: () => {
    const patch = exitDemoPatch(get())
    if (!patch) return
    requestMainCameraRestore()
    set(patch)
  },
  toggleDemoPlaying: () => {
    const s = get()
    const demo = s.demo && findDemo(s.demo.id)
    if (!demo) return
    set({ timeScale: s.timeScale !== 0 ? 0 : demoPlayScale(s, demo) })
  },
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setEarthRadius: (earthRadius: number | undefined) => set({ earthRadius }),
  // In close zoom a faster speed is refused, with the cue; time stays as it is.
  // A demo owns the clock, so its steps' speeds hold even in close zoom.
  setTimeScale: (timeScale: number) =>
    set((s) =>
      holdRealTime(timeScale, s.closeZoom && !s.demo).cue
        ? { realTimeCue: s.realTimeCue + 1 }
        : { timeScale }
    ),
  // Entering close zoom faster than real time drops to it, with the cue,
  // outside a demo.
  setCloseZoom: (closeZoom: boolean) =>
    set((s) => {
      if (closeZoom === s.closeZoom) return s
      if (!closeZoom || s.demo) return { closeZoom }
      const { timeScale, cue } = holdRealTime(s.timeScale, true)
      return cue
        ? { closeZoom, timeScale, realTimeCue: s.realTimeCue + 1 }
        : { closeZoom }
    }),
  setCloseZoomTiles: (closeZoomTiles: boolean) =>
    set((s) => (closeZoomTiles === s.closeZoomTiles ? s : { closeZoomTiles })),
  setCameraFocus: (cameraFocus: CameraFocus) => set({ cameraFocus }),
  setMainPanel: (mainPanel: PanelKey) => set({ mainPanel }),
  setWeatherSource: (weatherSource: WeatherSource) => set({ weatherSource }),
  setLayout: (layout: Layout) => set({ layout }),
  setShowPlanets: (showPlanets: boolean) =>
    set((s) => ({
      showPlanets,
      cameraFocus: !showPlanets && isSystemFocus(s.cameraFocus) ? 'sun' : s.cameraFocus,
    })),
  setShowConstellations: (showConstellations: boolean) => set({ showConstellations }),
  setShowConstellationArt: (showConstellationArt: boolean) => set({ showConstellationArt }),
  setShowLunar: (showLunar: boolean) => set({ showLunar }),
  setShowZodiac: (showZodiac: boolean) => set({ showZodiac }),
  setSystemAid: (key: SystemAidKey, on: boolean) =>
    set((s) => ({ systemAids: { ...s.systemAids, [key]: on } })),
  setLocation: (location: Location | null) =>
    set((s) => ({
      location,
      cameraFocus: location === null && s.cameraFocus === 'location' ? 'earth' : s.cameraFocus,
    })),
  jumpDate: null,
  jumpDateSetAt: null,
  setJumpDate: (date: Date | null) =>
    set(date ? { jumpDate: date, jumpDateSetAt: new Date() } : { jumpDate: null }),
}))

// Before the first render, so a ?ship=1 link never flashes the panels.
if (getInitialShipMode()) useStore.getState().enterShip()
