import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { latLonToLocal } from '../aurora'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'
import { EARTH_RADIUS } from './ship-bodies'
import {
  FLOOR_CELLS,
  TERRAIN_GREY_MARGIN,
  TERRAIN_MAP_SIZE,
  buildTerrainFloor,
  terrainFloorGrey,
  terrainFloorRadius,
} from './terrain-floor'

const pooled = new Uint8Array(readFileSync(new URL('../assets/earth-terrain-max.bin', import.meta.url)))
const floor = buildTerrainFloor(pooled)
const [POOLED_W, POOLED_H] = TERRAIN_MAP_SIZE

// The bump maps the ground can load (EarthRenderer: 4k high, 2k low), as
// their worst case: every texel as high as its block in the pooled map,
// which by construction it is at or below. Displacing by these bounds the
// real mesh from above.
const SOURCES: SphereSegments[] = [
  [4096, 2048],
  [2048, 1024],
]

// texture2D on a ClampToEdge, flipY'd map: the vertex shader's bilinear read.
function sourceGrey([width, height]: SphereSegments, u: number, v: number): number {
  const bx = width / POOLED_W
  const by = height / POOLED_H
  const texel = (i: number, j: number) => {
    const x = THREE.MathUtils.clamp(i, 0, width - 1)
    const y = THREE.MathUtils.clamp(j, 0, height - 1)
    return pooled[Math.floor(y / by) * POOLED_W + Math.floor(x / bx)]
  }
  const x = u * width - 0.5
  const y = (1 - v) * height - 0.5
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  return (
    (texel(i, j) * (1 - fx) + texel(i + 1, j) * fx) * (1 - fy) +
    (texel(i, j + 1) * (1 - fx) + texel(i + 1, j + 1) * fx) * fy
  )
}

// The ground mesh's vertices, displaced along their normals as the Phong
// material's displacementMap does. SphereGeometry lays them out row by row,
// widthSegments + 1 to a row, north first.
function displacedMesh(segments: SphereSegments, source: SphereSegments): Float64Array {
  const sphere = new THREE.SphereGeometry(EARTH_RADIUS, ...segments)
  const position = sphere.getAttribute('position')
  const uv = sphere.getAttribute('uv')
  const out = new Float64Array(position.count * 3)
  const p = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i)
    const lift = (TERRAIN_DISPLACEMENT * sourceGrey(source, uv.getX(i), uv.getY(i))) / 255
    p.addScaledVector(p.clone().normalize(), lift)
    out.set([p.x, p.y, p.z], i * 3)
  }
  sphere.dispose()
  return out
}

// How far out along `local` a ray from the centre meets the mesh: the
// furthest hit over the cells within two of the one `local` falls in (the
// triangles' chords stray less than one).
const ray = new THREE.Ray()
const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const hit = new THREE.Vector3()
function meshRadius(mesh: Float64Array, [width, height]: SphereSegments, local: THREE.Vector3): number {
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const ix = Math.floor((u - Math.floor(u)) * width)
  const iy = Math.floor((0.5 - Math.asin(local.y) / Math.PI) * height)
  ray.set(new THREE.Vector3(), local)
  const vertex = (target: THREE.Vector3, x: number, y: number) =>
    target.fromArray(mesh, (y * (width + 1) + x) * 3)
  let best = -Infinity
  for (let dy = -2; dy <= 2; dy++) {
    const y = iy + dy
    if (y < 0 || y >= height) continue
    for (let dx = -2; dx <= 2; dx++) {
      const x = (((ix + dx) % width) + width) % width
      const [a, b, c, d] = corners
      vertex(a, x + 1, y)
      vertex(b, x, y)
      vertex(c, x, y + 1)
      vertex(d, x + 1, y + 1)
      for (const [p, q, r] of [
        [a, b, d],
        [b, c, d],
      ]) {
        if (ray.intersectTriangle(p, q, r, false, hit)) best = Math.max(best, hit.length())
      }
    }
  }
  return best
}

// Deterministic LCG so failures reproduce.
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32
    return s / 2 ** 32
  }
}

const REGIONS = {
  Himalaya: { lat: [26, 38], lon: [72, 98] },
  Andes: { lat: [-34, -8], lon: [-78, -62] },
  // Clear of every island's cell and its neighbours.
  'open Pacific': { lat: [-45, -30], lon: [-130, -100] },
} as const

function sweep(region: keyof typeof REGIONS, count: number): THREE.Vector3[] {
  const rand = random(region.length)
  const { lat, lon } = REGIONS[region]
  return Array.from({ length: count }, () =>
    latLonToLocal(lat[0] + (lat[1] - lat[0]) * rand(), lon[0] + (lon[1] - lon[0]) * rand())
  )
}

describe('terrain floor (tides-01v.8.3)', () => {
  const meshes = [FLOOR_CELLS, LIMB_SEGMENTS].flatMap((segments) =>
    SOURCES.map((source) => ({ segments, source, mesh: displacedMesh(segments, source) }))
  )

  it('nests the limb mesh in the floor cells and the cells in the pooled map', () => {
    expect(LIMB_SEGMENTS[0] % FLOOR_CELLS[0]).toBe(0)
    expect(LIMB_SEGMENTS[1] % FLOOR_CELLS[1]).toBe(0)
    expect(pooled.length).toBe(POOLED_W * POOLED_H)
    expect(POOLED_W % FLOOR_CELLS[0]).toBe(0)
    expect(POOLED_H % FLOOR_CELLS[1]).toBe(0)
  })

  it.each(Object.keys(REGIONS) as (keyof typeof REGIONS)[])(
    'never reads below the displaced ground mesh over the %s',
    (region) => {
      for (const local of sweep(region, 3000)) {
        const radius = terrainFloorRadius(floor, EARTH_RADIUS, local)
        for (const { segments, mesh } of meshes) {
          const ground = meshRadius(mesh, segments, local)
          expect(ground).toBeGreaterThan(EARTH_RADIUS * 0.99)
          expect(radius, `${local.toArray()} on ${segments}`).toBeGreaterThanOrEqual(ground)
        }
      }
    },
    60_000
  )

  it('never reads below the mesh anywhere: the whole globe, the poles and the date line', () => {
    const rand = random(99)
    const lat = (min: number, max: number) =>
      (Math.asin(Math.sin((min * Math.PI) / 180) + (Math.sin((max * Math.PI) / 180) - Math.sin((min * Math.PI) / 180)) * rand()) * 180) / Math.PI
    const directions = [
      ...Array.from({ length: 6000 }, () => latLonToLocal(lat(-90, 90), 360 * rand() - 180)),
      ...Array.from({ length: 2000 }, () => latLonToLocal(lat(80, 90), 360 * rand() - 180)),
      ...Array.from({ length: 2000 }, () => latLonToLocal(lat(-90, -80), 360 * rand() - 180)),
      ...Array.from({ length: 1000 }, () => latLonToLocal(lat(-80, 80), 178 + 4 * rand())),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, -1, 0),
    ]
    for (const local of directions) {
      const radius = terrainFloorRadius(floor, EARTH_RADIUS, local)
      for (const { segments, mesh } of meshes) {
        const ground = meshRadius(mesh, segments, local)
        expect(radius, `${local.toArray()} on ${segments}`).toBeGreaterThanOrEqual(ground)
      }
    }
  }, 60_000)

  it('stays close over the ocean and under the highest peak plus the margin', () => {
    // A level of JPEG noise on top of the margin.
    const margin = (TERRAIN_DISPLACEMENT * (TERRAIN_GREY_MARGIN + 1)) / 255
    for (const local of sweep('open Pacific', 500)) {
      expect(terrainFloorRadius(floor, EARTH_RADIUS, local)).toBeLessThanOrEqual(EARTH_RADIUS + margin + 1e-12)
    }
    const peak = (TERRAIN_DISPLACEMENT * (pooled.reduce((a, b) => Math.max(a, b), 0) + TERRAIN_GREY_MARGIN)) / 255
    for (const local of sweep('Himalaya', 500)) {
      expect(terrainFloorRadius(floor, EARTH_RADIUS, local)).toBeLessThanOrEqual(EARTH_RADIUS + peak + 1e-12)
    }
  })

  it('needs the max: a point sample of the map dips below the mesh in the Himalaya', () => {
    const [{ segments, mesh }] = meshes
    const below = sweep('Himalaya', 3000).filter((local) => {
      const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
      const v = 0.5 + Math.asin(local.y) / Math.PI
      const point = EARTH_RADIUS + (TERRAIN_DISPLACEMENT * sourceGrey(SOURCES[0], u - Math.floor(u), v)) / 255
      return point < meshRadius(mesh, segments, local) - 1e-4
    })
    expect(below.length).toBeGreaterThan(0)
  })

  it('reads Earth the right way round: high in Tibet, sea level in the Pacific', () => {
    expect(terrainFloorGrey(floor, latLonToLocal(32, 88))).toBeGreaterThan(150)
    expect(terrainFloorGrey(floor, latLonToLocal(-16, -68))).toBeGreaterThan(100)
    expect(terrainFloorGrey(floor, latLonToLocal(-40, -115))).toBe(TERRAIN_GREY_MARGIN)
    // Its mirror images are ocean.
    expect(terrainFloorGrey(floor, latLonToLocal(-32, 88))).toBeLessThan(40)
    expect(terrainFloorGrey(floor, latLonToLocal(32, -88))).toBeLessThan(80)
  })

  it('is continuous across the date line and finite at the poles', () => {
    for (const lat of [-60, 0, 65]) {
      const east = terrainFloorGrey(floor, latLonToLocal(lat, 179.999))
      const west = terrainFloorGrey(floor, latLonToLocal(lat, -179.999))
      expect(Math.abs(east - west)).toBeLessThan(0.5)
    }
    for (const y of [1, -1]) {
      expect(Number.isFinite(terrainFloorGrey(floor, new THREE.Vector3(0, y, 0)))).toBe(true)
    }
  })

  it('falls back to the highest the ground can reach before the map loads', () => {
    expect(terrainFloorRadius(null, EARTH_RADIUS, latLonToLocal(0, -150))).toBe(
      EARTH_RADIUS + TERRAIN_DISPLACEMENT
    )
  })

  it('rejects a map that does not tile the cells', () => {
    expect(() => buildTerrainFloor(new Uint8Array(100), [10, 10], [3, 3])).toThrow()
    expect(() => buildTerrainFloor(new Uint8Array(10), [10, 10], [5, 5])).toThrow()
  })
})
