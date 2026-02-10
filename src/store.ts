import { create } from 'zustand'

export type CameraFocus = 'clock' | 'earth' | 'sun' | 'moon'

function getInitialCameraFocus(): CameraFocus {
  if (typeof window === 'undefined') return 'clock'
  const focus = new URLSearchParams(window.location.search).get('focus')
  return (focus === 'clock' || focus === 'earth' || focus === 'sun' || focus === 'moon')
    ? focus
    : 'clock'
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
  timeScale: number
  cameraFocus: CameraFocus
  location: Location | null
  setPlanet: Function
  setTimeScale: (value: number) => void
  setCameraFocus: (focus: CameraFocus) => void
  setLocation: (location: Location | null) => void
  jumpDate: Date | null
  jumpDateSetAt: Date | null
  setJumpDate: (date: Date) => void
}>((set) => ({
  earth: undefined,
  moon: undefined,
  sun: undefined,
  clock: undefined,
  timeScale: 1,
  cameraFocus: getInitialCameraFocus(),
  location: getInitialLocation(),
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
  setCameraFocus: (cameraFocus: CameraFocus) => set({ cameraFocus }),
  setLocation: (location: Location | null) => set({ location }),
  jumpDate: null,
  jumpDateSetAt: null,
  setJumpDate: (date: Date) =>
    set({ jumpDate: date, jumpDateSetAt: new Date() }),
}))
