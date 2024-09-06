import { create } from 'zustand'

export const useStore = create((set) => ({
  earth: undefined,
  moon: undefined,
  timeScale: 1, // one millisecond per millisecond
  setPlanet: (name: string, ref: any) => set({ [name]: ref }),
  setTimeScale: (timeScale: number) => set({ timeScale }),
}))
