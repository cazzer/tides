// The seasons tour's sea ice in the sea texture's spare layers (tides-5oz):
// where each grid lands, the date's frames written only when they change and
// a tile draws, the static sea and all-year ice, the tiles' gate, and the
// refcount.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type * as THREE from 'three'
import { gridLatLon, gridPoint, MASK_HEIGHT, MASK_WIDTH, maskRow, NORTH_GRID, unpackSeaIce, type SeaIceMask } from '../demo/sea-ice'
import { shippedSeaIceMask } from './png-rgb-fixture'
import {
  attachSeaIce,
  ICE_LINEAR,
  ICE_SEA_LEVEL,
  OCEAN_LINEAR,
  regionMayHoldIce,
  resetSeaIceUpload,
  SEA_ICE_LAYER,
  SEA_ICE_LAYER_SIZE,
  SEA_ICE_TAP_GLSL,
  seaIceOver,
  seaIceSurface,
  showSeaIceFrames,
  uploadSeaIceFrames,
} from './seaIceLayers'
import { GLINT_SEA_LEVEL } from './surface/tile-glint'
import { waterSeaTexture } from './waterClimate'

const ice = unpackSeaIce(new Uint8Array(gunzipSync(readFileSync('src/assets/sea-ice-2025.bin'))))
const shipped = shippedSeaIceMask()
const sea = waterSeaTexture()
const data = sea.image.data as Uint8Array
const LAYER = SEA_ICE_LAYER_SIZE * SEA_ICE_LAYER_SIZE * 4
const texel = (layer: number, col: number, row: number) => {
  const o = layer * LAYER + (row * SEA_ICE_LAYER_SIZE + col) * 4
  return Array.from(data.subarray(o, o + 4))
}
const deg = (r: number[]) => r.map((d) => (d * Math.PI) / 180)
/** As the renderer does once it has uploaded the array (three passes the texture). */
const uploadedByRenderer = () => (sea.onUpdate as ((t: THREE.Texture) => void) | null)?.(sea)

/** Attaches, and waits for the static build (the revision's bump). */
async function attached(mask: SeaIceMask) {
  const revision = seaIceSurface.revision
  const release = attachSeaIce(ice, mask)
  await vi.waitFor(() => expect(seaIceSurface.revision).toBeGreaterThan(revision), { timeout: 4000, interval: 2 })
  return release
}

/** A mask of sea north of 80°N, the all-year ice north of 85°N. */
function capMask(): SeaIceMask {
  const rg = new Uint8Array(MASK_WIDTH * MASK_HEIGHT * 2)
  for (let row = 0; row < MASK_HEIGHT; row++) {
    const lat = 90 - (row + 0.5) / 10
    if (row >= maskRow(35)) break
    for (let col = 0; col < MASK_WIDTH; col++) {
      rg[2 * (row * MASK_WIDTH + col)] = lat > 80 ? 255 : 0
      rg[2 * (row * MASK_WIDTH + col) + 1] = lat > 85 ? 255 : 0
    }
  }
  return { rg, width: MASK_WIDTH, height: MASK_HEIGHT }
}

describe('the sea ice layers (tides-5oz)', () => {
  it('fills only the two spare layers, each grid in its corner, the date\'s frames at the first tile draw', async () => {
    const before = data.slice(0, 2 * LAYER)
    expect(sea.image.depth).toBe(4)
    expect(Array.from(data.subarray(2 * LAYER)).every((v) => v === 0)).toBe(true)
    const release = await attached(shipped)
    // Built, but nothing drawn yet: no frames, not on.
    expect(seaIceSurface.on.value).toBe(0)
    showSeaIceFrames(ice, { a: 11, b: 37, mix: 0.25 })
    expect(seaIceSurface.mix.value).toBe(0.25)
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(1)
    expect(data.subarray(0, 2 * LAYER)).toEqual(before)
    for (const [grid, layer] of [
      [ice.north, SEA_ICE_LAYER.north],
      [ice.south, SEA_ICE_LAYER.south],
    ] as const) {
      for (let row = 0; row < grid.height; row += 17) {
        for (let col = 0; col < grid.width; col += 13) {
          const [r, g] = texel(layer, col, row)
          expect(r).toBe(grid.frames[11][row * grid.width + col])
          expect(g).toBe(grid.frames[37][row * grid.width + col])
        }
      }
      // Off the grid, nothing: a read there is no ice.
      for (let row = 0; row < SEA_ICE_LAYER_SIZE; row += 7) expect(texel(layer, grid.width, row)).toEqual([0, 0, 0, 0])
      for (let col = 0; col < SEA_ICE_LAYER_SIZE; col += 7) expect(texel(layer, col, grid.height)).toEqual([0, 0, 0, 0])
    }
    // The central Arctic Ocean: sea, painted iced all year by the day map.
    const pole = { col: 154, row: 234 }
    expect(texel(SEA_ICE_LAYER.north, pole.col, pole.row).slice(2)).toEqual([255, 255])
    // Greenland's ice sheet: neither.
    const greenland = gridPoint(NORTH_GRID, 75, -40)
    const [col, row] = [Math.floor(greenland.col), Math.floor(greenland.row)]
    expect(texel(SEA_ICE_LAYER.north, col, row).slice(2)).toEqual([0, 0])
    release()
  })

  it('rewrites R and G only when the frames change and a tile draws, two layers at a time', async () => {
    const release = await attached(shipped)
    showSeaIceFrames(ice, { a: 11, b: 12, mix: 0 })
    uploadSeaIceFrames()
    // The array has been uploaded once: from now on, only the changed layers.
    sea.onUpdate?.()
    sea.layerUpdates.clear()
    const version = sea.version
    showSeaIceFrames(ice, { a: 11, b: 12, mix: 0.5 })
    uploadSeaIceFrames()
    expect(sea.version).toBe(version)
    expect(seaIceSurface.mix.value).toBe(0.5)
    // A new week, but no tile drew: nothing written.
    showSeaIceFrames(ice, { a: 37, b: 38, mix: 0 })
    const cell = 234 * ice.north.width + 154 - 40
    const { col, row } = { col: cell % ice.north.width, row: Math.floor(cell / ice.north.width) }
    expect(texel(SEA_ICE_LAYER.north, col, row)[0]).toBe(ice.north.frames[11][cell])
    expect(sea.version).toBe(version)
    // A tile draws.
    uploadSeaIceFrames()
    expect(texel(SEA_ICE_LAYER.north, col, row).slice(0, 2)).toEqual([ice.north.frames[37][cell], ice.north.frames[38][cell]])
    expect(sea.version).toBe(version + 1)
    expect([...sea.layerUpdates].sort()).toEqual([SEA_ICE_LAYER.north, SEA_ICE_LAYER.south])
    // Another data set's frames are not this one's.
    showSeaIceFrames(unpackSeaIce(new Uint8Array(gunzipSync(readFileSync('src/assets/sea-ice-2025.bin')))), { a: 1, b: 2, mix: 0.9 })
    expect(seaIceSurface.mix.value).toBe(0)
    release()
  })

  it('reaches the sea a cell past the coast and fades the all-year ice in over a cell', async () => {
    const release = await attached(capMask())
    const { width, height } = NORTH_GRID
    const lat = (col: number, row: number) => gridLatLon(NORTH_GRID, col + 0.5, row + 0.5).lat
    let dilated = 0
    let dry = 0
    let partial = 0
    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        const around: number[] = []
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around.push(lat(col + dx, row + dy))
        const [, , b, a] = texel(SEA_ICE_LAYER.north, col, row)
        // Land itself, by more than the mask's bilinear reach, beside a
        // neighbour on the sea: sea.
        if (lat(col, row) < 79.9 && around.some((l) => l > 80.1)) {
          expect(b).toBe(255)
          dilated++
        }
        if (around.every((l) => l < 79.9)) {
          expect(b).toBe(0)
          dry++
        }
        // The mask's green, bilinear between its rows either side of 85°N.
        const share = around.reduce((sum, l) => sum + Math.min(Math.max((l - 84.95) / 0.1, 0), 1), 0) / 9
        expect(Math.abs(a - share * 255)).toBeLessThanOrEqual(1)
        if (share > 0.2 && share < 0.8) partial++
      }
    }
    expect(dilated).toBeGreaterThan(50)
    expect(dry).toBeGreaterThan(1000)
    expect(partial).toBeGreaterThan(20)
    release()
  })

  it('gates the tiles: the Arctic Ocean and the Bohai Sea may hold ice, the Sahara, the Alps and the Mediterranean never', async () => {
    const release = await attached(shipped)
    expect(regionMayHoldIce(deg([-150, 80, -149, 81]))).toBe(true) // the Beaufort Sea's pack
    expect(regionMayHoldIce(deg([119.5, 38.5, 121.5, 40.5]))).toBe(true) // the Bohai Sea, frozen in winter
    expect(regionMayHoldIce(deg([-170, -75, -160, -74]))).toBe(true) // the Ross Sea
    expect(regionMayHoldIce(deg([179.5, 70, -179.5, 71]))).toBe(true) // across the antimeridian
    expect(regionMayHoldIce(deg([5, 20, 6, 21]))).toBe(false) // the Sahara
    expect(regionMayHoldIce(deg([7, 45.5, 8, 46.5]))).toBe(false) // the Alps
    expect(regionMayHoldIce(deg([17, 35, 18, 36]))).toBe(false) // the Mediterranean
    expect(regionMayHoldIce(deg([-112.5, 36, -112, 36.5]))).toBe(false) // the Grand Canyon
    release()
  })

  it('holds the ice while anything attaches it and the globe shows it, and drops it at the last release or when hidden', async () => {
    const first = await attached(shipped)
    const second = attachSeaIce(ice, shipped)
    showSeaIceFrames(ice, { a: 3, b: 4, mix: 0 })
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(1)
    first()
    first()
    expect(seaIceSurface.on.value).toBe(1)
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(1)
    // The shell hidden: off at once, and no draw turns it on until shown again.
    showSeaIceFrames(ice, null)
    expect(seaIceSurface.on.value).toBe(0)
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(0)
    showSeaIceFrames(ice, { a: 3, b: 4, mix: 0 })
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(1)
    second()
    expect(seaIceSurface.on.value).toBe(0)
    // Released: no draw turns it back on.
    uploadSeaIceFrames()
    expect(seaIceSurface.on.value).toBe(0)
  })

  it('goes up whole after a lost context, and passes the texture on to an earlier onUpdate', async () => {
    const release = await attached(shipped)
    showSeaIceFrames(ice, { a: 20, b: 21, mix: 0 })
    uploadSeaIceFrames()
    uploadedByRenderer()
    sea.layerUpdates.clear()
    showSeaIceFrames(ice, { a: 22, b: 23, mix: 0 })
    uploadSeaIceFrames()
    expect(sea.layerUpdates.size).toBe(2)
    const version = sea.version
    resetSeaIceUpload()
    expect(sea.layerUpdates.size).toBe(0)
    expect(sea.version).toBe(version + 1)
    // Until the renderer has uploaded it again, a new week marks no layer.
    showSeaIceFrames(ice, { a: 24, b: 25, mix: 0 })
    uploadSeaIceFrames()
    expect(sea.layerUpdates.size).toBe(0)
    uploadedByRenderer()
    showSeaIceFrames(ice, { a: 26, b: 27, mix: 0 })
    uploadSeaIceFrames()
    expect(sea.layerUpdates.size).toBe(2)
    sea.layerUpdates.clear()
    release()
  })
})

describe('the ice over the ground, shared by the globe and the tiles (tides-6ru.2)', () => {
  it('reads no ice off its grid: the array repeats, so the tap is bounded by each hemisphere\'s grid', () => {
    const tap = SEA_ICE_TAP_GLSL('up')
    expect(tap).toContain('vec4 seaIceTexel = vec4(0.0);')
    expect(tap).toContain(`vec2(${ice.north.width.toFixed(6)}, ${ice.north.height.toFixed(6)})`)
    expect(tap).toContain(`vec2(${ice.south.width.toFixed(6)}, ${ice.south.height.toFixed(6)})`)
    expect(tap).toMatch(/if \(all\(greaterThanEqual\(seaIceAt, vec2\(0\.0\)\)\) && all\(lessThanEqual\(seaIceAt, seaIceSize\)\)\)/)
    expect(tap).toContain('textureLod(uWaterSea,')
  })

  it('takes the glint\'s sea level', () => {
    expect(ICE_SEA_LEVEL).toEqual(GLINT_SEA_LEVEL)
  })

  it('lays the ice and the repainted sea on the sea only', () => {
    // Ice over the sea: the ice's colour, all of it.
    const iced = seaIceOver([1, 1, 1, 0], 0, 0)
    expect(iced.alpha).toBeCloseTo(1)
    expect(iced.albedo.equals(ICE_LINEAR)).toBe(true)
    // The day map's all-year ice where the year's has gone: open water.
    const open = seaIceOver([0, 0, 1, 1], 0.5, 0)
    expect(open.alpha).toBeCloseTo(1)
    expect(open.albedo.equals(OCEAN_LINEAR)).toBe(true)
    // Half the week's cover blended in.
    expect(seaIceOver([0, 1, 1, 0], 0.5, 0).alpha).toBeCloseTo(0.5)
    // Land a metre up, or off the grid's sea: none.
    expect(seaIceOver([1, 1, 1, 1], 0, 1).alpha).toBe(0)
    expect(seaIceOver([1, 1, 0, 1], 0, 0).alpha).toBe(0)
    // The ground's own water mask reaches the coast where the elevation,
    // blended a texel short of it, reads land: still on the grid's sea only.
    expect(seaIceOver([1, 1, 1, 0], 0, 3, 1).alpha).toBeCloseTo(1)
    expect(seaIceOver([1, 1, 1, 0], 0, 3, 0.5).alpha).toBeCloseTo(0.5)
    expect(seaIceOver([1, 1, 0, 0], 0, 3, 1).alpha).toBe(0)
  })
})
