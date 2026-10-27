import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { REFERENCE_TERRAIN_DISPLACEMENT, TERRAIN_DISPLACEMENT, TRUE_TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { REFERENCE_RELIEF } from '../relief'
import { latLonToLocal } from '../aurora'
import { DEM_METRES_PER_UNIT, boxMips, decodeEarthDem, demLevel, toHalfBits } from '../earth-dem'
import {
  LIMB_FACET_PX,
  LIMB_HYSTERESIS,
  LIMB_SEGMENTS,
  clearLimbView,
  limbFacetPx,
  updateLimbView,
  wantsLimbSphere,
  type SphereSegments,
} from '../ship/limb-detail'
import { EARTH_FLOOR_REACH, EARTH_GROUND_CLEARANCE, EARTH_RADIUS } from '../ship/ship-bodies'
import { SHIP_FOV } from '../ship/ship-session'
import {
  EARTH_BASE_SEGMENTS,
  TERRAIN_GREY_MARGIN,
  buildTerrainFloor,
  meanGrey,
  terrainFloorGreyAround,
} from '../ship/terrain-floor'
import {
  baseGroundGrey,
  baseGroundSurface,
  displace,
  groundLevels,
  groundMeshSlopeFade,
  meshGrid,
  meshRadius,
  readGround,
  reliefSlope,
  riseOverRun,
  vertexGrey,
  vertexSurface,
  worstNeedle,
  type MeshGrid,
} from '../ship/ground-mesh-model'
import {
  EARTH_LIMB_SWAP_FLOOR,
  MESH_SLOPE_FADE_END,
  MESH_SLOPE_FADE_START,
  MORPH_END_PX,
  MORPH_FLOOR,
  MORPH_START_PX,
  MORPH_TOP,
  createGroundDisplacement,
  groundLod,
  groundMorph,
} from './groundDisplacement'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'

const shipped = (name: string) => decodeEarthDem(readFileSync(new URL(`../assets/${name}`, import.meta.url)))
const [dem4k, dem2k, demMean] = await Promise.all(['earth-dem-4k.bin', 'earth-dem-2k.bin', 'earth-dem-mean.bin'].map(shipped))
const metres = (grey: number) => (grey / 255) * DEM_METRES_PER_UNIT
const ground4k = groundLevels(dem4k)
const base = meshGrid(EARTH_BASE_SEGMENTS)
const limb = meshGrid(LIMB_SEGMENTS)

describe('ground displacement (tides-zmw.2)', () => {
  it("reads each mesh at the level whose rows match its own, on both tiers' maps", () => {
    for (const dem of [dem4k, dem2k]) {
      const [top] = groundLevels(dem)
      expect([top.width, top.height]).toEqual([...LIMB_SEGMENTS])
      expect(groundLod(top.height, LIMB_SEGMENTS[1])).toBe(0)
      expect(groundLod(top.height, EARTH_BASE_SEGMENTS[1])).toBe(1)
    }
    // The flat fallback's 1 × 1 map reads its only level.
    expect(groundLod(1, 128)).toBe(0)
  })

  it('stands no vertex far over all 8 of its neighbours, on either sphere: no needles', () => {
    // three's own displacement read the full map at each vertex: one vertex
    // of a peak stood up to ~1.9 km over its neighbours.
    const full = boxMips(demLevel(dem4k)).map(({ width, height, data }) => ({
      width,
      height,
      data: Float32Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(toHalfBits(h)) * 255),
    }))
    for (const grid of [base, limb]) {
      const fullRead = Float32Array.from({ length: grid.uv.length / 2 }, (_, k) => readGround(full, grid.uv[2 * k], grid.uv[2 * k + 1], 0))
      expect(metres(worstNeedle(fullRead, grid.segments))).toBeGreaterThan(1500)
      for (const dem of [dem4k, dem2k]) {
        // ~430 m on the base sphere, ~320 m on the limb sphere.
        expect(metres(worstNeedle(vertexGrey(groundLevels(dem), grid), grid.segments))).toBeLessThan(500)
      }
    }
  })

  describe('the limb sphere morphed fully toward the base sphere', () => {
    const baseMesh = displace(base, vertexGrey(ground4k, base), EARTH_RADIUS)
    const sag = ([width, height]: SphereSegments) =>
      (EARTH_RADIUS * (1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))) * 255) / TERRAIN_DISPLACEMENT

    it("stands on the base sphere's vertices where they share one, and on its triangles between", () => {
      const [width, height] = LIMB_SEGMENTS
      const [baseWidth, baseHeight] = EARTH_BASE_SEGMENTS
      const baseGrey = vertexGrey(ground4k, base)
      const at = new THREE.Vector3()
      let worstOff = 0
      for (let j = 1; j < height; j++) {
        for (let i = 0; i <= width; i++) {
          const k = j * (width + 1) + i
          const morphed = baseGroundGrey(ground4k, EARTH_BASE_SEGMENTS, limb.uv[2 * k], limb.uv[2 * k + 1])
          const shared = (i * baseWidth) % width === 0 && (j * baseHeight) % height === 0
          if (shared) {
            const b = ((j * baseHeight) / height) * (baseWidth + 1) + (i * baseWidth) / width
            expect(morphed).toBeCloseTo(baseGrey[b], 3)
          }
          // Against where a ray meets the base mesh's flat triangles (the
          // vertex's own sphere sits on the curve, the flat face under it).
          at.fromArray(limb.unit, 3 * k).normalize()
          const drawn = ((meshRadius(baseMesh, EARTH_BASE_SEGMENTS, at) - EARTH_RADIUS) * 255) / TERRAIN_DISPLACEMENT
          worstOff = Math.max(worstOff, Math.abs(morphed - drawn))
        }
      }
      // The 128 × 128 sphere's faces sag ~3.8 levels (~100 m).
      expect(worstOff).toBeLessThan(sag(EARTH_BASE_SEGMENTS) + TERRAIN_GREY_MARGIN)
    })

    it.each([
      ['Everest', 27.988, 86.925],
      ['K2', 35.881, 76.513],
      ['Aconcagua', -32.653, -70.011],
    ])("keeps %s's top across the swap", (_, lat, lon) => {
      const limbMorphed = new Float32Array(limb.uv.length / 2)
      for (let k = 0; k < limbMorphed.length; k++) {
        limbMorphed[k] = baseGroundGrey(ground4k, EARTH_BASE_SEGMENTS, limb.uv[2 * k], limb.uv[2 * k + 1])
      }
      const limbMesh = displace(limb, limbMorphed, EARTH_RADIUS)
      let before = 0
      let after = 0
      for (let a = -0.7; a <= 0.7; a += 0.05) {
        for (let b = -0.7; b <= 0.7; b += 0.05) {
          const at = latLonToLocal(lat + a, lon + b)
          before = Math.max(before, meshRadius(baseMesh, EARTH_BASE_SEGMENTS, at))
          after = Math.max(after, meshRadius(limbMesh, LIMB_SEGMENTS, at))
        }
      }
      // Up by at most the base faces' sag (the limb sphere's vertices sit on
      // the curve), where without the morph the swap moved them by up to
      // ~1 km (Aconcagua 2110 -> 3119 m, filtered; 3633 -> 4575 m before).
      expect(after).toBeGreaterThanOrEqual(before - 1e-9)
      expect(((after - before) * 255) / TERRAIN_DISPLACEMENT).toBeLessThan(sag(EARTH_BASE_SEGMENTS))
    })
  })

  describe("the ground's slope at its vertices (tides-zmw.3)", () => {
    const toDegrees = THREE.MathUtils.radToDeg
    // A vertex's shading normal: the sphere's at unit, tilted by its slope.
    // At a fixed 12x, the relief the faces tilt over 1° at (at ?relief=1
    // none would: the property is geometric, not the page's).
    const D12 = REFERENCE_TERRAIN_DISPLACEMENT * (12 / REFERENCE_RELIEF)
    const shadingNormal = (unit: THREE.Vector3, slope: ArrayLike<number>) =>
      unit
        .clone()
        .normalize()
        .sub(new THREE.Vector3(...riseOverRun(slope, EARTH_RADIUS, D12)))
        .normalize()
    const unitAt = (grid: MeshGrid, k: number) => new THREE.Vector3().fromArray(grid.unit, 3 * k)
    const slopeAt = (surface: Float64Array, k: number) => surface.subarray(4 * k + 1, 4 * k + 4)
    // The area-weighted normal of the displaced mesh's faces around each
    // vertex, the date line's two columns as one.
    function faceNormals(grid: MeshGrid, mesh: Float64Array): THREE.Vector3[] {
      const sphere = new THREE.SphereGeometry(1, ...grid.segments)
      const index = sphere.getIndex()!.array
      sphere.dispose()
      const sums = Array.from({ length: mesh.length / 3 }, () => new THREE.Vector3())
      const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
      for (let t = 0; t < index.length; t += 3) {
        a.fromArray(mesh, 3 * index[t])
        b.fromArray(mesh, 3 * index[t + 1]).sub(a)
        c.fromArray(mesh, 3 * index[t + 2]).sub(a)
        b.cross(c)
        for (let q = 0; q < 3; q++) sums[index[t + q]].add(b)
      }
      const [width] = grid.segments
      for (let k = 0; k < sums.length; k += width + 1) {
        sums[k].add(sums[k + width])
        sums[k + width].copy(sums[k])
      }
      return sums.map((n) => n.normalize())
    }
    const quantile = (values: number[], q: number) => [...values].sort((x, y) => x - y)[Math.floor(q * (values.length - 1))]

    it.each([
      ['base', base],
      ['limb', limb],
    ])('tilts each vertex of the %s sphere as the drawn faces around it', (_, grid) => {
      const surface = vertexSurface(ground4k, grid)
      const grey = Float64Array.from({ length: surface.length / 4 }, (_, k) => surface[4 * k])
      const faces = faceNormals(grid, displace(grid, grey, EARTH_RADIUS, D12))
      const [width, height] = grid.segments
      const all: number[] = []
      const relief: number[] = []
      for (let k = width + 1; k < (width + 1) * height; k++) {
        const off = toDegrees(shadingNormal(unitAt(grid, k), slopeAt(surface, k)).angleTo(faces[k]))
        all.push(off)
        if (toDegrees(faces[k].angleTo(unitAt(grid, k))) > 1) relief.push(off)
      }
      // Central differences leave out the faces' diagonal neighbours, which
      // only the sharpest features feel: over every vertex 1.7° (base) and
      // 1.9° (limb) at p99; where the faces tilt over 1°, 2.7° and 3.1°.
      expect(quantile(all, 0.99)).toBeLessThan(2)
      expect(quantile(relief, 0.5)).toBeLessThan(0.5)
      expect(quantile(relief, 0.99)).toBeLessThan(3.5)
    })

    it("has no seam at the date line, and no slope at the poles' apexes", () => {
      for (const grid of [base, limb]) {
        const surface = vertexSurface(ground4k, grid)
        const [width, height] = grid.segments
        const row = width + 1
        for (let j = 0; j <= height; j++) {
          for (let n = 0; n < 4; n++) expect(surface[4 * (j * row + width) + n]).toBeCloseTo(surface[4 * j * row + n], 9)
        }
        for (const j of [0, height]) {
          for (let i = 0; i <= width; i++) expect([...slopeAt(surface, j * row + i)]).toEqual([0, 0, 0])
        }
        // The row next to the south pole's apex, on Antarctica's plateau.
        const south = surface.slice(4 * (height - 1) * row, 4 * height * row).filter((_, n) => n % 4)
        expect(south.every(Number.isFinite)).toBe(true)
        expect(Math.max(...south.map(Math.abs))).toBeGreaterThan(0)
      }
    })

    it("matches the map's own slope on broad relief, in the same frame and units (the detail's premise)", () => {
      // A Gaussian hill 6 limb cells wide (sigma) on the equator at 0° E,
      // on a map the 4k's size, its mips as earthDemTexture.ts builds them,
      // 150 levels high at the reference 25x: the same drawn hill at any relief.
      const [width, height] = [4096, 2048]
      const sigma = (6 / LIMB_SEGMENTS[0]) * width
      const peak = (150 * REFERENCE_TERRAIN_DISPLACEMENT) / TERRAIN_DISPLACEMENT
      const data = new Float32Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          data[y * width + x] = peak * Math.exp(-((x + 0.5 - width / 2) ** 2 + (y + 0.5 - height / 2) ** 2) / (2 * sigma * sigma))
        }
      }
      const map = boxMips({ width, height, data })
      const ground = map.filter((level) => level.width <= LIMB_SEGMENTS[0])
      const surface = vertexSurface(ground, limb)
      const [cellsX, cellsY] = LIMB_SEGMENTS
      const row = cellsX + 1
      const texel = (2 * Math.PI * EARTH_RADIUS) / width
      let worst = 0
      let steepest = 0
      // At each vertex within 3 sigma, and at each quad's centre (on its
      // diagonal, so the mean of its north-west and south-east corners).
      for (let j = cellsY / 2 - 18; j <= cellsY / 2 + 18; j++) {
        for (let i = cellsX / 2 - 18; i <= cellsX / 2 + 18; i++) {
          for (const centre of [false, true]) {
            const k = j * row + i
            const mesh = riseOverRun(slopeAt(surface, k), EARTH_RADIUS)
            if (centre) {
              const se = riseOverRun(slopeAt(surface, k + row + 1), EARTH_RADIUS)
              for (let a = 0; a < 3; a++) mesh[a] = (mesh[a] + se[a]) / 2
            }
            const half = centre ? 0.5 : 0
            const fine = reliefSlope(map, (i + half) / cellsX, 1 - (j + half) / cellsY, EARTH_RADIUS, texel)
            const size = Math.hypot(...mesh)
            steepest = Math.max(steepest, size)
            worst = Math.max(worst, Math.hypot(...fine.map((x, a) => x - mesh[a])) / Math.max(size, 0.02))
          }
        }
      }
      expect(toDegrees(Math.atan(steepest))).toBeGreaterThan(5)
      // ~7° at its steepest; worst 5.4% apart (of the slope, or of 0.02 near the top).
      expect(worst).toBeLessThan(0.07)
    })

    it("fades the mesh's slope where its cells shrink under a few pixels, and toward the poles", () => {
      const row = (Math.PI * EARTH_RADIUS) / EARTH_BASE_SEGMENTS[1]
      const fade = (cellPx: number, lat = 0) => groundMeshSlopeFade(row / cellPx, EARTH_RADIUS, EARTH_BASE_SEGMENTS[1], lat)
      expect(fade(3)).toBe(1)
      expect(fade(2)).toBeCloseTo(0.5, 9)
      expect(fade(1.5)).toBe(0)
      expect(fade(10, POLE_SMOOTH_FROM)).toBe(1)
      expect(fade(10, -POLE_SMOOTH_TO)).toBe(0)
    })

    it("morphs to the base sphere's slopes: fully morphed, the limb sphere shades as the base sphere", () => {
      const baseSurface = vertexSurface(ground4k, base)
      const [width, height] = LIMB_SEGMENTS
      const [baseWidth, baseHeight] = EARTH_BASE_SEGMENTS
      // Where the two share a vertex, their normals.
      let shared = 0
      for (let j = 0; j <= height; j++) {
        for (let i = 0; i <= width; i++) {
          if ((i * baseWidth) % width || (j * baseHeight) % height) continue
          const k = j * (width + 1) + i
          const b = ((j * baseHeight) / height) * (baseWidth + 1) + (i * baseWidth) / width
          const morphed = baseGroundSurface(ground4k, EARTH_BASE_SEGMENTS, limb.uv[2 * k], limb.uv[2 * k + 1])
          shared = Math.max(shared, shadingNormal(unitAt(limb, k), morphed.slice(1)).angleTo(shadingNormal(unitAt(base, b), slopeAt(baseSurface, b))))
        }
      }
      expect(shared).toBeLessThan(1e-3)
      // Between them, the limb sphere's triangles (which straddle the base's
      // diagonals) against the base's: p99 0.14°, worst ~1.7° in the Andes.
      const limbAt = (x: number, y: number) => baseGroundSurface(ground4k, EARTH_BASE_SEGMENTS, x / width, 1 - y / height).slice(1)
      const off: number[] = []
      for (let y = 1.05; y < height - 1; y += 0.37) {
        for (let x = 0.03; x < width; x += 1.13) {
          const [i, j] = [Math.floor(x), Math.floor(y)]
          const [tx, ty] = [x - i, y - j]
          const nw = limbAt(i, j)
          const se = limbAt(i + 1, j + 1)
          const east = ty <= tx
          const mid = east ? limbAt(i + 1, j) : limbAt(i, j + 1)
          const [wx, wy] = east ? [tx, ty] : [ty, tx]
          const drawn = nw.map((s, n) => s + wx * (mid[n] - s) + wy * (se[n] - mid[n]))
          const lon = (2 * Math.PI * x) / width
          const theta = (Math.PI * y) / height
          const unit = new THREE.Vector3(-Math.cos(lon) * Math.sin(theta), Math.cos(theta), Math.sin(lon) * Math.sin(theta))
          const target = baseGroundSurface(ground4k, EARTH_BASE_SEGMENTS, x / width, 1 - y / height).slice(1)
          off.push(toDegrees(shadingNormal(unit, drawn).angleTo(shadingNormal(unit, target))))
        }
      }
      expect(quantile(off, 0.99)).toBeLessThan(0.3)
      expect(quantile(off, 1)).toBeLessThan(3)
    })
  })

  describe('groundMorph and the swap', () => {
    const morph = (distance: number, screenPx: number) =>
      groundMorph(EARTH_BASE_SEGMENTS, distance, EARTH_RADIUS, screenPx, SHIP_FOV)
    // The highest stop on either sphere's floor: around the near plane's
    // reach, over the Karakoram and the Himalaya, where both floors peak.
    const floors = [EARTH_BASE_SEGMENTS, LIMB_SEGMENTS].map((segments) => buildTerrainFloor(meanGrey(demMean), segments))
    let highestStop = 0
    for (const floor of floors) {
      let top = 0
      for (let lat = 25; lat <= 45; lat += 0.1) {
        for (let lon = 65; lon <= 100; lon += 0.1) {
          top = Math.max(top, terrainFloorGreyAround(floor, latLonToLocal(lat, lon), EARTH_FLOOR_REACH / EARTH_RADIUS))
        }
      }
      // That is where its highest vertex is.
      expect(top).toBeGreaterThanOrEqual(floor.grey.reduce((a, b) => Math.max(a, b), 0) + TERRAIN_GREY_MARGIN)
      highestStop = Math.max(highestStop, (TERRAIN_DISPLACEMENT * top) / 255 + EARTH_GROUND_CLEARANCE)
    }
    // A descent straight down at 0.1% of the gap a frame: where Earth's ground
    // first wants the limb sphere (EarthRenderer's swap floor), through the
    // limb view's hysteresis.
    const swapGap = (screenPx: number) => {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: EARTH_RADIUS }
      try {
        for (let gap = 3 * EARTH_RADIUS; gap > 0.001; gap *= 0.999) {
          updateLimbView('earth', [earth], new THREE.Vector3(EARTH_RADIUS + gap, 0, 0), screenPx, SHIP_FOV)
          if (wantsLimbSphere('earth', EARTH_RADIUS, EARTH_BASE_SEGMENTS, EARTH_LIMB_SWAP_FLOOR)) return gap
        }
        return 0
      } finally {
        clearLimbView()
      }
    }

    it('swaps well above the highest stop on any screen, so the floor never changes under the ship', () => {
      // ~0.034 over the Karakoram at the default relief (~0.066 at 25x, the
      // clamp's top), under the morph's floor.
      expect(highestStop).toBeLessThan(MORPH_FLOOR)
      for (const screenPx of [100, 200, 275, 300, 400, 450, 720, 1600]) {
        expect(swapGap(screenPx), String(screenPx)).toBeGreaterThan(MORPH_TOP)
      }
    })

    it('is 1 at the swap on any screen, and falls to 0 on the way down', () => {
      for (const screenPx of [100, 300, 400, 450, 500, 600, 720, 1170, 1600, 2160]) {
        const swap = EARTH_RADIUS + swapGap(screenPx)
        expect(morph(swap, screenPx), String(screenPx)).toBe(1)
        let previous = 1
        for (let distance = swap; distance > EARTH_RADIUS; distance -= 0.001) {
          const m = morph(distance, screenPx)
          expect(m).toBeLessThanOrEqual(previous)
          previous = m
        }
        expect(previous).toBe(0)
      }
      expect(MORPH_START_PX).toBeGreaterThan(LIMB_FACET_PX * LIMB_HYSTERESIS)
    })

    it('is over by MORPH_END_PX', () => {
      for (const distance of [1.01, 1.02, 1.05].map((r) => r * EARTH_RADIUS)) {
        const screenPx = MORPH_END_PX / limbFacetPx(EARTH_BASE_SEGMENTS, distance / EARTH_RADIUS, 1, SHIP_FOV)
        expect(morph(distance, screenPx * 1.01)).toBe(0)
      }
    })

    it('is over above every stop on either floor, on any screen', () => {
      for (const screenPx of [100, 200, 400, 720, 1600, 4320]) {
        expect(morph(EARTH_RADIUS + MORPH_FLOOR, screenPx)).toBe(0)
        expect(morph(EARTH_RADIUS + highestStop, screenPx)).toBe(0)
      }
    })
  })

  describe('patch', () => {
    function phongShader() {
      return {
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
        vertexShader: THREE.ShaderLib.phong.vertexShader,
        fragmentShader: THREE.ShaderLib.phong.fragmentShader,
      } as THREE.WebGLProgramParametersWithUniforms
    }

    it("replaces three's displacement read and holds its uniforms, after the rest of the ground's chain", () => {
      const eclipse = createEclipseShadow('earth')
      const clouds = createCloudLayer(eclipse, false)
      const displacement = createGroundDisplacement(EARTH_BASE_SEGMENTS)
      const patch = composePatches(composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false)), displacement.patch)
      const shader = phongShader()
      patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
      const vert = shader.vertexShader
      expect(vert).not.toContain('#include <displacementmap_vertex>')
      expect(vert).not.toContain('texture2D( displacementMap')
      expect(vert).toContain('transformed += normalize(objectNormal) * (groundAt.x * displacementScale + displacementBias);')
      expect(vert.indexOf('vec4 groundSurface(vec2 uv)')).toBeLessThan(vert.indexOf('void main()'))
      expect(vert).toContain('#define GROUND_BASE vec2(128.0, 128.0)')
      expect(vert).toMatch(/#include <begin_vertex>\s+vGroundDetailPos = position;/)
      expect(vert).not.toContain('textureSize(')
      // The slope ground-mesh-model.ts groundVertexSlope(), baseGroundSurface()
      // and riseOverRun() mirror: a change to one side fails here.
      for (const line of [
        'if (uv.y <= 0.0 || uv.y >= 1.0) return vec3(0.0);',
        'vec2 d = 1.0 / cells;',
        'float lon = 6.283185307 * uv.x;',
        'float east = textureLod(uGroundHeights, uv + vec2(d.x, 0.0), lod).r - textureLod(uGroundHeights, uv - vec2(d.x, 0.0), lod).r;',
        'float north = textureLod(uGroundHeights, uv + vec2(0.0, d.y), lod).r - textureLod(uGroundHeights, uv - vec2(0.0, d.y), lod).r;',
        'float lat = 3.141592654 * (uv.y - 0.5);',
        'vec3 e = vec3(sin(lon), 0.0, cos(lon));',
        'vec3 n = vec3(cos(lon) * sin(lat), cos(lat), -sin(lon) * sin(lat));',
        'return east / (12.566370614 * d.x * cos(lat)) * e + north / (6.283185307 * d.y) * n;',
        'return vec4(textureLod(uGroundHeights, uv, lod).r, groundVertexSlope(uv, GROUND_BASE, lod));',
        'vec4 own = vec4(textureLod(uGroundHeights, uv, uGroundLod).r, groundVertexSlope(uv, uGroundCells, uGroundLod));',
        'if (uGroundMorph > 0.0) own = mix(own, groundBaseSurface(uv), uGroundMorph);',
        'vGroundSlope = groundAt.yzw * displacementScale / length(position);',
      ]) {
        expect(vert).toContain(line)
      }
      for (const name of ['uGroundHeights', 'uGroundLod', 'uGroundBaseLod', 'uGroundMorph', 'uGroundCells'] as const) {
        expect(shader.uniforms[name]).toBe(displacement.uniforms[name])
      }
      // The ground detail tilts the land by it.
      const frag = shader.fragmentShader
      expect(frag.indexOf('#define GROUND_MESH_SLOPE')).toBeGreaterThan(frag.indexOf('#include <common>'))
      expect(frag.indexOf('varying vec3 vGroundSlope;')).toBeLessThan(frag.indexOf('vec3 groundDrawnSlope(vec3 p, float footprint)'))
      expect(frag.indexOf('vec3 groundDrawnSlope(vec3 p, float footprint)')).toBeLessThan(
        frag.indexOf('vec3 groundMeshSlope = groundDrawnSlope(vGroundDetailPos, groundFootprint);')
      )
      // The fade groundMeshSlopeFade() mirrors.
      for (const line of [
        'float cell = 3.141592654 * length(p) / uGroundCells.y;',
        'float lat = degrees(asin(clamp(p.y / length(p), -1.0, 1.0)));',
        `return vGroundSlope * (1.0 - smoothstep(${MESH_SLOPE_FADE_START.toFixed(6)}, ${MESH_SLOPE_FADE_END.toFixed(6)}, footprint / cell))`,
        `* (1.0 - smoothstep(${POLE_SMOOTH_FROM.toFixed(6)}, ${POLE_SMOOTH_TO.toFixed(6)}, abs(lat)));`,
      ]) {
        expect(frag).toContain(line)
      }
      expect(frag.indexOf('#define GROUND_MESH_SLOPE')).toBeLessThan(frag.indexOf('#ifdef GROUND_MESH_SLOPE'))
      expect(patch.customProgramCacheKey()).toContain('ground-displacement-128x128')
      clouds.dispose()
    })

    it('fails loudly on a shader without the displacement chunk', () => {
      const shader = { ...phongShader(), vertexShader: 'void main() {}' }
      expect(() => createGroundDisplacement(EARTH_BASE_SEGMENTS).patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)).toThrow()
    })
  })

  // The displacement and its slope read the material's displacementScale as
  // three's uniform (the patch test above), never a constant: the CPU
  // mirrors take it as a parameter, the page's relief's by default, and
  // scale with it (the tests compare reliefs through it).
  it.each([1, 4])('mirrors the ground drawn at %dx: vertices, mesh slope and relief slope scale with the displacement', (scale) => {
    const displacement = TRUE_TERRAIN_DISPLACEMENT * scale
    const share = displacement / TERRAIN_DISPLACEMENT
    const grid = meshGrid(EARTH_BASE_SEGMENTS)
    const grey = vertexGrey(ground4k, grid)
    const full = displace(grid, grey, EARTH_RADIUS)
    const scaled = displace(grid, grey, EARTH_RADIUS, displacement)
    for (let i = 0; i < full.length; i += 37) {
      const sea = grid.unit[i] * EARTH_RADIUS
      expect(scaled[i] - sea).toBeCloseTo((full[i] - sea) * share, 14)
    }
    const surface = vertexSurface(ground4k, grid)
    const map = boxMips(demLevel(dem4k)).map(({ width, height, data }) => ({
      width,
      height,
      data: Float32Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(toHalfBits(h)) * 255),
    }))
    for (let k = 0; k < grey.length; k += 211) {
      const slope = surface.subarray(4 * k + 1, 4 * k + 4)
      const fullSlope = riseOverRun(slope, EARTH_RADIUS)
      riseOverRun(slope, EARTH_RADIUS, displacement).forEach((x, a) => expect(x).toBeCloseTo(fullSlope[a] * share, 14))
      const [u, v] = [grid.uv[2 * k], grid.uv[2 * k + 1]]
      const fine = reliefSlope(map, u, v, EARTH_RADIUS, 0.01)
      reliefSlope(map, u, v, EARTH_RADIUS, 0.01, displacement).forEach((x, a) => expect(x).toBeCloseTo(fine[a] * share, 14))
    }
  })
})
