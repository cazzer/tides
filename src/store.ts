import { create } from 'zustand'

export const useStore = create<{
  earth: any
  moon: any
  clock: any
  timeScale: number
  setPlanet: Function
  setTimeScale: (value: number) => void
  jumpDate: Date | null
  jumpDateSetAt: Date | null
  setJumpDate: (date: Date) => void
}>((set) => ({
  earth: undefined,
  moon: undefined,
  clock: undefined,
  timeScale: 1, // one millisecond per millisecond
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
  jumpDate: null,
  jumpDateSetAt: null,
  setJumpDate: (date: Date) =>
    set({ jumpDate: date, jumpDateSetAt: new Date() }),
}))
