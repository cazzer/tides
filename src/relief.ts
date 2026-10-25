// Earth's relief exaggeration (tides-zmw.6), chosen at load: ?relief=<factor>
// in the URL, the multiple of true scale the ground is drawn at (25 if absent
// or unreadable, the exaggeration the scene was tuned at). It scales
// TERRAIN_DISPLACEMENT (./cloud-layer.ts), from which everything that follows
// the ground derives (the mesh, its slopes and shadows, the cloud layer and
// its ceiling, the shells, the ship's floor), so a reload moves them together.
// Clamped to [1, 25]: above 25 the highest stop outgrows the limb sphere's
// MORPH_FLOOR (renderers/groundDisplacement.ts). A worker has no location and
// takes the default: the cloud worker uses only the DEM's units, which don't
// depend on it, so pass the relief along if it ever needs more.

export const DEFAULT_RELIEF = 25
export const MIN_RELIEF = 1
export const MAX_RELIEF = DEFAULT_RELIEF

export function parseRelief(search: string): number {
  const raw = new URLSearchParams(search).get('relief')
  if (raw === null || raw.trim() === '') return DEFAULT_RELIEF
  const value = Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_RELIEF
  return Math.min(MAX_RELIEF, Math.max(MIN_RELIEF, value))
}

/** This page's relief; the default outside a browser. */
export const RELIEF = typeof location === 'undefined' ? DEFAULT_RELIEF : parseRelief(location.search)

/** RELIEF over the default: 1 unless ?relief= says otherwise. */
export const RELIEF_SCALE = RELIEF / DEFAULT_RELIEF
