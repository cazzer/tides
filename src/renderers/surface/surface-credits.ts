// The sources the surface is drawing now (credit-sources.ts), shared between
// SurfaceTiles, which writes it from its frame loop, and the HUD's credits
// line, which reads it. Empty with ?surface=0 or on the low tier, outside ship mode and while
// no tile shows, so the line has nothing to draw there.
import type { SurfaceSource } from './credit-sources'

let active: readonly SurfaceSource[] = []
const listeners = new Set<() => void>()

export function setActiveSurfaceSources(next: readonly SurfaceSource[]): void {
  if (next === active) return
  active = next
  listeners.forEach((l) => l())
}

export function subscribeSurfaceSources(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getActiveSurfaceSources = (): readonly SurfaceSource[] => active
