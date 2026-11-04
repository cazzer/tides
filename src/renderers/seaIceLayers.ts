// The date's sea ice for the ground's shaders (tides-5oz, tides-6ru.2):
// NSIDC's 2025 grids (../demo/sea-ice.ts) in two spare layers of the sea's
// texture array (./waterClimate.ts waterSeaTexture()), which the globe's
// ground and the streamed tiles already bind for the water: neither program
// has a texture unit to spare (the tiles' 16 of 16). The globe's ground
// reads them through ./seaIceGround.ts, the tiles through
// ./surface/tile-ice.ts, both with SEA_ICE_TAP_GLSL and seaIceOver's maths,
// so the two draw the same ice where they meet. The layers are there on
// every tier: the low tier's globe draws the ice too.
//
// Layer SEA_ICE_LAYER.north holds the north grid and .south the south's, each
// in the layer's corner, a texel a cell (the grids' 304x448 and 316x332 fit
// in 512²; the rest stays 0, and the tap reads no ice off its grid: the
// array repeats, so a read past the corner would wrap onto the grid):
//   R  the cover on frame a, G on frame b (the weekly frames either side of
//      the date; the shader blends them by seaIceSurface.mix), rewritten when
//      the frames change and a tile or the ground that may hold ice draws;
//   B  the sea: the mask's red (the shipped elevation map's 0 m) at the cell,
//      the most of it over the cell and its 8 neighbours, so the sea reaches
//      a cell past every coast and the ground's own elevation (0 m) draws
//      the coastline;
//   A  the day map's all-year ice (the mask's green), the mean over the cell
//      and its 8 neighbours, so the repainted open water fades in over a cell.
// B and A don't change with the date: built once, in idle time, on the first
// attach (attachSeaIce), with a 1° grid of where any frame holds ice or the
// day map paints it over the sea, which gates the tiles (regionMayHoldIce):
// a tile wholly elsewhere skips the ice's taps.
import { whenIdle } from '../ship/limb-detail'
import * as THREE from 'three'
import { gridLatLon, ICE_SRGB, MASK_NORTH_ROWS, MASK_PER_DEG, maskRow, NORTH_GRID, OCEAN_SRGB, SEA_ICE_GRID_GLSL, SOUTH_GRID, type IceGrid, type PolarGrid, type SeaIce, type SeaIceMask } from '../demo/sea-ice'
import { waterSeaTexture } from './waterClimate'
import { NOISE_SIZE } from './waterNoise'

/** The sea texture's layers that hold the grids. */
export const SEA_ICE_LAYER = { north: 2, south: 3 } as const

/** The texels per layer row (the layers' side). */
export const SEA_ICE_LAYER_SIZE = NOISE_SIZE

/** The gate's cells per degree, and its size (row 0 at the North Pole, column 0 at 180°W). */
const GATE_COLS = 360
const GATE_ROWS = 180

export interface SeaIceSurface {
  /** 1 while the ice is attached, its layers built and the date's frames
   * written (at the first draw of a tile or the ground that may hold ice),
   * else 0. */
  on: THREE.IUniform<number>
  /** How far from frame a (R) to frame b (G). */
  mix: THREE.IUniform<number>
  /** 1 while the globe's ground draws the ice (./seaIceGround.ts): outside
   * the seasons tour, and in it under the shell as the shell fades out
   * (../demo/SeaIceGlobe.tsx). */
  ground: THREE.IUniform<number>
  /** Bumped when the gate changes: tiles then re-read regionMayHoldIce. */
  revision: number
}

export const seaIceSurface: SeaIceSurface = { on: { value: 0 }, mix: { value: 0 }, ground: { value: 0 }, revision: 0 }

const f = (x: number) => x.toFixed(6)

/** The grid's sea (B) over which the ice may lie: a cell past the coast. */
export const ICE_SEA = [0.2, 0.6] as const

/** |elevation| (m) over which the ground stops being the sea: the tiles'
 * glint's GLINT_SEA_LEVEL (./surface/tile-glint.ts; a test holds them
 * equal), not imported, so the globe's chunk doesn't take the tiles'. */
export const ICE_SEA_LEVEL = [0.25, 0.75] as const

const linear = (srgb: readonly number[]) => new THREE.Color().setRGB(srgb[0], srgb[1], srgb[2], THREE.SRGBColorSpace)

/** The ice's and the repainted sea's colours, linear, as the shell's uniforms take them. */
export const ICE_LINEAR = linear(ICE_SRGB)
export const OCEAN_LINEAR = linear(OCEAN_SRGB)

const glslColour = (c: THREE.Color) => `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`

/** The head SEA_ICE_TAP_GLSL needs, before main(): the grids' cells. */
export const SEA_ICE_TAP_HEAD = SEA_ICE_GRID_GLSL('seaIceCells')

/**
 * Statements for main() that set `vec4 seaIceTexel` to the layers' texel at
 * the unit direction `up` (a GLSL variable, the Earth's frame): the north's
 * grid above the equator, the south's below, at level 0 (25 km cells: never
 * minified near the ground, and the 1-cell sea and all-year ice need the
 * cell's own value), and vec4(0) off the grid, where the repeating array
 * would wrap onto it. Needs SEA_ICE_TAP_HEAD and uWaterSea declared.
 */
export function SEA_ICE_TAP_GLSL(up: string): string {
  const size = (grid: PolarGrid) => `vec2(${f(grid.width)}, ${f(grid.height)})`
  return /* glsl */ `
vec4 seaIceTexel = vec4(0.0);
{
  bool seaIceNorth = ${up}.y >= 0.0;
  vec2 seaIceAt = seaIceCells(${up});
  vec2 seaIceSize = seaIceNorth ? ${size(NORTH_GRID)} : ${size(SOUTH_GRID)};
  if (all(greaterThanEqual(seaIceAt, vec2(0.0))) && all(lessThanEqual(seaIceAt, seaIceSize))) {
    seaIceTexel = textureLod(uWaterSea, vec3(seaIceAt / ${f(SEA_ICE_LAYER_SIZE)},
      seaIceNorth ? ${f(SEA_ICE_LAYER.north)} : ${f(SEA_ICE_LAYER.south)}), 0.0);
  }
}
`
}

/**
 * Statements for main(), after SEA_ICE_TAP_GLSL, that set the globals
 * `seaIceAlpha` (the ice's or the repainted sea's share of the albedo) and
 * `seaIceShare` (the ice's share of its colour) for ground `elevation` (a
 * GLSL float, metres) and the blend uSeaIceMix, as seaIceOver.
 */
export const SEA_ICE_OVER_GLSL = (elevation: string) => /* glsl */ `
{
  float seaIceCover = mix(seaIceTexel.r, seaIceTexel.g, uSeaIceMix);
  float seaIceAny = max(seaIceCover, seaIceTexel.a);
  float seaIceSea = (1.0 - smoothstep(${f(ICE_SEA_LEVEL[0])}, ${f(ICE_SEA_LEVEL[1])}, abs(${elevation})))
    * smoothstep(${f(ICE_SEA[0])}, ${f(ICE_SEA[1])}, seaIceTexel.b);
  seaIceAlpha = seaIceSea * seaIceAny;
  seaIceShare = seaIceCover / max(seaIceAny, 1e-3);
}
`

/** The albedo the ice lays over the ground (by seaIceAlpha), from seaIceShare. */
export const SEA_ICE_ALBEDO_GLSL = `mix(${glslColour(OCEAN_LINEAR)}, ${glslColour(ICE_LINEAR)}, seaIceShare)`

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * The GLSL's alpha and colour (linear) for a texel of the layers (0..1
 * channels), the blend `mix` and ground at `elevation` metres, while on.
 */
export function seaIceOver(texel: readonly number[], mix: number, elevation: number): { alpha: number; albedo: THREE.Color } {
  const [r, g, b, a] = texel
  const cover = r + (g - r) * mix
  const sea = (1 - smoothstep(ICE_SEA_LEVEL[0], ICE_SEA_LEVEL[1], Math.abs(elevation))) * smoothstep(ICE_SEA[0], ICE_SEA[1], b)
  const any = Math.max(cover, a)
  return { alpha: sea * any, albedo: OCEAN_LINEAR.clone().lerp(ICE_LINEAR, cover / Math.max(any, 1e-3)) }
}

interface Attached {
  ice: SeaIce
  mask: SeaIceMask
  users: number
  cancel: (() => void) | null
}

let attached: Attached | null = null
// What the layers' B and A and the gate were built from.
let builtFrom: { ice: SeaIce; mask: SeaIceMask } | null = null
let gate: Uint8Array | null = null
// Whether B, A and the gate are the attached data's.
let layersReady = false
// The frames the date wants (showSeaIceFrames) and the ones in R and G.
const wanted = { a: -1, b: -1 }
// Whether the globe shows the ice now (the shell visible): the tiles draw it
// only while it does.
let globeShows = false
const shown = { a: -1, b: -1 }
// Whether the renderer has uploaded the array once: until it has, a layer
// update would upload only those layers (three's texSubImage3D per layer
// into fresh storage), so the whole array goes instead.
let uploaded = false
let uploadHooked = false

function hookUpload(texture: THREE.DataArrayTexture) {
  if (uploadHooked) return
  uploadHooked = true
  // three passes the texture, which its types leave out.
  type OnUpdate = ((texture: THREE.Texture) => void) | null
  const previous = texture.onUpdate as OnUpdate
  const onUpdate: OnUpdate = (t) => {
    uploaded = true
    previous?.(t)
  }
  texture.onUpdate = onUpdate as () => void
}

/**
 * After the context is lost: the restored context has no storage for the
 * array, so its next upload must be the whole of it (the layers hold every
 * channel on the CPU), not just the changed layers.
 */
export function resetSeaIceUpload(): void {
  uploaded = false
  const texture = waterSeaTexture()
  texture.layerUpdates.clear()
  texture.needsUpdate = true
}

function markLayers(texture: THREE.DataArrayTexture) {
  hookUpload(texture)
  if (uploaded) {
    texture.addLayerUpdate(SEA_ICE_LAYER.north)
    texture.addLayerUpdate(SEA_ICE_LAYER.south)
  }
  texture.needsUpdate = true
}

const layerOffset = (layer: number) => layer * SEA_ICE_LAYER_SIZE * SEA_ICE_LAYER_SIZE * 4

/** The mask's red and green (0..1) at (lat, lon) degrees, bilinear within its band, into `out`. */
function maskAt(mask: SeaIceMask, lat: number, lon: number, out: number[]) {
  out[0] = out[1] = 0
  const r = maskRow(lat)
  if (r < 0) return out
  const [top, bottom] = r < MASK_NORTH_ROWS ? [0, MASK_NORTH_ROWS - 1] : [MASK_NORTH_ROWS, mask.height - 1]
  const y = Math.min(Math.max(r - 0.5, top), bottom)
  const y0 = Math.floor(y)
  const y1 = Math.min(y0 + 1, bottom)
  const fy = y - y0
  const x = (lon + 180) * MASK_PER_DEG - 0.5
  const xf = Math.floor(x)
  const fx = x - xf
  const x0 = ((xf % mask.width) + mask.width) % mask.width
  const x1 = (x0 + 1) % mask.width
  for (let c = 0; c < 2; c++) {
    const at = (cx: number, cy: number) => mask.rg[2 * (cy * mask.width + cx) + c]
    const upper = at(x0, y0) * (1 - fx) + at(x1, y0) * fx
    const lower = at(x0, y1) * (1 - fx) + at(x1, y1) * fx
    out[c] = (upper * (1 - fy) + lower * fy) / 255
  }
  return out
}

interface GridBuild {
  grid: PolarGrid
  /** Each cell's place (deg) and the mask there (0..1). */
  lat: Float32Array
  lon: Float32Array
  maskSea: Float32Array
  maskIce: Float32Array
  /** B and A, 0-255, a cell each. */
  sea: Uint8Array
  allYear: Uint8Array
}

function gridBuild(grid: PolarGrid): GridBuild {
  const n = grid.width * grid.height
  const floats = () => new Float32Array(n)
  return { grid, lat: floats(), lon: floats(), maskSea: floats(), maskIce: floats(), sea: new Uint8Array(n), allYear: new Uint8Array(n) }
}

/** The places of rows [from, to) of a grid's cells and the mask there. */
function sampleRows(build: GridBuild, mask: SeaIceMask, from: number, to: number) {
  const { grid, lat, lon, maskSea, maskIce } = build
  const at = { lat: 0, lon: 0 }
  const rg = [0, 0]
  for (let row = from; row < to; row++) {
    for (let col = 0; col < grid.width; col++) {
      const i = row * grid.width + col
      gridLatLon(grid, col + 0.5, row + 0.5, at)
      lat[i] = at.lat
      lon[i] = at.lon
      maskAt(mask, at.lat, at.lon, rg)
      maskSea[i] = rg[0]
      maskIce[i] = rg[1]
    }
  }
}

/** A grid's B and A, once its rows are sampled, into its layer of `data`. */
function writeStatic(build: GridBuild, data: Uint8Array, layer: number) {
  const { grid, maskSea: sea, maskIce: ice, sea: outSea, allYear: outIce } = build
  const { width, height } = grid
  const base = layerOffset(layer)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let most = 0
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        const y = row + dy
        if (y < 0 || y >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const x = col + dx
          if (x < 0 || x >= width) continue
          const j = y * width + x
          most = Math.max(most, sea[j])
          sum += ice[j]
          count++
        }
      }
      const i = row * width + col
      outSea[i] = Math.round(most * 255)
      outIce[i] = Math.round((sum / count) * 255)
      const o = base + (row * SEA_ICE_LAYER_SIZE + col) * 4
      data[o + 2] = outSea[i]
      data[o + 3] = outIce[i]
    }
  }
}

/** Marks into `cells` (the gate) every 1° cell a grid cell holding ice in any frame, or all-year ice, over the sea covers. */
function gateGrid(grid: IceGrid, built: GridBuild, cells: Uint8Array) {
  const n = grid.width * grid.height
  const most = new Uint8Array(n)
  for (const frame of grid.frames) for (let i = 0; i < n; i++) if (frame[i] > most[i]) most[i] = frame[i]
  // A grid cell's half-width, in degrees of latitude.
  const half = (0.6 * NORTH_GRID.cell) / 111_195
  for (let i = 0; i < n; i++) {
    if (built.sea[i] === 0 || (most[i] === 0 && built.allYear[i] === 0)) continue
    const lat = built.lat[i]
    const lon = built.lon[i]
    const halfLon = Math.min(180, half / Math.max(Math.cos((lat * Math.PI) / 180), 1e-6))
    const r0 = Math.max(Math.floor(90 - lat - half), 0)
    const r1 = Math.min(Math.floor(90 - lat + half), GATE_ROWS - 1)
    const c0 = Math.floor(lon + 180 - halfLon)
    const c1 = Math.floor(lon + 180 + halfLon)
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * GATE_COLS + (((c % GATE_COLS) + GATE_COLS) % GATE_COLS)] = 1
  }
}

// Rows of a grid sampled per step.
const ROWS_PER_STEP = 64

// The build's steps, one per idle callback, each a few ms (the whole is
// ~50 ms in Chrome on an M4 Pro: too long for one frame).
function buildSteps(ice: SeaIce, mask: SeaIceMask): (() => void)[] {
  const data = waterSeaTexture().image.data as Uint8Array
  const cells = new Uint8Array(GATE_COLS * GATE_ROWS)
  const steps: (() => void)[] = []
  for (const [grid, frames, layer] of [
    [NORTH_GRID, ice.north, SEA_ICE_LAYER.north],
    [SOUTH_GRID, ice.south, SEA_ICE_LAYER.south],
  ] as const) {
    const build = gridBuild(grid)
    for (let row = 0; row < grid.height; row += ROWS_PER_STEP) {
      steps.push(() => sampleRows(build, mask, row, Math.min(row + ROWS_PER_STEP, grid.height)))
    }
    steps.push(() => writeStatic(build, data, layer))
    steps.push(() => gateGrid(frames, build, cells))
  }
  steps.push(() => {
    gate = cells
    builtFrom = { ice, mask }
  })
  return steps
}

function start(entry: Attached) {
  const ready = () => {
    // R and G are the old data's (or none): rewritten at the next draw.
    shown.a = shown.b = -1
    markLayers(waterSeaTexture())
    seaIceSurface.revision++
    layersReady = true
    entry.cancel = null
  }
  if (builtFrom?.ice === entry.ice && builtFrom.mask === entry.mask) {
    ready()
    return
  }
  // The layers are rewritten from here on: not the old data's any more.
  builtFrom = null
  const steps = buildSteps(entry.ice, entry.mask)
  const next = () => {
    entry.cancel = whenIdle(() => {
      steps.shift()!()
      if (steps.length) next()
      else ready()
    })
  }
  next()
}

/**
 * Lays `ice` on the tiles (with `mask`, the globe's sea and all-year ice)
 * while anything holds it: the layers' static channels and the gate build in
 * idle time, then the first tile that may hold ice to draw writes the
 * date's frames (uploadSeaIceFrames) and turns the tiles' ice on. Returns the release; at the last
 * release the tiles drop the ice (on 0).
 */
export function attachSeaIce(ice: SeaIce, mask: SeaIceMask): () => void {
  if (attached && attached.ice === ice && attached.mask === mask) {
    attached.users++
  } else {
    attached?.cancel?.()
    seaIceSurface.on.value = 0
    layersReady = false
    attached = { ice, mask, users: 1, cancel: null }
    start(attached)
  }
  const entry = attached
  let released = false
  return () => {
    if (released || attached !== entry) return
    released = true
    if (--entry.users > 0) return
    entry.cancel?.()
    attached = null
    layersReady = false
    globeShows = false
    seaIceSurface.on.value = 0
  }
}

/**
 * The date's frames of the attached `ice` (../demo/sea-ice.ts seaIceFrames),
 * every frame the globe shows the ice: the blend at once, the frames into R
 * and G at the next draw of a tile that may hold ice (uploadSeaIceFrames).
 * `null` while the globe doesn't show it (the shell hidden): the tiles drop
 * it at once (on 0) until frames come again, so they never show ice the
 * globe doesn't.
 */
export function showSeaIceFrames(ice: SeaIce, frames: { a: number; b: number; mix: number } | null): void {
  if (attached?.ice !== ice) return
  globeShows = frames !== null
  if (!frames) {
    seaIceSurface.on.value = 0
    return
  }
  seaIceSurface.mix.value = frames.mix
  wanted.a = frames.a
  wanted.b = frames.b
}

/**
 * Writes the wanted frames into R and G if they aren't there, and marks the
 * two layers for upload; from the first, the tiles draw the ice (on 1). Called as a tile that may hold ice draws (before
 * three binds its textures), so the ~2 MB upload happens only in frames
 * that read it: none while no tile draws (above the handover, or off the
 * ice), and only when a weekly frame changes.
 */
export function uploadSeaIceFrames(): void {
  if (!attached || !layersReady || !globeShows || wanted.a < 0) return
  seaIceSurface.on.value = 1
  if (wanted.a === shown.a && wanted.b === shown.b) return
  const { ice } = attached
  const data = waterSeaTexture().image.data as Uint8Array
  const write = (grid: IceGrid, layer: number) => {
    const a = grid.frames[wanted.a]
    const b = grid.frames[wanted.b]
    const base = layerOffset(layer)
    for (let row = 0; row < grid.height; row++) {
      let o = base + row * SEA_ICE_LAYER_SIZE * 4
      let i = row * grid.width
      for (let col = 0; col < grid.width; col++, o += 4, i++) {
        data[o] = a[i]
        data[o + 1] = b[i]
      }
    }
  }
  write(ice.north, SEA_ICE_LAYER.north)
  write(ice.south, SEA_ICE_LAYER.south)
  shown.a = wanted.a
  shown.b = wanted.b
  markLayers(waterSeaTexture())
}

/**
 * Whether a tile over `region` ([west, south, east, north], radians, as the
 * tiles' bounding regions) may draw sea ice: any gate cell over it, one
 * cell wider round it. True until the gate is built.
 */
export function regionMayHoldIce(region: readonly number[]): boolean {
  if (!gate) return true
  const deg = 180 / Math.PI
  const [west, south, east, north] = region.map((r) => r * deg)
  const c0 = Math.floor(west + 180) - 1
  const c1 = Math.floor(east + (east < west ? 360 : 0) + 180) + 1
  const r0 = Math.max(Math.floor(90 - north) - 1, 0)
  const r1 = Math.min(Math.floor(90 - south) + 1, GATE_ROWS - 1)
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) if (gate[r * GATE_COLS + (((c % GATE_COLS) + GATE_COLS) % GATE_COLS)]) return true
  return false
}
