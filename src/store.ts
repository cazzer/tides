import { create } from 'zustand'
import type { Object3D } from 'three'

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
] as const
export type CameraFocus = (typeof FOCUS_VALUES)[number]
/** Foci that are a body's mesh ref; 'location' is a point on Earth instead. */
export type BodyFocus = Exclude<CameraFocus, 'location'>

export function isPlanetFocus(focus: string): focus is PlanetFocus {
  return (PLANET_FOCUS_KEYS as readonly string[]).includes(focus)
}

/** Planet keys only count while the planets are shown. */
export function parseFocus(
  value: string | null,
  showPlanets: boolean
): CameraFocus | null {
  if (value == null || !(FOCUS_VALUES as readonly string[]).includes(value)) {
    return null
  }
  return !showPlanets && isPlanetFocus(value) ? null : (value as CameraFocus)
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

function getInitialWeatherSource(): WeatherSource {
  if (typeof window === 'undefined') return 'static'
  const weather = new URLSearchParams(window.location.search).get('weather')
  return weather === 'real' ? 'real' : 'static'
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

function getInitialShowConstellations(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('constellations') === '1'
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
  location: Location | null
  setPlanet: Function
  setEarthRadius: (radius: number | undefined) => void
  setTimeScale: (value: number) => void
  setCameraFocus: (focus: CameraFocus) => void
  setMainPanel: (panel: PanelKey) => void
  setWeatherSource: (weatherSource: WeatherSource) => void
  setLayout: (layout: Layout) => void
  setShowPlanets: (showPlanets: boolean) => void
  setShowConstellations: (showConstellations: boolean) => void
  setLocation: (location: Location | null) => void
  jumpDate: Date | null
  jumpDateSetAt: Date | null
  setJumpDate: (date: Date | null) => void
} & Partial<Record<PlanetFocus, { current: Object3D | null }>>>((set) => ({
  earth: undefined,
  moon: undefined,
  sun: undefined,
  clock: undefined,
  locationPin: undefined,
  earthRadius: undefined,
  timeScale: getInitialTimeScale(),
  initialTimestamp: getInitialTimestamp(),
  timestamp: null,
  cameraFocus: getInitialCameraFocus(),
  mainPanel: getInitialPanel(),
  weatherSource: getInitialWeatherSource(),
  layout: getInitialLayout(),
  showPlanets: getInitialShowPlanets(),
  showConstellations: getInitialShowConstellations(),
  location: getInitialLocation(),
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setEarthRadius: (earthRadius: number | undefined) => set({ earthRadius }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
  setCameraFocus: (cameraFocus: CameraFocus) => set({ cameraFocus }),
  setMainPanel: (mainPanel: PanelKey) => set({ mainPanel }),
  setWeatherSource: (weatherSource: WeatherSource) => set({ weatherSource }),
  setLayout: (layout: Layout) => set({ layout }),
  setShowPlanets: (showPlanets: boolean) =>
    set((s) => ({
      showPlanets,
      cameraFocus: !showPlanets && isPlanetFocus(s.cameraFocus) ? 'sun' : s.cameraFocus,
    })),
  setShowConstellations: (showConstellations: boolean) => set({ showConstellations }),
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
