import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { FULL_RANGE, limbRowRange, sphereRowRange, type IndexRange } from './limb-rows'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'
import { EARTH_RADIUS } from './ship-bodies'
import { GROUND_HEIGHT_MAX } from '../renderers/groundDisplacement'
import { DEM_METRES_PER_UNIT, decodeEarthDem } from '../earth-dem'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'

const R = EARTH_RADIUS
const KM = R / 6371
const LIFT = { min: 0, max: GROUND_HEIGHT_MAX * TERRAIN_DISPLACEMENT }

// The eye `km` over latitude `lat`, longitude `lon` (degrees), in the sphere's frame.
function eyeAt(lat: number, lon: number, km: number, radius = R) {
  const theta = THREE.MathUtils.degToRad(90 - lat)
  const phi = THREE.MathUtils.degToRad(lon)
  return new THREE.Vector3().setFromSphericalCoords(radius + km * KM, theta, phi)
}

const rowsOf = ({ start, count }: IndexRange, [width, height]: SphereSegments) => {
  if (count === Infinity) return [0, height - 1]
  const triangle = (i: number) => {
    const at = i / 3
    if (at < width) return 0
    return Math.min(height - 1, 1 + Math.floor((at - width) / (2 * width)))
  }
  return [triangle(start), triangle(start + count - 3)]
}

describe("the limb sphere's rows (tides-0oi.8)", () => {
  it("maps each triangle row to the triangles of THREE.SphereGeometry's index between its two vertex rows", () => {
    for (const segments of [LIMB_SEGMENTS, [64, 32] as SphereSegments, [8, 3] as SphereSegments]) {
      const [width, height] = segments
      const index = new THREE.SphereGeometry(1, width, height).index!.array
      let next = 0
      const strays: number[] = []
      for (let row = 0; row < height; row++) {
        const { start, count } = sphereRowRange(row, row, segments)
        expect(start).toBe(next)
        expect(count).toBe(3 * (row === 0 || row === height - 1 ? width : 2 * width))
        for (let i = start; i < start + count; i++) {
          const vertexRow = Math.floor(index[i] / (width + 1))
          if (vertexRow !== row && vertexRow !== row + 1) strays.push(i)
        }
        next = start + count
      }
      expect(strays).toEqual([])
      expect(next).toBe(index.length)
      expect(sphereRowRange(0, height - 1, segments)).toEqual({ start: 0, count: index.length })
    }
  })

  it('keeps a band about the eye from close zoom, a sixth of the rows at 100 km', () => {
    const range = limbRowRange(eyeAt(30, -100, 100), R, LIMB_SEGMENTS, LIFT)
    const total = sphereRowRange(0, LIMB_SEGMENTS[1] - 1, LIMB_SEGMENTS).count
    expect(range.count / total).toBeGreaterThan(0.05)
    expect(range.count / total).toBeLessThan(0.2)
    const [first, last] = rowsOf(range, LIMB_SEGMENTS)
    // 30° N is row ~85 of 256: the band holds it, and more of it south.
    expect(first).toBeLessThan(85)
    expect(last).toBeGreaterThan(85)
    // Wider with the eye higher.
    expect(limbRowRange(eyeAt(30, -100, 400), R, LIMB_SEGMENTS, LIFT).count).toBeGreaterThan(range.count)
  })

  it('turns with the eye only by its latitude', () => {
    const a = limbRowRange(eyeAt(30, -100, 100), R, LIMB_SEGMENTS, LIFT)
    expect(limbRowRange(eyeAt(30, 170, 100), R, LIMB_SEGMENTS, LIFT)).toEqual(a)
    // Mirrored about the equator.
    const [first, last] = rowsOf(a, LIMB_SEGMENTS)
    const [sFirst, sLast] = rowsOf(limbRowRange(eyeAt(-30, -100, 100), R, LIMB_SEGMENTS, LIFT), LIMB_SEGMENTS)
    expect(sFirst).toBe(LIMB_SEGMENTS[1] - 1 - last)
    expect(sLast).toBe(LIMB_SEGMENTS[1] - 1 - first)
  })

  it('runs from the pole when the cap holds it, over either pole', () => {
    const north = limbRowRange(eyeAt(88, 40, 100), R, LIMB_SEGMENTS, LIFT)
    expect(north.start).toBe(0)
    expect(north.count).toBeLessThan(FULL_RANGE.count)
    const [, last] = rowsOf(limbRowRange(eyeAt(-90, 0, 100), R, LIMB_SEGMENTS, LIFT), LIMB_SEGMENTS)
    const south = limbRowRange(eyeAt(-90, 0, 100), R, LIMB_SEGMENTS, LIFT)
    expect(last).toBe(LIMB_SEGMENTS[1] - 1)
    expect(south.start + south.count).toBe(sphereRowRange(0, LIMB_SEGMENTS[1] - 1, LIMB_SEGMENTS).count)
  })

  it('draws it all from high up, from inside, and for an eye it cannot place', () => {
    expect(limbRowRange(eyeAt(0, 0, 40 * 6371), R, LIMB_SEGMENTS, LIFT)).toEqual(FULL_RANGE)
    // Short of that, a band that grows with the height.
    expect(limbRowRange(eyeAt(0, 0, 3 * 6371), R, LIMB_SEGMENTS, LIFT).count).toBeGreaterThan(0.8 * sphereRowRange(0, 255, LIMB_SEGMENTS).count)
    expect(limbRowRange(eyeAt(0, 0, -1), R, LIMB_SEGMENTS, LIFT)).toEqual(FULL_RANGE)
    expect(limbRowRange({ x: 0, y: 0, z: 0 }, R, LIMB_SEGMENTS, LIFT)).toEqual(FULL_RANGE)
    expect(limbRowRange({ x: NaN, y: 0, z: R * 2 }, R, LIMB_SEGMENTS, LIFT)).toEqual(FULL_RANGE)
  })

  it("leaves out no triangle the eye can see over the ground's bulge", () => {
    // A coarse sphere, so every triangle is checked: each corner raised by
    // any lift up to the most, and the facets' centres, seen from close,
    // grazing and far eyes. Visible: the line from the eye clears the drawn
    // sphere's inner ball (its facets' least distance from the centre).
    const segments: SphereSegments = [64, 32]
    const [width, height] = segments
    const geometry = new THREE.SphereGeometry(R, width, height)
    const position = geometry.getAttribute('position')
    const index = geometry.index!.array
    const lift = { min: 0, max: 0.02 * R }
    const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const plane = new THREE.Plane()
    let inner = Infinity
    for (let i = 0; i < index.length; i += 3) {
      for (let k = 0; k < 3; k++) corner[k].fromBufferAttribute(position, index[i + k])
      plane.setFromCoplanarPoints(corner[0], corner[1], corner[2])
      if (Number.isFinite(plane.constant)) inner = Math.min(inner, Math.abs(plane.constant))
    }
    const clears = (eye: THREE.Vector3, point: THREE.Vector3) => {
      const ray = new THREE.Ray(eye, point.clone().sub(eye).normalize())
      const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), inner), new THREE.Vector3())
      return hit == null || hit.distanceTo(eye) > point.distanceTo(eye) - 1e-9 * R
    }
    const raised = (p: THREE.Vector3, by: number) => p.clone().multiplyScalar((R + by) / R)
    let checked = 0
    const missed: string[] = []
    for (const [lat, lon, km] of [
      [30, -100, 100], [0, 10, 20], [88, 40, 400], [-89.9, 0, 50], [60, 120, 2000], [-45, 75, 6000],
    ]) {
      const eye = eyeAt(lat, lon, km)
      const range = limbRowRange(eye, R, segments, lift)
      const [first, last] = rowsOf(range, segments)
      for (let i = 0; i < index.length; i += 3) {
        const row = rowsOf({ start: i, count: 3 }, segments)[0]
        if (row >= first && row <= last) continue
        for (let k = 0; k < 3; k++) corner[k].fromBufferAttribute(position, index[i + k])
        const centre = corner[0].clone().add(corner[1]).add(corner[2]).divideScalar(3)
        for (const by of [0, 0.5 * lift.max, lift.max]) {
          for (const p of [...corner, centre]) {
            if (clears(eye, raised(p, by))) missed.push(`${lat},${lon},${km}: triangle ${i / 3}`)
            checked++
          }
        }
      }
    }
    expect(missed).toEqual([])
    expect(checked).toBeGreaterThan(10000)
  })

  it("bounds the bundled maps' heights by GROUND_HEIGHT_MAX", async () => {
    for (const file of ['earth-dem-2k.bin', 'earth-dem-4k.bin']) {
      const { metres } = await decodeEarthDem(readFileSync(new URL(`../assets/${file}`, import.meta.url)))
      let top = 0
      for (const m of metres) top = Math.max(top, m)
      expect(top / DEM_METRES_PER_UNIT).toBeLessThan(GROUND_HEIGHT_MAX)
    }
  })
})
