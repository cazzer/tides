import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { latLonToLocal } from '../aurora'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'
import { EARTH_RADIUS } from './ship-bodies'
import { decodeEarthDem } from '../earth-dem'
import { displace, groundLevels, meshGrid, meshRadius, vertexGrey } from './ground-mesh-model'
import {
  EARTH_BASE_SEGMENTS,
  TERRAIN_FALLBACK_GREY,
  TERRAIN_GREY_MARGIN,
  buildTerrainFloor,
  meanGrey,
  terrainFloorGrey,
  terrainFloorGreyAround,
  terrainFloorRadius,
  type TerrainFloor,
} from './terrain-floor'

const shipped = (name: string) => decodeEarthDem(readFileSync(new URL(`../assets/${name}`, import.meta.url)))
const [demMean, dem4k, dem2k] = await Promise.all(['earth-dem-mean.bin', 'earth-dem-4k.bin', 'earth-dem-2k.bin'].map(shipped))
const mean = meanGrey(demMean)

// The floors, each with the meshes it covers: its sphere displaced from
// either tier's map (EarthRenderer: 4k high, 2k low) as the GPU does it.
interface Case {
  name: string
  segments: SphereSegments
  floor: TerrainFloor
  meshes: { source: string; mesh: Float64Array }[]
}
const CASES: Case[] = (
  [
    ['128 × 128 sphere', EARTH_BASE_SEGMENTS],
    ['limb sphere', LIMB_SEGMENTS],
  ] as const
).map(([name, segments]) => {
  const grid = meshGrid(segments)
  return {
    name,
    segments,
    floor: buildTerrainFloor(mean, segments),
    meshes: [
      ['4k', dem4k],
      ['2k', dem2k],
    ].map(([source, dem]) => ({
      source: source as string,
      mesh: displace(grid, vertexGrey(groundLevels(dem as typeof dem4k), grid), EARTH_RADIUS),
    })),
  }
})
const [base, limb] = CASES

const toGrey = (units: number) => (units / TERRAIN_DISPLACEMENT) * 255
// How far a flat triangle's middle sits inside the sphere through its
// corners: the quad's widest, at the equator, in grey levels.
const sag = ([width, height]: SphereSegments) =>
  toGrey(EARTH_RADIUS * (1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))))

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
  // Clear of every island's triangles.
  'open Pacific': { lat: [-45, -31], lon: [-130, -100] },
} as const

function sweep(region: keyof typeof REGIONS, count: number): THREE.Vector3[] {
  const rand = random(region.length)
  const { lat, lon } = REGIONS[region]
  return Array.from({ length: count }, () =>
    latLonToLocal(lat[0] + (lat[1] - lat[0]) * rand(), lon[0] + (lon[1] - lon[0]) * rand())
  )
}

function globe(seed: number): THREE.Vector3[] {
  const rand = random(seed)
  const lat = (min: number, max: number) => {
    const [a, b] = [min, max].map((d) => Math.sin((d * Math.PI) / 180))
    return (Math.asin(a + (b - a) * rand()) * 180) / Math.PI
  }
  return [
    ...Array.from({ length: 6000 }, () => latLonToLocal(lat(-90, 90), 360 * rand() - 180)),
    ...Array.from({ length: 1500 }, () => latLonToLocal(lat(80, 90), 360 * rand() - 180)),
    ...Array.from({ length: 1500 }, () => latLonToLocal(lat(-90, -80), 360 * rand() - 180)),
    ...Array.from({ length: 1000 }, () => latLonToLocal(lat(-80, 80), 178 + 4 * rand())),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
  ]
}

// A direction's mesh row, and whether that is a polar fan (where the floor
// takes the row's highest vertex, so it stands well clear).
const polar = ([, height]: SphereSegments, local: THREE.Vector3) => {
  const j = Math.floor((0.5 - Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / Math.PI) * height)
  return j <= 0 || j >= height - 1
}

describe('terrain floor (tides-01v.8.3, tides-zmw.2)', () => {
  it.each(CASES.flatMap((c) => (Object.keys(REGIONS) as (keyof typeof REGIONS)[]).map((region) => [c.name, region, c] as const)))(
    "on the %s, sits on the drawn ground over the %s: never below it, and within the margin and the triangles' sag",
    (_, region, { segments, floor, meshes }) => {
      for (const local of sweep(region, 3000)) {
        const radius = terrainFloorRadius(floor, EARTH_RADIUS, local)
        for (const { source, mesh } of meshes) {
          const ground = meshRadius(mesh, segments, local)
          expect(ground).toBeGreaterThan(EARTH_RADIUS * 0.99)
          expect(radius, `${local.toArray()} from ${source}`).toBeGreaterThanOrEqual(ground)
          expect(toGrey(radius - ground)).toBeLessThanOrEqual(TERRAIN_GREY_MARGIN + sag(segments) + 0.5)
        }
      }
    },
    60_000
  )

  it.each(CASES.map((c) => [c.name, c] as const))(
    'on the %s, never reads below the drawn ground anywhere: the whole globe, the poles and the date line',
    (_, { segments, floor, meshes }) => {
      let tightest = Infinity
      for (const local of globe(segments[0])) {
        const radius = terrainFloorRadius(floor, EARTH_RADIUS, local)
        for (const { source, mesh } of meshes) {
          const ground = meshRadius(mesh, segments, local)
          expect(radius, `${local.toArray()} from ${source}`).toBeGreaterThanOrEqual(ground)
          if (!polar(segments, local)) {
            expect(toGrey(radius - ground)).toBeLessThanOrEqual(TERRAIN_GREY_MARGIN + sag(segments) + 0.5)
          }
          tightest = Math.min(tightest, toGrey(radius - ground))
        }
      }
      // Nearly all of the margin is to spare: the floor tracks the mesh.
      expect(tightest).toBeGreaterThan(0.2)
    },
    60_000
  )

  it('stands the limb sphere lower than the 128 × 128 one over the peaks it rounds off, and higher over the ones it shows', () => {
    // Neither floor bounds the other: the limb sphere's finer level keeps
    // more of each peak, and its finer triangles sag less between them.
    const k2 = latLonToLocal(35.88, 76.51)
    expect(terrainFloorGrey(limb.floor, k2)).toBeGreaterThan(terrainFloorGrey(base.floor, k2))
    let lower = 0
    const points = sweep('Himalaya', 2000)
    for (const local of points) if (terrainFloorGrey(limb.floor, local) < terrainFloorGrey(base.floor, local)) lower++
    expect(lower / points.length).toBeGreaterThan(0.3)
  })

  it.each(CASES.map((c) => [c.name, c] as const))(
    "on the %s, takes the floor's highest within an angle of a direction, poles and date line included",
    (_, { floor }) => {
      let over = 0
      const rand = random(7)
      const side = new THREE.Vector3()
      const at = new THREE.Vector3()
      const directions = [
        ...sweep('Himalaya', 400),
        ...sweep('Andes', 400),
        ...Array.from({ length: 200 }, () => latLonToLocal(-89.9 + 179.8 * rand(), 179 + 2 * rand())),
        ...Array.from({ length: 100 }, () => latLonToLocal(86 + 4 * rand(), 360 * rand() - 180)),
        latLonToLocal(89.95, 10),
        latLonToLocal(-89.95, -120),
      ]
      for (const angle of [0.004 / EARTH_RADIUS, 0.03 / EARTH_RADIUS]) {
        for (const local of directions) {
          const around = terrainFloorGreyAround(floor, local, angle)
          let seen = terrainFloorGrey(floor, local)
          for (let k = 0; k < 64; k++) {
            side.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).cross(local).normalize()
            at.copy(local).applyAxisAngle(side, angle * Math.sqrt(rand()))
            seen = Math.max(seen, terrainFloorGrey(floor, at))
          }
          expect(around, `${local.toArray()}`).toBeGreaterThanOrEqual(seen - 1e-6)
          if (angle < 0.005 && Math.abs(local.y) < Math.sin(Math.PI * (80 / 180))) over = Math.max(over, around - seen)
        }
      }
      // And not far over it at about the ship's reach, short of the poles'
      // narrow quads: the slack for the slopes in reach (~75 m).
      expect(over).toBeLessThan(5)
    }
  )

  it('stays at the margin over the ocean and under the highest vertex plus the margin', () => {
    for (const { floor } of CASES) {
      for (const local of sweep('open Pacific', 500)) expect(terrainFloorGrey(floor, local)).toBe(TERRAIN_GREY_MARGIN)
      const peak = floor.grey.reduce((a, b) => Math.max(a, b), 0) + TERRAIN_GREY_MARGIN
      for (const local of sweep('Himalaya', 500)) expect(terrainFloorGrey(floor, local)).toBeLessThanOrEqual(peak)
    }
  })

  it('reads Earth the right way round: high in Tibet, sea level in the Pacific', () => {
    for (const { floor } of CASES) {
      expect(terrainFloorGrey(floor, latLonToLocal(32, 88))).toBeGreaterThan(150)
      expect(terrainFloorGrey(floor, latLonToLocal(-16, -68))).toBeGreaterThan(100)
      expect(terrainFloorGrey(floor, latLonToLocal(-40, -115))).toBe(TERRAIN_GREY_MARGIN)
      // Its mirror images are ocean.
      expect(terrainFloorGrey(floor, latLonToLocal(-32, 88))).toBeLessThan(40)
      expect(terrainFloorGrey(floor, latLonToLocal(32, -88))).toBeLessThan(80)
    }
  })

  it('is continuous across the date line and finite at the poles', () => {
    for (const { floor } of CASES) {
      for (const lat of [-60, 0, 65]) {
        const east = terrainFloorGrey(floor, latLonToLocal(lat, 179.999))
        const west = terrainFloorGrey(floor, latLonToLocal(lat, -179.999))
        expect(Math.abs(east - west)).toBeLessThan(0.5)
      }
      for (const y of [1, -1]) expect(Number.isFinite(terrainFloorGrey(floor, new THREE.Vector3(0, y, 0)))).toBe(true)
    }
  })

  it('falls back over the highest ground there is before the map loads', () => {
    const fallback = terrainFloorRadius(null, EARTH_RADIUS, latLonToLocal(0, -150))
    expect(fallback).toBe(EARTH_RADIUS + (TERRAIN_DISPLACEMENT * TERRAIN_FALLBACK_GREY) / 255)
    for (const { floor } of CASES) {
      expect(fallback).toBeGreaterThan(EARTH_RADIUS + (TERRAIN_DISPLACEMENT * floor.grey.reduce((a, b) => Math.max(a, b), 0)) / 255)
    }
  })

  it("rejects a map with no level at the mesh's rows", () => {
    const map = (width: number, height: number) => ({ width, height, data: new Float32Array(width * height) })
    expect(() => buildTerrainFloor(map(16, 8), [8, 3])).toThrow()
    expect(() => buildTerrainFloor(map(16, 8), [8, 16])).toThrow()
    expect(() => buildTerrainFloor({ ...map(16, 8), data: new Float32Array(10) }, [8, 4])).toThrow()
    expect(buildTerrainFloor(map(16, 8), [4, 2]).grey).toHaveLength(5 * 3)
  })
})
