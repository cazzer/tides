import { describe, expect, test } from 'vitest'
import {
  calibrateVisible,
  CLEAR_DT,
  cloudTopKm,
  composeGeoClouds,
  cosSunZenith,
  daylitTiles,
  decodeIr,
  ELEVATION_KM_PER_LEVEL,
  GEO_FULL_DEG,
  GEO_SATELLITES,
  GEO_ZERO_DEG,
  geoTilesFor,
  geoTileUrl,
  irCloudAlpha,
  irTemperature,
  LAND_COOL_MAX,
  LAND_MARGIN,
  landWarmGrid,
  LAPSE_RATE_C_PER_KM,
  MAX_CLOUD_TOP_KM,
  OPAQUE_DT,
  pixelLat,
  pixelLon,
  probeTile,
  referenceAt,
  rowReference,
  subsolarPoint,
  viewAngle,
  viewCoverage,
  viewWeight,
  visCloudAlpha,
  visibleGrey,
  type Terrain,
} from './geo-clouds'
import { OUT_H, OUT_W } from './real-clouds'

const at = (iso: string) => Date.parse(iso)
const N = OUT_W * OUT_H
const [GOES_WEST, GOES_EAST, HIMAWARI] = GEO_SATELLITES

/** x of the pixel column nearest a longitude, y of the row nearest a
 * latitude. */
const col = (lon: number) => Math.round(((lon + 180) / 360) * OUT_W - 0.5)
const row = (lat: number) => Math.round(((90 - lat) / 180) * OUT_H - 0.5)

describe('irTemperature: GIBS Clean_Longwave_Infrared_Window_Band colours', () => {
  test.each([
    ['red', 255, 0, 0, -60.6],
    ['yellow', 255, 255, 0, -50.6],
    ['green', 0, 255, 0, -40.6],
    ['cyan', 0, 255, 255, -19.35],
    ['coldest warm grey', 197, 197, 197, -18.85],
    ['warm grey', 148, 148, 148, 0.15],
    ['dark warm grey', 72, 72, 72, 29.65],
    ['purple', 127, 0, 127, -90.6],
    ['dark red', 26, 0, 0, -69.6],
  ])('%s', (_name, r, g, b, celsius) => {
    expect(irTemperature(r, g, b)).toBeCloseTo(celsius, 0)
  })

  test('colours resampled between entries interpolate', () => {
    // Between (0,140,192) -23.85 and (0,153,199) -23.35.
    expect(irTemperature(0, 149, 197)).toBeCloseTo(-23.5, 0)
    // Half way along the green ramp.
    expect(irTemperature(128, 255, 0)).toBeCloseTo(-45.6, 0)
  })

  test('dark reds by a convective core are cold, not the warm greys', () => {
    expect(irTemperature(15, 3, 3)).toBeLessThan(-65)
  })
})

describe('decodeIr', () => {
  const W = 5
  const H = 5
  const image = (fill: [number, number, number, number]) => {
    const rgba = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set(fill, i)
    return rgba
  }
  const set = (rgba: Uint8ClampedArray, x: number, y: number, c: number[]) =>
    rgba.set(c, (y * W + x) * 4)

  test('transparent and edge-blended pixels are no data', () => {
    const rgba = image([148, 148, 148, 255])
    set(rgba, 0, 0, [0, 0, 0, 0])
    set(rgba, 1, 0, [120, 120, 120, 224])
    const t = decodeIr(rgba, W, H)
    expect(t[0]).toBeNaN()
    expect(t[1]).toBeNaN()
    expect(t[2]).toBeCloseTo(0.15, 0)
  })

  test('greys inside a cold cluster read on the cold ramp', () => {
    // A core of cold greys (-75.6 °C is 129) ringed by dark red.
    const rgba = image([51, 0, 0, 255])
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) set(rgba, x, y, [129, 129, 129, 255])
    const t = decodeIr(rgba, W, H)
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) expect(t[y * W + x]).toBeLessThan(-70)
    }
  })

  test('a warm grey along the edge of an anvil stays warm', () => {
    // Left two columns red (-60.6 °C), the rest warm grey.
    const rgba = image([148, 148, 148, 255])
    for (let y = 0; y < H; y++) {
      set(rgba, 0, y, [255, 0, 0, 255])
      set(rgba, 1, y, [255, 0, 0, 255])
    }
    const t = decodeIr(rgba, W, H)
    for (let y = 0; y < H; y++) expect(t[y * W + 2]).toBeCloseTo(0.15, 0)
  })

  test('a blend of two runs of the colormap takes its neighbours’ mean', () => {
    // Greyish green: a warm grey resampled with a green cloud edge.
    const rgba = image([0, 255, 0, 255])
    set(rgba, 2, 2, [63, 167, 128, 255])
    const t = decodeIr(rgba, W, H)
    expect(t[2 * W + 2]).toBeCloseTo(-40.6, 0)
  })
})

describe('view geometry', () => {
  test('viewAngle is the arc from the sub-satellite point', () => {
    expect(viewAngle(0, -137.2, -137.2)).toBeCloseTo(0)
    expect(viewAngle(0, 180, 140.7)).toBeCloseTo(39.3)
    expect(viewAngle(60, -137.2, -137.2)).toBeCloseTo(60)
  })

  test('coverage is full near the sub-point and gone toward the limb', () => {
    expect(viewCoverage(0)).toBe(1)
    expect(viewCoverage(GEO_FULL_DEG)).toBe(1)
    expect(viewCoverage((GEO_FULL_DEG + GEO_ZERO_DEG) / 2)).toBeCloseTo(0.5)
    expect(viewCoverage(GEO_ZERO_DEG)).toBe(0)
    expect(viewCoverage(81)).toBe(0)
  })

  test('the satellite looking more nearly straight down weighs more', () => {
    expect(viewWeight(30)).toBeGreaterThan(viewWeight(40))
    expect(viewWeight(40)).toBeGreaterThan(viewWeight(50))
    expect(viewWeight(GEO_ZERO_DEG)).toBe(0)
  })

  test('at the dateline both Pacific satellites see the tropics fully', () => {
    for (const lat of [-40, -20, 0, 20, 40]) {
      expect(viewCoverage(viewAngle(lat, 180, GOES_WEST.lon))).toBe(1)
      expect(viewCoverage(viewAngle(lat, 180, HIMAWARI.lon))).toBe(1)
    }
  })

  test('pixel centres', () => {
    expect(pixelLat(0)).toBeCloseTo(90 - 180 / OUT_H / 2)
    expect(pixelLon(OUT_W - 1)).toBeCloseTo(180 - 360 / OUT_W / 2)
  })

  test('geoTilesFor skips the tiles a satellite never covers', () => {
    const cols = (wanted: boolean[]) => [0, 1, 2, 3, 4].filter((c) => wanted[5 + c])
    expect(cols(geoTilesFor(GOES_WEST.lon))).toEqual([0, 1, 4])
    expect(cols(geoTilesFor(GOES_EAST.lon))).toEqual([0, 1, 2])
    expect(cols(geoTilesFor(HIMAWARI.lon))).toEqual([0, 3, 4])
    // Polar rows too, down to GEO_ZERO_DEG of latitude.
    expect(geoTilesFor(GOES_WEST.lon)[0]).toBe(true)
    expect(geoTilesFor(GOES_WEST.lon)[10]).toBe(true)
  })

  test('probeTile holds the sub-satellite point', () => {
    expect(probeTile(GOES_WEST.lon)).toBe(5)
    expect(probeTile(GOES_EAST.lon)).toBe(6)
    expect(probeTile(HIMAWARI.lon)).toBe(9)
  })

  test('geoTileUrl', () => {
    expect(geoTileUrl(GOES_WEST.irLayer, '2026-10-18T00:00:00Z', 6)).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/GOES-West_ABI_Band13_Clean_Infrared/default/2026-10-18T00:00:00Z/2km/2/1/1.png'
    )
    expect(geoTileUrl(HIMAWARI.visLayer, '2026-10-18T00:00:00Z', 14)).toMatch(
      /Himawari_AHI_Band3_Red_Visible_1km\/default\/2026-10-18T00:00:00Z\/1km\/2\/2\/4\.png$/
    )
  })
})

describe('sun', () => {
  test('subsolarPoint', () => {
    const june = subsolarPoint(at('2026-06-21T12:00:00Z'))
    expect(june.lat).toBeCloseTo(23.44, 1)
    expect(Math.abs(june.lon)).toBeLessThan(1)
    // Equation of time puts noon at 0° at ~11:45 UTC in mid October.
    const october = subsolarPoint(at('2026-10-18T00:00:00Z'))
    expect(october.lat).toBeCloseTo(-9.5, 0)
    expect(october.lon).toBeCloseTo(176.3, 0)
  })

  test('cosSunZenith', () => {
    const sun = { lat: 0, lon: 0 }
    expect(cosSunZenith(0, 0, sun)).toBeCloseTo(1)
    expect(cosSunZenith(0, 90, sun)).toBeCloseTo(0)
    expect(cosSunZenith(0, 180, sun)).toBeCloseTo(-1)
  })

  test('daylitTiles keeps only tiles with some daylight', () => {
    const all = new Array(15).fill(true)
    const lit = daylitTiles(all, { lat: 0, lon: 0 })
    // Columns centred on -144 and +144 are within 36° of midnight.
    expect(lit[5]).toBe(false)
    expect(lit[7]).toBe(true)
    expect(lit[9]).toBe(false)
    expect(daylitTiles(new Array(15).fill(false), { lat: 0, lon: 0 }).some(Boolean)).toBe(false)
  })
})

/** Sea level everywhere; fill in land and elevation. */
const blankTerrain = () => ({ elevation: new Uint8Array(N), land: new Uint8Array(N) }) satisfies Terrain

/** Every satellite sees the whole globe at `celsius`. */
const uniform = (celsius: number) => GEO_SATELLITES.map(() => new Float32Array(N).fill(celsius))

describe('clear-sky reference', () => {
  test('rowReference is the warm end of the sea along a row', () => {
    const t = new Float32Array(N).fill(20)
    // A third of a row cold cloud: the 90th percentile is still clear sea.
    const y = row(0)
    for (let x = col(-180); x < col(-140); x++) t[y * OUT_W + x] = -50
    const rows = rowReference([t, null, null], null)
    expect(rows[y]).toBeCloseTo(20)
    // Rows no satellite sees copy the nearest that it does.
    expect(rows[0]).toBeCloseTo(20)
  })

  test('rowReference ignores land when there is enough sea', () => {
    const terrain = blankTerrain()
    const t = new Float32Array(N).fill(20)
    const y = row(30)
    for (let x = col(-150); x < col(-60); x++) {
      t[y * OUT_W + x] = 45 // hot desert
      terrain.land[y * OUT_W + x] = 1
    }
    expect(rowReference([t, null, null], terrain)[y]).toBeCloseTo(20)
  })

  const plateau = () => {
    const terrain = blankTerrain()
    for (let y = row(40); y < row(20); y++) {
      for (let x = col(-130); x < col(-90); x++) {
        terrain.land[y * OUT_W + x] = 1
        terrain.elevation[y * OUT_W + x] = 156 // 4 km
      }
    }
    return terrain
  }

  test('over high ground the reference drops with the lapse rate', () => {
    const terrain = plateau()
    const rows = new Float32Array(OUT_H).fill(20)
    // Clear plateau at the lapse-rate temperature for 4 km.
    const lapse = LAPSE_RATE_C_PER_KM * 156 * ELEVATION_KM_PER_LEVEL
    const t = new Float32Array(N).fill(20)
    for (let p = 0; p < N; p++) if (terrain.land[p]) t[p] = 20 - lapse
    const warm = landWarmGrid(t, GOES_WEST.lon, terrain)
    expect(referenceAt(rows, terrain, warm, col(-110), row(30))).toBeCloseTo(20 - lapse)
    expect(referenceAt(rows, terrain, warm, col(-150), row(30))).toBeCloseTo(20)
  })

  test('cold land at night lowers the reference, but only so far', () => {
    const terrain = blankTerrain()
    for (let y = row(60); y < row(30); y++) {
      for (let x = col(-120); x < col(-80); x++) terrain.land[y * OUT_W + x] = 1
    }
    const rows = new Float32Array(OUT_H).fill(15)
    const night = new Float32Array(N).fill(15)
    for (let p = 0; p < N; p++) if (terrain.land[p]) night[p] = 0
    const ref = referenceAt(rows, terrain, landWarmGrid(night, GOES_EAST.lon, terrain), col(-100), row(45))
    expect(ref).toBeCloseTo(LAND_MARGIN)
    // Land under a deck at -40 °C keeps a reference LAND_COOL_MAX below the sea.
    const deck = new Float32Array(N).fill(15)
    for (let p = 0; p < N; p++) if (terrain.land[p]) deck[p] = -40
    const decked = referenceAt(rows, terrain, landWarmGrid(deck, GOES_EAST.lon, terrain), col(-100), row(45))
    expect(decked).toBeCloseTo(15 - LAND_COOL_MAX)
    expect(irCloudAlpha(-40, decked)).toBe(1)
  })

  test('landWarmGrid is Infinity where no land is seen', () => {
    const terrain = blankTerrain()
    const grid = landWarmGrid(new Float32Array(N).fill(10), GOES_WEST.lon, terrain)
    expect(grid.every((v) => v === Infinity)).toBe(true)
  })
})

describe('cloud alpha', () => {
  test('irCloudAlpha ramps from CLEAR_DT to OPAQUE_DT below the reference', () => {
    expect(irCloudAlpha(20, 20)).toBe(0)
    expect(irCloudAlpha(20 - CLEAR_DT, 20)).toBe(0)
    expect(irCloudAlpha(20 - (CLEAR_DT + OPAQUE_DT) / 2, 20)).toBeCloseTo(0.5)
    expect(irCloudAlpha(20 - OPAQUE_DT, 20)).toBe(1)
    // Warmer than clear sky (hot desert by day).
    expect(irCloudAlpha(45, 20)).toBe(0)
  })

  test('very cold tops are cloud whatever the reference', () => {
    expect(irCloudAlpha(-50, -45)).toBe(1)
    expect(irCloudAlpha(-20, -18)).toBe(0)
  })

  test('cloudTopKm', () => {
    expect(cloudTopKm(20, 20)).toBe(0)
    expect(cloudTopKm(20 - 6.5 * 3, 20)).toBeCloseTo(3)
    expect(cloudTopKm(-90, 25)).toBe(MAX_CLOUD_TOP_KM)
    expect(cloudTopKm(30, 20)).toBe(0)
  })

  const cal = { clear: new Float32Array(8).fill(50), cloud: new Float32Array(8).fill(200) }

  test('visCloudAlpha: bright and a little colder than clear sky is cloud', () => {
    expect(visCloudAlpha(200, 0.9, 12, 20, cal)).toBe(1)
    expect(visCloudAlpha(50, 0.9, 12, 20, cal)).toBe(0)
    expect(visCloudAlpha(95, 0.9, 12, 20, cal)).toBeCloseTo(0.5)
  })

  test('visCloudAlpha ignores sunglint and desert (warm) and the night', () => {
    expect(visCloudAlpha(220, 0.9, 20, 20, cal)).toBe(0)
    expect(visCloudAlpha(220, 0.9, 40, 20, cal)).toBe(0)
    expect(visCloudAlpha(220, 0.05, 0, 20, cal)).toBe(0)
  })

  test('visibleGrey drops partial alpha', () => {
    expect([...visibleGrey(new Uint8ClampedArray([90, 90, 90, 255, 90, 90, 90, 200]))]).toEqual([90, 0])
  })

  test('calibrateVisible learns clear and cloud brightness from the IR', () => {
    const sun = subsolarPoint(at('2026-10-18T21:00:00Z'))
    const t = new Float32Array(N).fill(20)
    const vis = new Uint8Array(N).fill(60)
    for (let y = row(10); y < row(-10); y++) {
      for (let x = col(-150); x < col(-120); x++) {
        t[y * OUT_W + x] = -60
        vis[y * OUT_W + x] = 220
      }
    }
    const result = calibrateVisible(vis, t, () => 20, GOES_WEST.lon, sun)
    expect(result).not.toBeNull()
    expect([...result!.clear].every((v) => v === 60)).toBe(true)
    expect(result!.cloud.some((v) => v === 220)).toBe(true)
    // No daylight: nothing to calibrate.
    expect(calibrateVisible(vis, t, () => 20, GOES_WEST.lon, { lat: 0, lon: 43 })).toBeNull()
  })
})

describe('composeGeoClouds', () => {
  const fallback = (alpha: number) => {
    const rgba = new Uint8ClampedArray(N * 4)
    for (let i = 1; i < rgba.length; i += 4) rgba[i] = alpha
    return rgba
  }
  const px = (out: Uint8ClampedArray, lon: number, lat: number) => {
    const i = (row(lat) * OUT_W + col(lon)) * 4
    return [out[i], out[i + 1], out[i + 2], out[i + 3]]
  }
  // Midnight at 0°, so no visible anywhere it matters.
  const timeMs = at('2026-10-18T00:00:00Z')

  test('without satellites the daily composite shows through', () => {
    const out = new Uint8ClampedArray(N * 4)
    composeGeoClouds({ temps: [null, null, null], vis: [null, null, null], timeMs }, null, fallback(100), out)
    expect(px(out, 0, 0)).toEqual([0, 100, 0, 255])
    expect(px(out, 180, 0)).toEqual([0, 100, 0, 255])
  })

  test('clear sky from the satellites, the composite beyond them', () => {
    const out = fallback(100)
    composeGeoClouds({ temps: uniform(20), vis: [null, null, null], timeMs }, null, out, out)
    // Seen: clear. The 180° seam is gone with it.
    expect(px(out, 180, 0)).toEqual([0, 0, 255, 255])
    expect(px(out, 179.9, -30)).toEqual([0, 0, 255, 255])
    expect(px(out, -100, 30)).toEqual([0, 0, 255, 255])
    // Africa and the poles: the composite.
    expect(px(out, 30, 0)).toEqual([0, 100, 0, 255])
    expect(px(out, -137, 85)).toEqual([0, 100, 0, 255])
  })

  test('cloud tops carry their height in red', () => {
    const temps = uniform(20)
    // A deck 13 km up over the central Pacific (-64.5 °C).
    for (const t of temps) {
      for (let y = row(5); y < row(-5); y++) {
        for (let x = col(-170); x < col(-160); x++) t[y * OUT_W + x] = 20 - 6.5 * 13
      }
    }
    const out = fallback(0)
    composeGeoClouds({ temps, vis: [null, null, null], timeMs }, null, out, out)
    const [height, alpha, coverage] = px(out, -165, 0)
    expect(alpha).toBe(255)
    expect(coverage).toBe(255)
    expect((height / 255) * MAX_CLOUD_TOP_KM).toBeCloseTo(13, 0)
  })
})
