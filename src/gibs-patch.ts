// Real imagery under the ship (tides-01v.7): NASA GIBS's Blue Marble Next
// Generation at 500 m, level 7 of the EPSG:4326 "500m" matrix (160x80 tiles
// of 512 px, 2.25 deg each, 81920 px around: about 1 screen px per texel at
// the ship's stop over Earth, where the 10800 px day map shows ~8). A square
// of tiles around the ship's sub-point is streamed into one texture
// (./renderers/gibsPatch.ts); this is the tile bookkeeping. GIBS serves
// these with CORS *, no key and a 3-day max-age.

export const GIBS_GROUND_LAYER = 'BlueMarble_NextGeneration'
export const GIBS_GROUND_LEVEL = 7
export const GIBS_TILE_PX = 512
export const GIBS_COLS = 160
export const GIBS_ROWS = 80
/** Texels around the equator. */
export const GIBS_GROUND_WIDTH = GIBS_COLS * GIBS_TILE_PX

/**
 * How near, in Earth radii from its surface, the ship streams the patch, and
 * how far before it lets it go. At 0.5 R the 10800 day map is already
 * magnified ~1.6x at nadir on a retina screen; at 1 R it is not.
 */
export const GIBS_PATCH_RANGE = 0.5
export const GIBS_PATCH_RELEASE = 1

export function gibsGroundTileUrl(row: number, col: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${GIBS_GROUND_LAYER}/default/500m/${GIBS_GROUND_LEVEL}/${row}/${col}.jpeg`
}

/**
 * The night side's city lights under the ship (tides-tvr.2): VIIRS's 2012
 * composite, the same epoch and grid as the night map (earth-night.jpg
 * registers with it to the texel), on the same level-7 matrix. A single
 * dated layer; GIBS serves it with CORS * and no key, but no-store.
 */
export const GIBS_NIGHT_LAYER = 'VIIRS_CityLights_2012'

export function gibsNightTileUrl(row: number, col: number): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${GIBS_NIGHT_LAYER}/default/2016-01-01/500m/${GIBS_GROUND_LEVEL}/${row}/${col}.jpeg`
}

/**
 * Tiles along the patch's side for a device whose flight maps are capped at
 * `cap` (quality.ts flightTextureCap): 8 (4096 px, 18 deg) on desktops, 4
 * (2048 px, 9 deg, a fifth of the VRAM) on phones and tablets, none where
 * the GPU can't take a 4k texture. Each divides GIBS_COLS, so a tile's slot
 * in the texture stays put across the antimeridian.
 */
export function gibsPatchSide(cap: 8192 | 4096 | null): 8 | 4 | 0 {
  return cap === 8192 ? 8 : cap === 4096 ? 4 : 0
}

export interface GibsTile {
  row: number
  col: number
}

/** The tile under texture coordinate (u, v) of the equirectangular day map
 * (u from the antimeridian eastward, v from the south pole up). */
export function gibsTileAt(u: number, v: number): GibsTile {
  const col = Math.floor((u - Math.floor(u)) * GIBS_COLS) % GIBS_COLS
  const row = Math.min(GIBS_ROWS - 1, Math.max(0, Math.floor((1 - v) * GIBS_ROWS)))
  return { row, col }
}

/** The patch's north-west tile; `col` in 0..GIBS_COLS-1. */
export type GibsPatchOrigin = GibsTile

const wrapCol = (col: number) => ((col % GIBS_COLS) + GIBS_COLS) % GIBS_COLS

/**
 * Where the patch sits for the ship over `tile`: unchanged while the tile is
 * one of the patch's middle two columns and rows, else moved the least that
 * puts it back in them (a tile a step, either way); centred on it at first.
 * Near a pole it stops at the pole rather than run past it.
 */
export function nextGibsPatchOrigin(
  tile: GibsTile,
  side: number,
  current: GibsPatchOrigin | null
): GibsPatchOrigin {
  const half = side / 2
  const rowFor = (row: number) => Math.min(GIBS_ROWS - side, Math.max(0, row))
  if (!current) return { row: rowFor(tile.row - half), col: wrapCol(tile.col - half) }
  // The tile's offset into the patch, columns signed the short way round.
  const dc = wrapCol(tile.col - current.col + GIBS_COLS / 2) - GIBS_COLS / 2
  const dr = tile.row - current.row
  const shift = (d: number) => (d < half - 1 ? d - (half - 1) : d > half ? d - half : 0)
  const col = wrapCol(current.col + shift(dc))
  const row = rowFor(current.row + shift(dr))
  return col === current.col && row === current.row ? current : { row, col }
}

export interface GibsPatchTile extends GibsTile {
  /** Its place in the texture: tiles wrap around it toroidally, so moving
   * the patch a tile only refills one row or column. */
  slot: number
  url: string
}

/** The patch's tiles, nearest `centre` first (the order to fetch them),
 * from the layer `tileUrl` names. */
export function gibsPatchTiles(
  origin: GibsPatchOrigin,
  side: number,
  centre: GibsTile,
  tileUrl: (row: number, col: number) => string = gibsGroundTileUrl
): GibsPatchTile[] {
  const tiles: (GibsPatchTile & { distance: number })[] = []
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const row = origin.row + y
      const col = wrapCol(origin.col + x)
      const dc = Math.abs(wrapCol(col - centre.col + GIBS_COLS / 2) - GIBS_COLS / 2)
      tiles.push({
        row,
        col,
        slot: (row % side) * side + (col % side),
        url: tileUrl(row, col),
        distance: Math.hypot(dc, row - centre.row),
      })
    }
  }
  return tiles.sort((a, b) => a.distance - b.distance).map(({ distance: _, ...tile }) => tile)
}

/**
 * How far, in degrees of arc, the patch reaches from the sub-point: half its
 * side and the tile the ship may stray into before it moves, out to a
 * corner. 15.9 deg for a side of 8, 9.5 for 4.
 */
export function gibsPatchReachDeg(side: number): number {
  return (side / 2 + 1) * (180 / GIBS_ROWS) * Math.SQRT2
}

/**
 * The night patch streams only while some of it can be on the night side:
 * the Sun under NIGHT_PATCH_SUN_DEG (where the city lights start to come
 * on, ../renderers/nightLights.ts) somewhere within its reach of the
 * sub-point. Once streaming it holds NIGHT_PATCH_HOLD_DEG longer, so a ship
 * on the terminator doesn't refill it back and forth.
 */
export const NIGHT_PATCH_SUN_DEG = 3
export const NIGHT_PATCH_HOLD_DEG = 5

/** `sunSin`: sin of the Sun's elevation at the ship's sub-point.
 * `active`: the patch is streaming now. */
export function nightPatchWanted(sunSin: number, side: number, active: boolean): boolean {
  const elevation = (Math.asin(Math.min(1, Math.max(-1, sunSin))) * 180) / Math.PI
  return elevation < NIGHT_PATCH_SUN_DEG + gibsPatchReachDeg(side) + (active ? NIGHT_PATCH_HOLD_DEG : 0)
}

export interface GibsTileStore {
  /** The tile at `url`, from memory if fetched before; rejects on failure
   * (a failure isn't remembered, so a later call tries again). */
  get(url: string): Promise<Blob>
  /** Network requests made so far, for measuring a region's cost. */
  readonly requests: number
}

/**
 * Fetched tiles kept as their JPEG bytes (20-80 KB each, against 1 MB
 * decoded), least recently used dropped past `limit`. The browser's HTTP
 * cache sits behind it across reloads.
 */
export function createGibsTileStore(fetchBlob: (url: string) => Promise<Blob>, limit: number): GibsTileStore {
  const entries = new Map<string, Promise<Blob>>()
  let requests = 0
  return {
    get(url) {
      let entry = entries.get(url)
      if (entry) {
        entries.delete(url)
      } else {
        requests++
        entry = fetchBlob(url)
        entry.catch(() => {
          if (entries.get(url) === entry) entries.delete(url)
        })
      }
      entries.set(url, entry)
      for (const key of entries.keys()) {
        if (entries.size <= limit) break
        entries.delete(key)
      }
      return entry
    },
    get requests() {
      return requests
    },
  }
}
