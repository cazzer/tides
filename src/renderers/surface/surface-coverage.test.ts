// The view error near the eye (tides-zmw.9.17) and past the source's
// coverage (tides-zmw.9.21), on the renderer's own ellipsoid and the
// terrain plugin's own tiles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import { SURFACE_TREE_DEEPEST } from './surface-ground'
import {
  boundSurfaceViewError,
  CAP_LEVELS,
  EYE_GROUND_MIN_METRES,
  regionDistance,
  terrainTileSymbols,
  type RegionEllipsoid,
  type SurfaceViewErrorOptions,
  type ViewErrorTarget,
} from './surface-coverage'

const R = SURFACE_ELLIPSOID_RADIUS
const DEG = Math.PI / 180

function ellipsoid(): RegionEllipsoid {
  const tiles = new TilesRenderer()
  tiles.ellipsoid.radius.setScalar(R)
  return tiles.ellipsoid as unknown as RegionEllipsoid
}

// A region of a degree around (28, 87), ground 8000-8500 m, as fitted.
const REGION = [86.5 * DEG, 27.5 * DEG, 87.5 * DEG, 28.5 * DEG, 7900, 9200]

function eyeAt(e: RegionEllipsoid, latDeg: number, lonDeg: number, height: number) {
  const position = e.getCartographicToPosition(latDeg * DEG, lonDeg * DEG, height, new THREE.Vector3())
  return { position, carto: { lat: latDeg * DEG, lon: lonDeg * DEG, height } }
}

describe('regionDistance (tides-zmw.9.17)', () => {
  const e = ellipsoid()

  it('is null with the eye inside the region', () => {
    const { position, carto } = eyeAt(e, 28, 87, 9000)
    expect(regionDistance(REGION, carto, position, e)).toBeNull()
  })

  it('is the height over the top straight above it, and the ground distance beside it', () => {
    const above = eyeAt(e, 28, 87, 10200)
    expect(regionDistance(REGION, above.carto, above.position, e)).toBeCloseTo(1000, 3)
    // a tenth of a degree north of the region, at a height inside it
    const beside = eyeAt(e, 28.6, 87, 9000)
    expect(regionDistance(REGION, beside.carto, beside.position, e)).toBeCloseTo((R + 9000) * 0.1 * DEG, -1)
  })

  it('takes the longitude across the antimeridian the short way', () => {
    const region = [179.5 * DEG, -0.5 * DEG, 180 * DEG, 0.5 * DEG, 0, 100]
    const eye = eyeAt(e, 0, -179.9, 50)
    expect(regionDistance(region, eye.carto, eye.position, e)).toBeCloseTo((R + 50) * 0.1 * DEG, -1)
  })
})

/** A renderer as the wrapper reads it, whose own view error says `library`. */
function fakeRenderer(library: Partial<ViewErrorTarget>, eye: THREE.Vector3, { orthographic = false, inFrustum = true } = {}) {
  const e = ellipsoid()
  const renderer = {
    frameCount: 1,
    ellipsoid: e,
    cameraInfo: [{ isOrthographic: orthographic, pixelSize: 2, sseDenominator: 0.002, position: eye, frustum: {} }],
    calculateTileViewError(_tile: object, target: ViewErrorTarget) {
      Object.assign(target, { inView: true, error: 1, distanceFromCamera: 100, ...library })
    },
  }
  const volume = { intersectsFrustum: () => inFrustum }
  return { renderer, volume }
}

const X = Symbol('TILE_X')
const Y = Symbol('TILE_Y')
const LEVEL = Symbol('TILE_LEVEL')
const child = (x: number, y: number, level: number) => ({ [X]: x, [Y]: y, [LEVEL]: level })

function tileOf(volume: object, children: object[] = [], geometricError = 10, at: [number, number, number] = [0, 0, 5]) {
  return { geometricError, boundingVolume: { region: REGION }, engineData: { boundingVolume: volume }, children, ...child(...at) }
}

function options(over: Partial<SurfaceViewErrorOptions> = {}): SurfaceViewErrorOptions {
  return {
    coverageLevel: () => -1,
    hasCoverageEnds: () => false,
    maxSourceLevel: 16,
    scale: () => 1,
    ground: () => null,
    ...over,
  }
}

const viewError = (renderer: { calculateTileViewError(t: object, target: ViewErrorTarget): void }, tile: object) => {
  const target = { inView: false, error: 0, distanceFromCamera: 0 }
  renderer.calculateTileViewError(tile, target)
  return target
}

describe('the view error near the eye (tides-zmw.9.17)', () => {
  const e = ellipsoid()

  it("leaves the library's error where its distance is a metre or more", () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const { renderer, volume } = fakeRenderer({ error: 3, distanceFromCamera: EYE_GROUND_MIN_METRES }, position)
    boundSurfaceViewError(renderer, options())
    expect(viewError(renderer, tileOf(volume))).toEqual({ inView: true, error: 3, distanceFromCamera: EYE_GROUND_MIN_METRES })
  })

  it('takes the distance down to the drawn ground with the eye inside the region, never under the stop', () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const { renderer, volume } = fakeRenderer({ error: Infinity, distanceFromCamera: 0 }, position)
    const ground = vi.fn(() => 7500)
    boundSurfaceViewError(renderer, options({ ground, scale: () => 1.1 }))
    const near = viewError(renderer, tileOf(volume, [], 10))
    expect(near.distanceFromCamera).toBeCloseTo(9000 - 7500 * 1.1, 6)
    expect(near.error).toBeCloseTo(10 / ((9000 - 8250) * 0.002), 6)
    expect(near.inView).toBe(true)
    // read once a frame
    viewError(renderer, tileOf(volume))
    expect(ground).toHaveBeenCalledTimes(1)
    renderer.frameCount++
    ground.mockReturnValue(8990)
    expect(viewError(renderer, tileOf(volume)).distanceFromCamera).toBe(EYE_GROUND_MIN_METRES)
    expect(ground).toHaveBeenCalledTimes(2)
    expect(EYE_GROUND_MIN_METRES).toBeCloseTo(30, 9)
  })

  it("takes the region's top for the ground where no drawn tile covers it: the stop, finite", () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const { renderer, volume } = fakeRenderer({ error: 1e16, distanceFromCamera: 1e-9 }, position)
    const bounds = boundSurfaceViewError(renderer, options())
    const near = viewError(renderer, tileOf(volume, [], 2.1))
    expect(near.distanceFromCamera).toBe(EYE_GROUND_MIN_METRES)
    expect(near.error).toBeCloseTo(2.1 / (30 * 0.002), 6)
    expect(Number.isFinite(bounds.maxError)).toBe(true)
    expect(bounds.near).toBe(1)
  })

  it("takes the distance to the region from an eye in the box's slack beside it", () => {
    const { position } = eyeAt(e, 28.6, 87, 9000)
    const { renderer, volume } = fakeRenderer({ error: Infinity, distanceFromCamera: 0 }, position)
    boundSurfaceViewError(renderer, options({ ground: () => 0 }))
    expect(viewError(renderer, tileOf(volume)).distanceFromCamera).toBeCloseTo((R + 9000) * 0.1 * DEG, -1)
  })

  it('writes the error for the load priority when out of view, and an orthographic camera as the library does', () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const out = fakeRenderer({ error: Infinity, distanceFromCamera: 0, inView: false }, position, { inFrustum: false })
    boundSurfaceViewError(out.renderer, options({ ground: () => 8000 }))
    const away = viewError(out.renderer, tileOf(out.volume, [], 10))
    expect(away.inView).toBe(false)
    expect(away.distanceFromCamera).toBeCloseTo(1000, 6)
    expect(away.error).toBeCloseTo(10 / (1000 * 0.002), 6)
    const ortho = fakeRenderer({ error: 5, distanceFromCamera: 0 }, position, { orthographic: true })
    boundSurfaceViewError(ortho.renderer, options())
    expect(viewError(ortho.renderer, tileOf(ortho.volume, [], 10))).toEqual({ inView: true, error: 5, distanceFromCamera: Infinity })
  })
})

describe('the tiles under the eye at speed (tides-zmw.9.22)', () => {
  const e = ellipsoid()

  it("scales the error of tiles over the eye's latitude and longitude only, and only above 1", () => {
    const over = eyeAt(e, 28, 87, 12000)
    const a = fakeRenderer({ error: 3, distanceFromCamera: 3000 }, over.position)
    let scale = 4
    const bounds = boundSurfaceViewError(a.renderer, options({ eyeErrorScale: () => scale }))
    expect(viewError(a.renderer, tileOf(a.volume)).error).toBe(12)
    expect(bounds.underEye).toBe(1)
    scale = 1
    expect(viewError(a.renderer, tileOf(a.volume)).error).toBe(3)
    scale = 0.5
    expect(viewError(a.renderer, tileOf(a.volume)).error).toBe(3)
    const beside = eyeAt(e, 29, 87, 12000)
    const b = fakeRenderer({ error: 3, distanceFromCamera: 3000 }, beside.position)
    boundSurfaceViewError(b.renderer, options({ eyeErrorScale: () => 4 }))
    expect(viewError(b.renderer, tileOf(b.volume)).error).toBe(3)
  })

  it('takes tiles within the margin around the eye too, the longitude margin over cos(latitude)', () => {
    // REGION spans 27.5-28.5 N, 86.5-87.5 E; the eye 0.2 degrees north of it and 0.2 east of it
    const north = eyeAt(e, 28.7, 87, 12000)
    const n = fakeRenderer({ error: 3, distanceFromCamera: 3000 }, north.position)
    let margin = 0.1 * DEG
    boundSurfaceViewError(n.renderer, options({ eyeErrorScale: () => 2, eyeMarginRadians: () => margin }))
    expect(viewError(n.renderer, tileOf(n.volume)).error).toBe(3)
    margin = 0.25 * DEG
    expect(viewError(n.renderer, tileOf(n.volume)).error).toBe(6)
    // 0.2 degrees of longitude at 28 N is 0.177 degrees of arc
    const east = eyeAt(e, 28, 87.7, 12000)
    const m = fakeRenderer({ error: 3, distanceFromCamera: 3000 }, east.position)
    let arc = 0.17 * DEG
    boundSurfaceViewError(m.renderer, options({ eyeErrorScale: () => 2, eyeMarginRadians: () => arc }))
    expect(viewError(m.renderer, tileOf(m.volume)).error).toBe(3)
    arc = 0.18 * DEG
    expect(viewError(m.renderer, tileOf(m.volume)).error).toBe(6)
  })

  it('takes every longitude where the margin passes a pole', () => {
    const polar = [10 * DEG, 89 * DEG, 11 * DEG, 90 * DEG, 0, 100]
    const eye = eyeAt(e, 89.99, -170, 12000)
    const { renderer, volume } = fakeRenderer({ error: 3, distanceFromCamera: 3000 }, eye.position)
    boundSurfaceViewError(renderer, options({ eyeErrorScale: () => 2, eyeMarginRadians: () => 0.001 }))
    expect(viewError(renderer, { ...tileOf(volume), boundingVolume: { region: polar } }).error).toBe(6)
  })

  it('scales the near-eye error from the drawn ground (eye inside the box) too', () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const { renderer, volume } = fakeRenderer({ error: Infinity, distanceFromCamera: 0 }, position)
    const bounds = boundSurfaceViewError(renderer, options({ ground: () => 8000, eyeErrorScale: () => 3 }))
    const near = viewError(renderer, tileOf(volume, [], 10))
    expect(near.distanceFromCamera).toBeCloseTo(1000, 6)
    expect(near.error).toBeCloseTo((3 * 10) / (1000 * 0.002), 6)
    expect(bounds.near).toBe(1)
    expect(bounds.underEye).toBe(1)
    expect(bounds.maxError).toBeCloseTo(near.error, 6)
  })

  it('takes the longitude across the antimeridian, and leaves a capped leaf at 0', () => {
    const region = [179.5 * DEG, 27.5 * DEG, 180.5 * DEG, 28.5 * DEG, 7900, 9200]
    const eye = eyeAt(e, 28, -179.8, 12000)
    const { renderer, volume } = fakeRenderer({ error: 2, distanceFromCamera: 3000 }, eye.position)
    boundSurfaceViewError(renderer, options({ eyeErrorScale: () => 2 }))
    expect(viewError(renderer, { ...tileOf(volume), boundingVolume: { region } }).error).toBe(4)
    const coverageLevel = () => 8
    const capped = fakeRenderer({ error: 2, distanceFromCamera: 3000 }, eyeAt(e, 28, 87, 12000).position)
    boundSurfaceViewError(capped.renderer, options({ coverageLevel, hasCoverageEnds: () => true, eyeErrorScale: () => 2 }))
    expect(viewError(capped.renderer, tileOf(capped.volume, [child(0, 0, 13)], 10, [0, 0, 12])).error).toBe(0)
  })
})

describe('the view error past the coverage end (tides-zmw.9.21)', () => {
  const e = ellipsoid()
  // grids at z14 (and under) past the coverage end over x 100-101, y 200-201
  const coverageLevel = (x: number, y: number, level: number) => {
    const s = level - 14
    return level >= 14 && x >> s >= 100 && x >> s <= 101 && y >> s >= 200 && y >> s <= 201 ? 12 : -1
  }

  // a tile and its four children
  const family = (x: number, y: number, level: number) => [0, 1].flatMap((i) => [0, 1].map((j) => child(2 * x + i, 2 * y + j, level + 1)))

  it('caps a tile four levels under the data level all of whose children read grids past it, and no other', () => {
    const { position } = eyeAt(e, 0, 0, 9000)
    const { renderer, volume } = fakeRenderer({ error: 40, distanceFromCamera: 500 }, position)
    const bounds = boundSurfaceViewError(renderer, options({ coverageLevel, hasCoverageEnds: () => true }))
    expect(CAP_LEVELS).toBe(4)
    // z16 (400, 800), data at z12: its z17 children read the z16 grid, past the coverage end
    expect(viewError(renderer, tileOf(volume, family(400, 800, 16), 10, [400, 800, 16])).error).toBe(0)
    // z13 (50, 100) and z15 (200, 400): their children read grids past it, but the data still draws finer
    expect(viewError(renderer, tileOf(volume, family(50, 100, 13), 10, [50, 100, 13])).error).toBe(40)
    expect(viewError(renderer, tileOf(volume, family(200, 400, 15), 10, [200, 400, 15])).error).toBe(40)
    // a child of its own data: refines
    const mixed = [...family(400, 800, 16).slice(1), child(1700, 1600, 17)]
    expect(viewError(renderer, tileOf(volume, mixed, 10, [400, 800, 16])).error).toBe(40)
    // no children (a leaf)
    expect(viewError(renderer, tileOf(volume, [], 10, [400, 800, 16])).error).toBe(40)
    expect(bounds.capped).toBe(1)
    // the floor's tree ends at the capped tile, elsewhere at the tree's deepest
    expect(bounds.deepest(tileOf(volume, family(400, 800, 16), 10, [400, 800, 16]))).toBe(16)
    expect(bounds.deepest(tileOf(volume, family(50, 100, 13), 10, [50, 100, 13]))).toBe(SURFACE_TREE_DEEPEST)
    expect(bounds.deepest(null)).toBe(SURFACE_TREE_DEEPEST)
    renderer.frameCount++
    viewError(renderer, tileOf(volume, []))
    expect(bounds.capped).toBe(0)
  })

  it('caps after the near-eye error, and only with coverage ends known; takes no z0 into the largest error', () => {
    const { position } = eyeAt(e, 28, 87, 9000)
    const kids = family(400, 800, 16)
    const a = fakeRenderer({ error: Infinity, distanceFromCamera: 0 }, position)
    const bounds = boundSurfaceViewError(a.renderer, options({ coverageLevel, hasCoverageEnds: () => true, ground: () => 8900 }))
    const capped = viewError(a.renderer, tileOf(a.volume, kids, 10, [400, 800, 16]))
    expect(capped.error).toBe(0)
    expect(capped.distanceFromCamera).toBeCloseTo(100, 6)
    viewError(a.renderer, tileOf(a.volume, [], 1e5, [0, 0, 0]))
    expect(bounds.maxError).toBe(0)
    const b = fakeRenderer({ error: 40, distanceFromCamera: 500 }, position)
    boundSurfaceViewError(b.renderer, options({ coverageLevel, hasCoverageEnds: () => false }))
    expect(viewError(b.renderer, tileOf(b.volume, kids, 10, [400, 800, 16])).error).toBe(40)
  })
})

describe("the terrain plugin's tile symbols (0.5.3)", () => {
  class FakeOffscreenCanvas {
    getContext() {
      return null
    }
  }
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas))
  afterEach(() => vi.unstubAllGlobals())

  it("finds a tile's x, y and level", async () => {
    const tiles = new TilesRenderer()
    const plugin = new TerrariumMeshPlugin({ url: 'https://example.test/{z}/{x}/{y}.webp', tileDimension: 4, maxZoom: 16 })
    tiles.registerPlugin(plugin)
    ;(tiles as unknown as { preprocessTileset: () => void }).preprocessTileset = () => {}
    const internals = plugin as unknown as { loadRootTileset(): Promise<unknown>; createChild(x: number, y: number, l: number): object }
    await internals.loadRootTileset()
    const tile = internals.createChild(1205, 3232, 13) as Record<symbol, number>
    const sym = terrainTileSymbols(tile)!
    expect([tile[sym.x], tile[sym.y], tile[sym.level]]).toEqual([1205, 3232, 13])
    expect(terrainTileSymbols({})).toBeNull()
  })
})
