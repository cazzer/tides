// Which sources the streamed surface (tides-zmw.9.1) is drawing from right
// now, for the in-flight credits line (tides-zmw.9.9): Mapterhorn's terrain
// under every tile, USGS imagery on tiles wholly inside the US boxes, EOX's
// Sentinel-2 cloudless elsewhere (imagery.ts picks the same way). Pure: the
// scene feeds in what is visible, the line reads what comes out.
import { boundsInsideUsgs, boundsTouchUsgs } from './imagery'

export type SurfaceSource = 'mapterhorn' | 'usgs' | 'eox'

const ORDER: readonly SurfaceSource[] = ['mapterhorn', 'usgs', 'eox']

/** Wording the sources ask for; also listed in settings (Credits.tsx). */
export const EOX_CREDIT =
  'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020)'
export const USGS_CREDIT = 'USGS The National Map'

/** What the in-flight line says for each source (see creditLine). */
export const SOURCE_TEXT: Record<SurfaceSource, string> = {
  mapterhorn: 'Terrain \u00a9 Mapterhorn',
  usgs: 'Imagery USGS',
  eox: EOX_CREDIT,
}

/** The in-flight line for the active sources, as short as it can say it. */
export function creditLine(sources: readonly SurfaceSource[]): string {
  return sources.map((s) => SOURCE_TEXT[s]).join(' \u00b7 ')
}

/** A tile footprint in radians, as a 3D Tiles region volume gives it. */
export interface RadianBounds {
  west: number
  south: number
  east: number
  north: number
}

const DEG = 180 / Math.PI

/**
 * The sources for a terrain tile with this footprint: its terrain, and the
 * imagery draped over it. The imagery is chosen per overlay tile, which can
 * be finer than the terrain tile, so a footprint that straddles a US box
 * names both: USGS where it touches a box, EOX unless it sits wholly inside
 * one. (Open water inside a box falls back to EOX by status, uncredited.)
 */
export function sourcesForTile(b: RadianBounds): SurfaceSource[] {
  const deg = { west: b.west * DEG, south: b.south * DEG, east: b.east * DEG, north: b.north * DEG }
  const sources: SurfaceSource[] = ['mapterhorn']
  if (boundsTouchUsgs(deg)) sources.push('usgs')
  if (!boundsInsideUsgs(deg)) sources.push('eox')
  return sources
}

/** Metres, the tileset's sphere (surface-frame.ts SURFACE_ELLIPSOID_RADIUS). */
const R = 6371000
/** Slack for relief standing past the sea-level horizon: Everest's height's worth of arc, in radians. */
const HORIZON_SLACK = Math.acos(R / (R + 9000))

/**
 * Whether a tile could be seen from a camera at `camera` (ECEF metres): the
 * tile's visible set is by frustum, and looking down at the ground the cone
 * runs on through the planet, so far-side tiles are "visible" too. A tile
 * counts when its nearest part is inside the camera's horizon.
 */
export function tileOnNearSide(b: RadianBounds, camera: { x: number; y: number; z: number }): boolean {
  const distance = Math.hypot(camera.x, camera.y, camera.z)
  if (distance === 0) return true
  const lat = (b.south + b.north) / 2
  const lon = (b.west + b.east) / 2
  const dot =
    (camera.x * Math.cos(lat) * Math.cos(lon) + camera.y * Math.cos(lat) * Math.sin(lon) + camera.z * Math.sin(lat)) /
    distance
  const away = Math.acos(Math.min(1, Math.max(-1, dot)))
  const horizon = Math.acos(Math.min(1, R / Math.max(distance, R)))
  const radius = Math.hypot((b.north - b.south) / 2, ((b.east - b.west) / 2) * Math.cos(lat))
  return away <= horizon + radius + HORIZON_SLACK
}

/** The footprint of a loaded tile, or null when it has no region (the root). */
export function tileRadianBounds(tile: unknown): RadianBounds | null {
  const volume = (tile as { boundingVolume?: { region?: number[]; cartographicRange?: number[] } }).boundingVolume
  const r = volume?.region ?? volume?.cartographicRange
  if (!r || r.length < 4) return null
  return { west: r[0], south: r[1], east: r[2], north: r[3] }
}

/**
 * The sources on screen, held `lingerMs` after the last tile that used one
 * leaves view: panning between tiles (or over a USGS edge) never flickers the
 * line, and it clears a moment after the last tile goes.
 */
export class ActiveSources {
  private lastSeen = new Map<SurfaceSource, number>()
  private current: readonly SurfaceSource[] = []
  constructor(private readonly lingerMs = 2000) {}

  /** Returns the same array while the set is unchanged, so a store can compare by identity. */
  update(visible: Iterable<SurfaceSource>, nowMs: number): readonly SurfaceSource[] {
    for (const source of visible) this.lastSeen.set(source, nowMs)
    const next = ORDER.filter((s) => {
      const seen = this.lastSeen.get(s)
      return seen !== undefined && nowMs - seen <= this.lingerMs
    })
    if (next.length !== this.current.length || next.some((s, i) => s !== this.current[i])) this.current = next
    return this.current
  }
}
