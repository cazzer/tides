import { describe, expect, test } from 'vitest'
import {
  cloudAlpha,
  composeCloudAlpha,
  desiredCloudSource,
  fillDate,
  fillNoData,
  growNoData,
  iceWeight,
  initialCloudDayState,
  isLatestStandIn,
  isRetryable,
  NO_DATA_GROW,
  OUT_H,
  OUT_W,
  pickEvictions,
  selectCloudSource,
  SETTLE_MS,
  SNOW_EDGES,
  snowWeight,
  sourceKey,
  stepCloudDay,
  tilesToFill,
  tileUrls,
  utcDayKey,
  type CloudDayState,
} from './real-clouds'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const VIIRS = 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
const MODIS = 'MODIS_Terra_CorrectedReflectance_TrueColor'
const VIIRS_SNOW = 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1'
const MODIS_SNOW = 'MODIS_Terra_CorrectedReflectance_Bands721'
const viirs = (date: string) =>
  ({ kind: 'gibs', layer: VIIRS, snowLayer: VIIRS_SNOW, date }) as const
const modis = (date: string) =>
  ({ kind: 'gibs', layer: MODIS, snowLayer: MODIS_SNOW, date }) as const

const at = (iso: string) => Date.parse(iso)

describe('selectCloudSource', () => {
  test.each([
    ['1950-06-01T12:00:00Z', { kind: 'static', reason: 'before-coverage' }],
    ['1999-12-31T12:00:00Z', { kind: 'static', reason: 'before-coverage' }],
    ['2000-02-23T23:59:59Z', { kind: 'static', reason: 'before-coverage' }],
    ['2000-02-24T00:00:00Z', modis('2000-02-24')],
    ['2005-08-28T18:00:00Z', modis('2005-08-28')],
    ['2015-11-23T23:59:59Z', modis('2015-11-23')],
    ['2015-11-24T00:00:00Z', viirs('2015-11-24')],
    ['2024-10-09T18:00:00Z', viirs('2024-10-09')],
    ['2026-10-17T00:00:00Z', viirs('2026-10-17')],
    ['2026-10-17T23:59:59Z', viirs('2026-10-17')],
    ['2026-10-18T00:00:00Z', viirs('2026-10-17')],
    ['2026-10-18T23:59:59Z', viirs('2026-10-17')],
    ['2026-10-19T00:00:00Z', { kind: 'static', reason: 'after-latest' }],
    ['2030-01-01T00:00:00Z', { kind: 'static', reason: 'after-latest' }],
  ])('%s', (iso, expected) => {
    expect(selectCloudSource(at(iso), NOW)).toEqual(expected)
  })

  test('the latest whole day follows the wall clock across UTC midnight', () => {
    const sim = at('2026-10-17T12:00:00Z')
    expect(selectCloudSource(sim, at('2026-10-16T23:59:59Z')).kind).toBe('static')
    expect(selectCloudSource(sim, at('2026-10-17T23:59:59Z'))).toEqual(viirs('2026-10-16'))
    expect(selectCloudSource(sim, at('2026-10-18T00:00:00Z'))).toEqual(viirs('2026-10-17'))
  })

  test('false-colour layer comes from the same instrument', () => {
    expect(selectCloudSource(at('2015-11-23T12:00:00Z'), NOW)).toMatchObject({
      layer: MODIS,
      snowLayer: MODIS_SNOW,
    })
    expect(selectCloudSource(at('2015-11-24T12:00:00Z'), NOW)).toMatchObject({
      layer: VIIRS,
      snowLayer: VIIRS_SNOW,
    })
  })

  test('today and yesterday share one cached texture', () => {
    const today = selectCloudSource(NOW, NOW)
    const yesterday = selectCloudSource(at('2026-10-17T12:00:00Z'), NOW)
    expect(sourceKey(today)).toBe(sourceKey(yesterday))
  })

  test('a jump target wins over the tweening clock', () => {
    const mid = at('2010-01-01T00:00:00Z')
    expect(desiredCloudSource(mid, at('1950-01-01T00:00:00Z'), NOW)).toEqual({
      kind: 'static',
      reason: 'before-coverage',
    })
    expect(desiredCloudSource(mid, null, NOW)).toEqual(modis('2010-01-01'))
  })
})

describe('isLatestStandIn', () => {
  const latest = selectCloudSource(NOW, NOW)

  test('today shows the latest whole day as a stand-in', () => {
    expect(isLatestStandIn(latest, NOW, NOW)).toBe(true)
  })

  test('the matching day is not a stand-in', () => {
    expect(isLatestStandIn(latest, at('2026-10-17T12:00:00Z'), NOW)).toBe(false)
  })

  test('a lagging committed source on another sim day is not labelled latest', () => {
    expect(isLatestStandIn(latest, at('2020-01-01T00:00:00Z'), NOW)).toBe(false)
  })

  test('static and missing sources are never stand-ins', () => {
    expect(isLatestStandIn({ kind: 'static', reason: 'after-latest' }, NOW, NOW)).toBe(false)
    expect(isLatestStandIn(null, NOW, NOW)).toBe(false)
  })
})

test('utcDayKey and sourceKey', () => {
  expect(utcDayKey(at('2024-10-09T23:59:59Z'))).toBe('2024-10-09')
  expect(sourceKey(viirs('2024-10-09'))).toBe(
    `${VIIRS}/2024-10-09`
  )
  expect(sourceKey({ kind: 'static', reason: 'after-latest' })).toBe('static:after-latest')
})

test('tileUrls lists the 5x3 level-2 tiles row by row', () => {
  const urls = tileUrls(VIIRS, '2024-10-09')
  expect(urls).toHaveLength(15)
  expect(urls[0]).toBe(
    'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2024-10-09/250m/2/0/0.jpg'
  )
  expect(urls[4]).toMatch(/\/250m\/2\/0\/4\.jpg$/)
  expect(urls[5]).toMatch(/\/250m\/2\/1\/0\.jpg$/)
  expect(urls[14]).toMatch(/\/250m\/2\/2\/4\.jpg$/)
})

// Pixels sampled from GIBS true colour (VIIRS 2024-01-15 unless noted).
describe('cloudAlpha', () => {
  test.each([
    ['white', 255, 255, 255],
    ['thick cloud', 231, 233, 234],
    ['thick cloud, MODIS 2010-01-15', 231, 231, 233],
  ])('%s is opaque', (_name, r, g, b) => {
    expect(cloudAlpha(r, g, b)).toBe(255)
  })
  test.each([
    ['ocean', 23, 29, 45],
    ['deep ocean', 10, 40, 90],
    ['hazy ocean', 55, 60, 69],
    ['Sahara', 175, 149, 123],
    ['bright desert', 220, 180, 120],
    ['vegetation', 72, 76, 62],
    ['dusty Sahel', 99, 97, 88],
    ['shallow water', 90, 170, 175],
    ['turquoise shallows', 110, 190, 200],
  ])('%s is clear', (_name, r, g, b) => {
    expect(cloudAlpha(r, g, b)).toBe(0)
  })
  test.each([
    ['thin cloud over ocean', 99, 103, 112],
    ['stratocumulus edge', 105, 107, 120],
    ['cirrus over ocean', 124, 128, 137],
    ['thin cloud over the Sahara', 214, 201, 192],
    ['grey cloud', 150, 150, 150],
  ])('%s is partly opaque', (_name, r, g, b) => {
    const a = cloudAlpha(r, g, b)
    expect(a).toBeGreaterThan(30)
    expect(a).toBeLessThan(200)
  })
  test('slightly warm bright cloud stays mostly opaque', () => {
    expect(cloudAlpha(230, 225, 210)).toBeGreaterThan(180)
  })
  test('alpha grows with cloud over the same ocean', () => {
    const ocean = [23, 29, 45]
    const cloud = [231, 233, 234]
    const mix = (f: number) =>
      ocean.map((c, i) => c + f * (cloud[i] - c)) as [number, number, number]
    const alphas = [0.3, 0.45, 0.6, 0.75].map((f) => cloudAlpha(...mix(f)))
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThan(alphas[i - 1] + 20)
  })
})

describe('iceWeight', () => {
  test('ice sheets on land count as ice', () => {
    expect(iceWeight(0, 250, 250, 252)).toBe(1) // Antarctica
    expect(iceWeight(10, 235, 240, 245)).toBe(1) // Greenland
  })
  test('water is never ice', () => {
    expect(iceWeight(255, 250, 250, 252)).toBe(0)
  })
  test.each([
    ['Sahara', 210, 170, 110],
    ['Tibet', 150, 130, 100],
    ['Rockies', 120, 110, 90],
    ['forest', 40, 70, 30],
  ])('%s is not ice', (_name, r, g, b) => {
    expect(iceWeight(0, r, g, b)).toBe(0)
  })
})

describe('snowWeight', () => {
  describe('VIIRS M11-I2-I1', () => {
    const edges = SNOW_EDGES[VIIRS_SNOW]
    test.each([
      [107, 241, 242],
      [58, 210, 199],
      [77, 241, 249],
      [52, 206, 218],
      [86, 230, 241],
    ])('snow/ice %i,%i,%i is fully masked', (r, g, b) => {
      expect(snowWeight(r, g, b, edges)).toBe(1)
    })
    test('snow near the ramp edge is almost fully masked', () => {
      expect(snowWeight(115, 226, 223, edges)).toBeGreaterThan(0.9)
    })
    test.each([
      [178, 216, 211],
      [186, 231, 229],
      [160, 212, 211],
      [212, 212, 192],
      [79, 190, 95],
      [27, 34, 39],
      [0, 0, 0],
      [5, 9, 11],
    ])('cloud, land, ocean or no data %i,%i,%i is not masked', (r, g, b) => {
      expect(snowWeight(r, g, b, edges)).toBe(0)
    })
  })

  describe('MODIS 7-2-1', () => {
    const edges = SNOW_EDGES[MODIS_SNOW]
    test('snow/ice is masked', () => {
      expect(snowWeight(69, 236, 237, edges)).toBe(1)
      expect(snowWeight(76, 226, 229, edges)).toBeGreaterThan(0.8)
    })
    test.each([
      [121, 179, 180],
      [143, 209, 209],
      // Snow under the VIIRS edges; 7-2-1 ice cloud is this cyan.
      [120, 220, 222],
    ])('cloud %i,%i,%i is not masked', (r, g, b) => {
      expect(snowWeight(r, g, b, edges)).toBe(0)
    })
  })
})

describe('composeCloudAlpha', () => {
  const edges = SNOW_EDGES[VIIRS_SNOW]
  const run = (gibs: number[], falseColour: number[], staticAlpha: number[], ice: number[]) => {
    const out = new Uint8ClampedArray(gibs.length)
    composeCloudAlpha(Uint8ClampedArray.from(gibs), falseColour, edges, staticAlpha, ice, out)
    return Array.from(out)
  }
  const white = [243, 244, 247, 255]
  const snow = [107, 241, 242, 255]
  const cloud = [186, 231, 229, 255]
  const black = [0, 0, 0, 255]

  test('no-data pixels take the static alpha, whatever the false colour', () => {
    expect(run([0, 0, 0, 0, 5, 8, 11, 255], [...snow, ...cloud], [77, 140], [0, 0])).toEqual([
      77, 77, 77, 255, 140, 140, 140, 255,
    ])
  })
  test('cloud stays, ice removes it', () => {
    expect(run([...white, ...white], [...cloud, ...cloud], [0, 0], [0, 255])).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255,
    ])
  })
  test('false-colour snow removes white, cloud keeps it', () => {
    expect(run([...white, ...white], [...snow, ...cloud], [0, 0], [0, 0])).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255,
    ])
  })
  test('missing false colour masks nothing', () => {
    expect(run(white, black, [0], [0])).toEqual([255, 255, 255, 255])
  })
  test('ice and snow combine by max, not sum', () => {
    // Snow weight 0.5 (VIIRS midpoint) and ice 0.25: max keeps ~128, sum ~64.
    const [a] = run(white, [100, 185, 185, 255], [0], [64])
    expect(a).toBeGreaterThanOrEqual(127)
    expect(a).toBeLessThanOrEqual(128)
  })
  test('out may alias the true-colour input', () => {
    const gibs = Uint8ClampedArray.from([...white, ...white, ...black])
    composeCloudAlpha(gibs, [...snow, ...cloud, ...snow], edges, [0, 0, 90], [0, 0, 0], gibs)
    expect(Array.from(gibs)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 90, 90, 90, 255])
  })
})

describe('fillDate', () => {
  test.each([
    [viirs('2024-10-09'), '2024-10-08'],
    [viirs('2024-03-01'), '2024-02-29'],
    [viirs('2015-11-24'), null],
    [modis('2000-02-24'), null],
    [modis('2000-02-25'), '2000-02-24'],
  ])('%o', (source, expected) => {
    expect(fillDate(source)).toBe(expected)
  })
  test('the latest stand-in fills from the day before it', () => {
    const latest = selectCloudSource(NOW, NOW)
    if (latest.kind !== 'gibs') throw new Error('expected a GIBS source')
    expect(fillDate(latest)).toBe('2026-10-16')
  })
})

describe('tilesToFill', () => {
  const grey = () => new Uint8ClampedArray(OUT_W * OUT_H * 4).fill(128)
  const blacken = (img: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) img.fill(0, (y * OUT_W + x) * 4, (y * OUT_W + x) * 4 + 3)
    }
  }
  const ok = Array<boolean>(15).fill(false)
  const marked = (wanted: boolean[]) => wanted.flatMap((w, i) => (w ? [i] : []))

  test('complete imagery fills nothing', () => {
    expect(marked(tilesToFill(grey(), ok))).toEqual([])
  })
  test('a gap within ±45° fills every row of its column', () => {
    const img = grey()
    blacken(img, 0, 320, 512, 960)
    expect(marked(tilesToFill(img, ok))).toEqual([0, 5, 10])
  })
  test('polar no-data is ignored', () => {
    const img = grey()
    blacken(img, 0, 0, OUT_W, 320)
    blacken(img, 0, 960, OUT_W, OUT_H)
    expect(marked(tilesToFill(img, ok))).toEqual([])
  })
  test('a few no-data pixels are noise', () => {
    const img = grey()
    blacken(img, 100, 600, 110, 610)
    expect(marked(tilesToFill(img, ok))).toEqual([])
  })
  test('a failed primary tile is filled on its own', () => {
    const failed = [...ok]
    failed[12] = true
    expect(marked(tilesToFill(grey(), failed))).toEqual([12])
  })
  test('columns are 512px wide', () => {
    const img = grey()
    blacken(img, 512, 320, 600, 960)
    expect(marked(tilesToFill(img, ok))).toEqual([1, 6, 11])
  })
  test('only rows 320..959 are counted', () => {
    const above = grey()
    blacken(above, 0, 318, 512, 320)
    expect(marked(tilesToFill(above, ok))).toEqual([])
    const below = grey()
    blacken(below, 0, 960, 512, 962)
    expect(marked(tilesToFill(below, ok))).toEqual([])
    // 1024 px, 0.31% of the band.
    const inside = grey()
    blacken(inside, 0, 320, 512, 322)
    expect(marked(tilesToFill(inside, ok))).toEqual([0, 5, 10])
  })
  test('a column fills above FILL_GAP_FRACTION (655.36 px)', () => {
    const at655 = grey()
    blacken(at655, 0, 600, 512, 601)
    blacken(at655, 0, 601, 143, 602)
    expect(marked(tilesToFill(at655, ok))).toEqual([])
    const at656 = grey()
    blacken(at656, 0, 600, 512, 601)
    blacken(at656, 0, 601, 144, 602)
    expect(marked(tilesToFill(at656, ok))).toEqual([0, 5, 10])
  })
  test("a failed tile's black doesn't fill the rest of its column", () => {
    for (const tile of [0, 5]) {
      const img = grey()
      const y = Math.floor(tile / 5) * 512
      blacken(img, 0, y, 512, y + 512)
      const failed = [...ok]
      failed[tile] = true
      expect(marked(tilesToFill(img, failed))).toEqual([tile])
    }
  })
})

describe('fillNoData', () => {
  const px = (x: number, y: number) => (y * OUT_W + x) * 4
  const frame = (rows: number) => new Uint8ClampedArray(OUT_W * rows * 4)
  const get = (buf: Uint8ClampedArray, x: number, y: number) =>
    Array.from(buf.subarray(px(x, y), px(x, y) + 4))

  test('no-data pixels take the fill day, others keep theirs; alpha untouched', () => {
    const gibs = frame(2)
    const falseColour = frame(2)
    ;[[0, 0, 0, 7], [12, 0, 0, 8], [11, 5, 0, 9]].forEach((rgba, i) => {
      gibs.set(rgba, px(10 + i, 1))
      falseColour.set([1, 2, 3, 4], px(10 + i, 1))
    })
    fillNoData(
      gibs,
      falseColour,
      [200, 201, 202, 50, 200, 201, 202, 50, 210, 211, 212, 50],
      [100, 101, 102, 60, 100, 101, 102, 60, 110, 111, 112, 60],
      10,
      1,
      3,
      1
    )
    expect([10, 11, 12].map((x) => get(gibs, x, 1))).toEqual([
      [200, 201, 202, 7],
      [12, 0, 0, 8],
      [210, 211, 212, 9],
    ])
    expect([10, 11, 12].map((x) => get(falseColour, x, 1))).toEqual([
      [100, 101, 102, 4],
      [1, 2, 3, 4],
      [110, 111, 112, 4],
    ])
  })

  test('the region is read row by row and nothing outside it changes', () => {
    const gibs = frame(3)
    const falseColour = frame(3)
    const fill = Uint8ClampedArray.from({ length: 16 }, (_, i) => 100 + i)
    fillNoData(gibs, falseColour, fill, fill, OUT_W - 2, 1, 2, 2)
    expect(get(gibs, OUT_W - 2, 1)).toEqual([100, 101, 102, 0])
    expect(get(gibs, OUT_W - 1, 1)).toEqual([104, 105, 106, 0])
    expect(get(gibs, OUT_W - 2, 2)).toEqual([108, 109, 110, 0])
    expect(get(falseColour, OUT_W - 1, 2)).toEqual([112, 113, 114, 0])
    expect(gibs.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(12)
    expect(falseColour.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(12)
  })

  test('the filled pixels go through composeCloudAlpha like primary ones', () => {
    const white = [243, 244, 247, 255]
    const snow = [107, 241, 242, 255]
    const cloud = [186, 231, 229, 255]
    const black = [0, 0, 0, 255]
    const gibs = frame(1)
    const falseColour = frame(1)
    fillNoData(
      gibs,
      falseColour,
      [...white, ...black, ...white],
      [...snow, ...black, ...cloud],
      0,
      0,
      3,
      1
    )
    const out = new Uint8ClampedArray(12)
    composeCloudAlpha(gibs, falseColour, SNOW_EDGES[VIIRS_SNOW], [0, 90, 0], [0, 0, 0], out)
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 90, 90, 90, 255, 255, 255, 255, 255])
  })
})

describe('growNoData', () => {
  const W = 9
  const H = 7
  const image = () => new Uint8ClampedArray(W * H * 4).fill(150)
  const black = (img: Uint8ClampedArray) => {
    const rows: string[] = []
    for (let y = 0; y < H; y++) {
      let row = ''
      for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
        row += img[i] + img[i + 1] + img[i + 2] === 0 ? '#' : '.'
      }
      rows.push(row)
    }
    return rows
  }

  test('blackens a square NO_DATA_GROW px around no-data, alpha untouched', () => {
    expect(NO_DATA_GROW).toBe(2)
    const img = image()
    img.set([5, 9, 11], (3 * W + 4) * 4)
    growNoData(img, W, H)
    expect(black(img)).toEqual([
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
    ])
    expect(img.filter((_, i) => i % 4 === 3).every((a) => a === 150)).toBe(true)
  })
  test('stops at the image edges', () => {
    const img = image()
    img.set([0, 0, 0], 0)
    growNoData(img, W, H)
    expect(black(img).slice(0, 4)).toEqual(['###......', '###......', '###......', '.........'])
    const corner = image()
    corner.set([0, 0, 0], (W * H - 1) * 4)
    growNoData(corner, W, H)
    expect(black(corner).slice(3)).toEqual(['.........', '......###', '......###', '......###'])
  })
  test("a filled failed tile leaves its neighbours' edges alone", () => {
    const img = new Uint8ClampedArray(OUT_W * OUT_H * 4).fill(150)
    const failed = Array<boolean>(15).fill(false)
    failed[6] = true
    for (let y = 512; y < 1024; y++) img.fill(0, (y * OUT_W + 512) * 4, (y * OUT_W + 1024) * 4)
    growNoData(img, OUT_W, OUT_H, failed)
    const fill =new Uint8ClampedArray(512 * 512 * 4).fill(200)
    fillNoData(img, new Uint8ClampedArray(img.length), fill, fill, 512, 512, 512, 512)
    const green = (x: number, y: number) => img[(y * OUT_W + x) * 4 + 1]
    expect([510, 511, 1024, 1025].map((x) => green(x, 700))).toEqual([150, 150, 150, 150])
    expect([510, 511, 1024, 1025].map((y) => green(700, y))).toEqual([150, 150, 150, 150])
    expect([512, 1023].map((x) => green(x, 700))).toEqual([200, 200])
  })
  test('dark data is not no-data', () => {
    const img = image()
    img.set([12, 0, 0], (3 * W + 4) * 4)
    growNoData(img, W, H)
    expect(black(img).join('')).not.toContain('#')
  })
})

describe('stepCloudDay', () => {
  const A = 'gibs/2024-10-09'
  const B = 'gibs/2024-10-10'
  const C = 'gibs/2024-10-11'

  test('the first key commits at once', () => {
    const { state, commit } = stepCloudDay(initialCloudDayState, A, 100)
    expect(commit).toBe(A)
    expect(state.committed).toBe(A)
  })

  test('a rollover commits after it settles', () => {
    let s: CloudDayState = stepCloudDay(initialCloudDayState, A, 0).state
    let r = stepCloudDay(s, B, 1000)
    expect(r.commit).toBeNull()
    s = r.state
    r = stepCloudDay(s, B, 1000 + SETTLE_MS - 1)
    expect(r.commit).toBeNull()
    s = r.state
    r = stepCloudDay(s, B, 1000 + SETTLE_MS)
    expect(r.commit).toBe(B)
    expect(r.state).toEqual({ candidate: null, since: 1000 + SETTLE_MS, committed: B })
  })

  test('fast-forward through days never commits', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    const days = [B, C, 'd', 'e', 'f', 'g']
    for (let frame = 0; frame < 6 * 60; frame++) {
      const r = stepCloudDay(s, days[Math.floor(frame / 60)], frame * 16)
      expect(r.commit).toBeNull()
      s = r.state
    }
    expect(s.committed).toBe(A)
  })

  test('returning to the committed day drops the candidate', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    s = stepCloudDay(s, B, 100).state
    const r = stepCloudDay(s, A, 200)
    expect(r.commit).toBeNull()
    expect(r.state.candidate).toBeNull()
    expect(stepCloudDay(r.state, B, 300 + SETTLE_MS - 1).commit).toBeNull()
  })

  test('calling twice in a frame commits once and is otherwise a no-op', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    s = stepCloudDay(s, B, 100).state
    const again = stepCloudDay(s, B, 100)
    expect(again.state).toBe(s)
    const first = stepCloudDay(s, B, 100 + SETTLE_MS)
    expect(first.commit).toBe(B)
    const second = stepCloudDay(first.state, B, 100 + SETTLE_MS)
    expect(second.commit).toBeNull()
    expect(second.state).toBe(first.state)
  })

  test('a jump commits its target, never the days it passes', () => {
    const target = at('1950-01-01T00:00:00Z')
    const key = (sim: number) => sourceKey(desiredCloudSource(sim, target, NOW))
    const from = at('2024-10-09T12:00:00Z')
    let s = stepCloudDay(initialCloudDayState, sourceKey(selectCloudSource(from, NOW)), 0).state
    const commits: string[] = []
    for (let ms = 16; ms <= 5000; ms += 16) {
      const sim = from + ((target - from) * ms) / 5000
      const r = stepCloudDay(s, key(sim), ms)
      if (r.commit) commits.push(r.commit)
      s = r.state
    }
    expect(commits).toEqual(['static:before-coverage'])
  })
})

test('isRetryable', () => {
  expect(isRetryable('timeout')).toBe(true)
  expect(isRetryable('network')).toBe(true)
  expect(isRetryable(503)).toBe(true)
  expect(isRetryable(429)).toBe(true)
  expect(isRetryable(404)).toBe(false)
  expect(isRetryable(400)).toBe(false)
})

describe('pickEvictions', () => {
  const entries = [
    { key: 'a', lastUsed: 1 },
    { key: 'b', lastUsed: 4 },
    { key: 'c', lastUsed: 2 },
    { key: 'd', lastUsed: 3 },
  ]
  test('evicts the least recently used beyond max', () => {
    expect(pickEvictions(entries, null, 3)).toEqual(['a'])
    expect(pickEvictions(entries, null, 2)).toEqual(['a', 'c'])
  })
  test('never evicts the kept key', () => {
    expect(pickEvictions(entries, 'a', 3)).toEqual(['c'])
  })
  test('nothing to do under the limit', () => {
    expect(pickEvictions(entries, null, 4)).toEqual([])
  })
})
