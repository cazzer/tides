import { create } from 'zustand'

export type CameraFocus = 'clock' | 'earth' | 'sun' | 'moon' | 'location'
export type PanelKey = 'main' | 'top' | 'bottom'

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
  return (focus === 'clock' || focus === 'earth' || focus === 'sun' || focus === 'moon' || focus === 'location')
    ? focus
    : 'clock'
}

function getInitialPanel(): PanelKey {
  if (typeof window === 'undefined') return 'main'
  const panel = new URLSearchParams(window.location.search).get('panel')
  return (panel === 'main' || panel === 'top' || panel === 'bottom')
    ? panel
    : 'main'
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
  location: Location | null
  setPlanet: Function
  setEarthRadius: (radius: number | undefined) => void
  setTimeScale: (value: number) => void
  setCameraFocus: (focus: CameraFocus) => void
  setMainPanel: (panel: PanelKey) => void
  setLocation: (location: Location | null) => void
  jumpDate: Date | null
  jumpDateSetAt: Date | null
  setJumpDate: (date: Date | null) => void
}>((set) => ({
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
  location: getInitialLocation(),
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setEarthRadius: (earthRadius: number | undefined) => set({ earthRadius }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
  setCameraFocus: (cameraFocus: CameraFocus) => set({ cameraFocus }),
  setMainPanel: (mainPanel: PanelKey) => set({ mainPanel }),
  setLocation: (location: Location | null) =>
    set((s) => ({
      location,
      cameraFocus: location === null && s.cameraFocus === 'location' ? 'earth' : s.cameraFocus,
    })),
  jumpDate: null,
  jumpDateSetAt: null,
  setJumpDate: (date: Date | null) =>
    set({ jumpDate: date, jumpDateSetAt: new Date() }),
}))
