import { create } from 'zustand'

export type CameraFocus = 'clock' | 'earth' | 'sun' | 'moon'

function getInitialCameraFocus(): CameraFocus {
  if (typeof window === 'undefined') return 'clock'
  const focus = new URLSearchParams(window.location.search).get('focus')
  return (focus === 'clock' || focus === 'earth' || focus === 'sun' || focus === 'moon')
    ? focus
    : 'clock'
}

export const useStore = create<{
  earth: any
  moon: any
  sun: any
  clock: any
  timeScale: number
  cameraFocus: CameraFocus
  setPlanet: Function
  setTimeScale: (value: number) => void
  setCameraFocus: (focus: CameraFocus) => void
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
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
  setCameraFocus: (cameraFocus: CameraFocus) => set({ cameraFocus }),
  jumpDate: null,
  jumpDateSetAt: null,
  setJumpDate: (date: Date) =>
    set({ jumpDate: date, jumpDateSetAt: new Date() }),
}))
