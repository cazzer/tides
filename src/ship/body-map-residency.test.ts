import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DRAW_PROMOTE_RADIUS_PX,
  PROMOTE_RADIUS_PX,
  PROXY_WIDTH,
  URGENT_RADIUS_PX,
  bodyMapTier,
  bodyRadiusPx,
  buildMapProxy,
  createUploadBudget,
  fullMapOf,
  offAxisScale,
  projectedRadiusPx,
  promoteAtDraw,
  proxyBaseLevel,
  shipMapStep,
  shouldUploadNow,
  systemMapStep,
  type SystemMapStep,
} from './body-map-residency'
import { limbFacetPx } from './limb-detail'
import { SHIP_FOV } from './ship-session'

// Screens a ship View can have: device rows and vertical FOVs.
const SCREENS = [400, 600, 1688, 2400, 4000].flatMap((rows) => [30, SHIP_FOV, 100].map((fov) => ({ rows, fov })))
const pxPerRadian = ({ rows, fov }: { rows: number; fov: number }) => rows / 2 / Math.tan(((fov / 2) * Math.PI) / 180)
/** The eye's distance, in radii, that shows a body `radiusPx` in radius. */
const eyeOverR = (radiusPx: number, screen: { rows: number; fov: number }) => 1 / Math.sin(radiusPx / pxPerRadian(screen))
/** Surface radians per pixel at the disk's centre, the finest anywhere on it (the shader's fp there). */
const centreFootprint = (x: number, screen: { rows: number; fov: number }) => (x - 1) / pxPerRadian(screen)

describe('projectedRadiusPx', () => {
  it('uses limbFacetPx px per radian', () => {
    // limbFacetPx is the difference of two such angular radii.
    const segments = [64, 32] as const
    const halfDiagonal = 0.5 * Math.hypot((2 * Math.PI) / 64, Math.PI / 32)
    const depth = 1 - Math.cos(halfDiagonal)
    for (const x of [1.5, 3, 20]) {
      const facet = projectedRadiusPx(x, 1, 1688, SHIP_FOV) - projectedRadiusPx(x, 1 - depth, 1688, SHIP_FOV)
      expect(facet).toBeCloseTo(limbFacetPx(segments, x, 1688, SHIP_FOV), 9)
    }
  })

  it('reads a quarter turn from inside the sphere', () => {
    expect(projectedRadiusPx(0.5, 1, 1000, 90)).toBeCloseTo((Math.PI / 2) * 500, 9)
  })

  it('reads a far body by its angular radius', () => {
    expect(projectedRadiusPx(1000, 1, 1000, 90)).toBeCloseTo(Math.asin(0.001) * 500, 9)
  })
})

describe('bodyMapTier', () => {
  it('turns full at PROMOTE_RADIUS_PX', () => {
    expect(bodyMapTier(PROMOTE_RADIUS_PX - 0.01, false)).toBe('proxy')
    expect(bodyMapTier(PROMOTE_RADIUS_PX, false)).toBe('full')
  })

  it('stays full once promoted', () => {
    expect(bodyMapTier(0.1, true)).toBe('full')
  })
})

describe('shouldUploadNow', () => {
  it('waits for a free slot up to URGENT_RADIUS_PX', () => {
    expect(shouldUploadNow(PROMOTE_RADIUS_PX - 0.01, true)).toBe(false)
    expect(shouldUploadNow(PROMOTE_RADIUS_PX, true)).toBe(true)
    expect(shouldUploadNow(URGENT_RADIUS_PX, false)).toBe(false)
  })

  it('skips the budget past URGENT_RADIUS_PX', () => {
    expect(shouldUploadNow(URGENT_RADIUS_PX + 0.01, false)).toBe(true)
  })
})

describe('createUploadBudget', () => {
  it('allows one take per frame key', () => {
    const budget = createUploadBudget()
    expect(budget.free(1)).toBe(true)
    expect(budget.take(1)).toBe(true)
    expect(budget.free(1)).toBe(false)
    expect(budget.take(1)).toBe(false)
    expect(budget.free(1.016)).toBe(true)
    expect(budget.take(1.016)).toBe(true)
  })
})

describe('proxyBaseLevel', () => {
  it('is the level PROXY_WIDTH wide', () => {
    expect(proxyBaseLevel(2048)).toBe(3)
    expect(proxyBaseLevel(1024)).toBe(2)
  })

  it('is null where there is nothing to save or no such level', () => {
    expect(proxyBaseLevel(256)).toBeNull()
    expect(proxyBaseLevel(128)).toBeNull()
    expect(proxyBaseLevel(1536)).toBeNull()
  })
})

function sourceMap(width: number, height: number): THREE.Texture {
  const map = new THREE.Texture({ width, height } as unknown as HTMLImageElement)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 16
  map.wrapS = THREE.RepeatWrapping
  map.wrapT = THREE.MirroredRepeatWrapping
  map.magFilter = THREE.LinearFilter
  map.minFilter = THREE.LinearMipmapLinearFilter
  return map
}

describe('buildMapProxy', () => {
  const read = (reads: number[]) => (level: number, width: number, height: number) => {
    reads.push(level)
    return new Uint8Array(width * height * 4).fill(level)
  }

  it("holds the map's levels from PROXY_WIDTH down to 1 × 1", () => {
    const reads: number[] = []
    const proxy = buildMapProxy(sourceMap(2048, 1024), read(reads))!
    expect(reads).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])
    const levels = proxy.mipmaps as unknown as { width: number; height: number; data: Uint8Array }[]
    expect(levels.map(({ width, height }) => [width, height])).toEqual([
      [256, 128],
      [128, 64],
      [64, 32],
      [32, 16],
      [16, 8],
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1],
    ])
    expect(levels[0].data[0]).toBe(3)
    expect(proxy.image.width).toBe(PROXY_WIDTH)
    expect(proxy.generateMipmaps).toBe(false)
  })

  it("keeps the map's sampler state", () => {
    const map = sourceMap(1024, 512)
    const proxy = buildMapProxy(map, read([]))!
    expect(proxy.mipmaps).toHaveLength(9)
    expect(proxy.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(proxy.anisotropy).toBe(16)
    expect(proxy.wrapS).toBe(THREE.RepeatWrapping)
    expect(proxy.wrapT).toBe(THREE.MirroredRepeatWrapping)
    expect(proxy.magFilter).toBe(THREE.LinearFilter)
    expect(proxy.minFilter).toBe(THREE.LinearMipmapLinearFilter)
    expect(proxy.format).toBe(THREE.RGBAFormat)
    expect(proxy.type).toBe(THREE.UnsignedByteType)
    expect(proxy.flipY).toBe(false)
    expect(fullMapOf(proxy)).toBe(map)
    expect(fullMapOf(map)).toBeUndefined()
  })

  it('declines a map without a mip chain, or one it cannot read', () => {
    const flat = sourceMap(2048, 1024)
    flat.minFilter = THREE.LinearFilter
    expect(buildMapProxy(flat, read([]))).toBeNull()
    expect(buildMapProxy(sourceMap(256, 128), read([]))).toBeNull()
    expect(buildMapProxy(sourceMap(2048, 1024), () => null)).toBeNull()
  })
})

// Why the proxy draws exactly what the full map would (body-map-residency.ts).
describe('the proxy stays exact up to promotion', () => {
  it('keeps two levels of LOD margin at URGENT_RADIUS_PX far off', () => {
    // A far body's centre spans 1 / r radians per px; its LOD reaches the
    // proxy's top level at r = PROXY_WIDTH / 2π px.
    expect(URGENT_RADIUS_PX * 4).toBeLessThanOrEqual(PROXY_WIDTH / (2 * Math.PI))
  })

  it('keeps the full map at or above the proxy level wherever the proxy can show', () => {
    for (const screen of SCREENS) {
      const x = eyeOverR(URGENT_RADIUS_PX, screen)
      // Texels per px of the full map, in units of the proxy's top level.
      const lodMargin = Math.log2(centreFootprint(x, screen) / ((2 * Math.PI) / PROXY_WIDTH))
      expect(lodMargin).toBeGreaterThan(1.9)
    }
  })

  it("keeps the shader's detail gate shut for the proxy's textureSize", () => {
    // fragment.frag: texel = π / textureSize(uMap, 0).y, and the detail is
    // off while log2(texel / fp) ≤ 1. The full map's texel is finer, so it
    // is off for both until well past where the LOD margin above runs out.
    const proxyTexel = Math.PI / (PROXY_WIDTH / 2)
    for (const screen of SCREENS) {
      const x = eyeOverR(4 * URGENT_RADIUS_PX, screen)
      expect(Math.log2(proxyTexel / centreFootprint(x, screen))).toBeLessThanOrEqual(1)
    }
  })
})

describe('offAxisScale', () => {
  it('is 1 on the axis and 1/cos² toward the corners', () => {
    expect(offAxisScale(1, 60, 16 / 9)).toBe(1)
    const cos = Math.cos((30 * Math.PI) / 180)
    expect(offAxisScale(cos, 60, 16 / 9)).toBeCloseTo(1 / (cos * cos), 12)
  })

  it('is 1 past the corner and behind the eye', () => {
    // A 60° view at 16:9 reaches ~49.7° in its corners.
    expect(offAxisScale(Math.cos((49 * Math.PI) / 180), 60, 16 / 9)).toBeGreaterThan(2)
    expect(offAxisScale(Math.cos((51 * Math.PI) / 180), 60, 16 / 9)).toBe(1)
    expect(offAxisScale(-0.5, 60, 16 / 9)).toBe(1)
  })
})

describe('bodyRadiusPx', () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9)
  camera.updateMatrixWorld()

  it('is projectedRadiusPx on the axis', () => {
    expect(bodyRadiusPx(camera, new THREE.Vector3(0, 0, -100), 1, 1000)).toBeCloseTo(
      projectedRadiusPx(100, 1, 1000, 60),
      9
    )
  })

  it('counts the stretch off the axis', () => {
    const centre = new THREE.Vector3(0, 100 * Math.tan(0.4), -100)
    const cos = Math.cos(0.4)
    expect(bodyRadiusPx(camera, centre, 1, 1000)).toBeCloseTo(
      projectedRadiusPx(centre.length(), 1, 1000, 60) / (cos * cos),
      9
    )
  })
})

describe('shipMapStep', () => {
  const step = (radiusPx: number, over: Partial<Parameters<typeof shipMapStep>[0]> = {}) =>
    shipMapStep({ promoted: false, radiusPx, slotFree: true, showsProxy: false, proxyCached: false, ...over })

  it('does nothing more once promoted', () => {
    expect(step(50, { promoted: true })).toBe('none')
  })

  it('promotes a body past PROMOTE_RADIUS_PX straight from its full map, never reading it back', () => {
    expect(step(PROMOTE_RADIUS_PX)).toBe('promote')
    expect(step(PROMOTE_RADIUS_PX, { proxyCached: true })).toBe('promote')
    expect(step(PROMOTE_RADIUS_PX, { showsProxy: true })).toBe('promote')
  })

  it('waits for the slot up to URGENT_RADIUS_PX, then takes no turn', () => {
    expect(step(URGENT_RADIUS_PX, { slotFree: false })).toBe('wait')
    expect(step(URGENT_RADIUS_PX + 0.01, { slotFree: false })).toBe('promote')
  })

  it('binds a cached proxy without the slot, and builds one with it', () => {
    expect(step(2, { proxyCached: true, slotFree: false })).toBe('proxy')
    expect(step(2)).toBe('build')
    expect(step(2, { slotFree: false })).toBe('wait')
    expect(step(2, { showsProxy: true, proxyCached: true })).toBe('none')
  })
})

describe('systemMapStep', () => {
  it('leaves a full map be', () => {
    expect(systemMapStep({ showsProxy: false, retired: true, slotFree: true })).toBe('none')
  })

  it('brings retired maps back one a frame, every View showing each as it returns', () => {
    // 26 maps, each drawn by three Views (the system view and its panels).
    const budget = createUploadBudget()
    const retired = new Set(Array.from({ length: 26 }, (_, i) => i))
    const showsProxy = [0, 1, 2].map(() => new Set(retired))
    const restoredAt: number[] = []
    let frame = 0
    while (showsProxy.some((views) => views.size > 0) && frame < 100) {
      frame++
      for (const views of showsProxy) {
        for (const map of [...views]) {
          const step: SystemMapStep = systemMapStep({
            showsProxy: true,
            retired: retired.has(map),
            slotFree: budget.free(frame),
          })
          if (step === 'restore') {
            budget.take(frame)
            retired.delete(map)
            restoredAt.push(frame)
          }
          if (step === 'restore' || step === 'show') views.delete(map)
        }
      }
    }
    expect(restoredAt).toEqual(Array.from({ length: 26 }, (_, i) => i + 1))
    expect(frame).toBe(26)
  })
})

describe('the proxy stays exact off the view axis', () => {
  // Phone portrait, desktop 16:9, at the ship's FOV, its speed kick (70°) and a wide 100°.
  const VIEWS = [390 / 844, 16 / 9].flatMap((aspect) => [SHIP_FOV, 70, 100].map((fov) => ({ aspect, fov })))

  it('keeps two levels of LOD margin into the corners at URGENT_RADIUS_PX', () => {
    for (const { aspect, fov } of VIEWS) {
      for (const rows of [600, 1688]) {
        const screen = { rows, fov }
        const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180)
        const corner = Math.atan(tanHalf * Math.sqrt(1 + aspect * aspect))
        for (let k = 0; k <= 10; k++) {
          const phi = ((corner * k) / 10) * 0.999
          const cos2 = Math.cos(phi) ** 2
          expect(offAxisScale(Math.cos(phi), fov, aspect)).toBeCloseTo(1 / cos2, 9)
          // bodyRadiusPx = URGENT there: on-axis it measures URGENT · cos²φ.
          const x = eyeOverR(URGENT_RADIUS_PX * cos2, screen)
          // A pixel there spans cos²φ of an on-axis one, radially.
          const footprint = centreFootprint(x, screen) * cos2
          expect(Math.log2(footprint / ((2 * Math.PI) / PROXY_WIDTH))).toBeGreaterThan(1.9)
          const gateFootprint = centreFootprint(eyeOverR(4 * URGENT_RADIUS_PX * cos2, screen), screen) * cos2
          expect(Math.log2(Math.PI / (PROXY_WIDTH / 2) / gateFootprint)).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('promoteAtDraw', () => {
  it('leaves the frame callbacks the promotions they can make in time', () => {
    expect(promoteAtDraw(URGENT_RADIUS_PX + 1)).toBe(false)
    expect(promoteAtDraw(DRAW_PROMOTE_RADIUS_PX)).toBe(false)
    expect(promoteAtDraw(DRAW_PROMOTE_RADIUS_PX + 0.01)).toBe(true)
    expect(promoteAtDraw(80)).toBe(true)
  })

  it('swaps while the proxy is still exact, a level of LOD margin left, into the corners', () => {
    for (const aspect of [390 / 844, 16 / 9]) {
      for (const fov of [SHIP_FOV, 70, 100]) {
        for (const rows of [600, 1688]) {
          const screen = { rows, fov }
          const tanHalf = Math.tan(((fov / 2) * Math.PI) / 180)
          const corner = Math.atan(tanHalf * Math.sqrt(1 + aspect * aspect))
          for (let k = 0; k <= 10; k++) {
            const cos2 = Math.cos(((corner * k) / 10) * 0.999) ** 2
            const x = eyeOverR(DRAW_PROMOTE_RADIUS_PX * cos2, screen)
            const footprint = centreFootprint(x, screen) * cos2
            expect(Math.log2(footprint / ((2 * Math.PI) / PROXY_WIDTH))).toBeGreaterThan(0.9)
          }
        }
      }
    }
  })
})
