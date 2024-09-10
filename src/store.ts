import { create } from 'zustand'

export const useStore = create<{
  earth: any
  moon: any
  clock: any
  timeScale: number
  setPlanet: Function
  setTimeScale: Function
}>((set) => ({
  earth: undefined,
  moon: undefined,
  clock: undefined,
  timeScale: 1, // one millisecond per millisecond
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
}))
