// Earth's drawn ground mesh rebuilt on the CPU, for tests (tides-zmw.2): the
// ground texture's levels as the GPU holds them (earthDemTexture.ts: box
// mips of the DEM, half floats), each vertex displaced as
// renderers/groundDisplacement.ts reads it, and where a ray from the centre
// meets the mesh's flat triangles. Independent of terrain-floor.ts, which
// tests check against it.
import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { boxMips, demLevel, toHalfBits, type DemLevel, type EarthDem } from '../earth-dem'
import { groundLod } from '../renderers/groundDisplacement'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'

/** The ground texture's levels in grey levels (255 = TERRAIN_DISPLACEMENT),
 * rows north first, from LIMB_SEGMENTS' width down. */
export function groundLevels(dem: EarthDem): DemLevel[] {
  return boxMips(demLevel(dem))
    .filter(({ width }) => width <= LIMB_SEGMENTS[0])
    .map(({ width, height, data }) => ({
      width,
      height,
      data: Float32Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(toHalfBits(h)) * 255),
    }))
}

/** textureLod at an integer `lod`: bilinear, repeating east-west, clamped
 * north-south, north at v = 1. */
export function readGround(levels: DemLevel[], u: number, v: number, lod: number): number {
  const { width, height, data } = levels[lod]
  const x = u * width - 0.5
  const y = (1 - v) * height - 0.5
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  const at = (ii: number, jj: number) =>
    data[THREE.MathUtils.clamp(jj, 0, height - 1) * width + (((ii % width) + width) % width)]
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy
}

/** A mesh of `segments`: each vertex's uv (SphereGeometry's, float32) and
 * unit direction, rows north first, width + 1 to a row. */
export interface MeshGrid {
  segments: SphereSegments
  uv: Float32Array
  unit: Float32Array
}

export function meshGrid(segments: SphereSegments): MeshGrid {
  const sphere = new THREE.SphereGeometry(1, ...segments)
  const grid = {
    segments,
    uv: (sphere.getAttribute('uv') as THREE.BufferAttribute).array as Float32Array,
    unit: (sphere.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
  }
  sphere.dispose()
  return grid
}

/** Each vertex's grey as the displacement reads it at the mesh's level. */
export function vertexGrey(levels: DemLevel[], { segments, uv }: MeshGrid): Float32Array {
  const lod = groundLod(levels[0].height, segments[1])
  return Float32Array.from({ length: uv.length / 2 }, (_, k) => readGround(levels, uv[2 * k], uv[2 * k + 1], lod))
}

/** The vertices displaced along their normals on a sphere of `radius`. */
export function displace({ unit }: MeshGrid, grey: ArrayLike<number>, radius: number): Float64Array {
  const out = new Float64Array(unit.length)
  for (let k = 0; k < grey.length; k++) {
    const r = radius + (TERRAIN_DISPLACEMENT * grey[k]) / 255
    for (let a = 0; a < 3; a++) out[3 * k + a] = unit[3 * k + a] * r
  }
  return out
}

const _ray = new THREE.Ray()
const _corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const _hit = new THREE.Vector3()

/**
 * How far out along unit `local` a ray from the centre meets `mesh`
 * (displace's, of a `segments` grid): the furthest hit over the quads within
 * two of the one `local` falls in. THREE.SphereGeometry's quad (i, j) is the
 * faces (a, b, d) and (b, c, d) over a = (i + 1, j), b = (i, j),
 * c = (i, j + 1), d = (i + 1, j + 1), less each pole's degenerate one.
 * `nudge` (radians) is for its own retries.
 */
export function meshRadius(mesh: Float64Array, [width, height]: SphereSegments, local: THREE.Vector3, nudge = 1e-10): number {
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const ix = Math.floor((u - Math.floor(u)) * width)
  const iy = Math.floor((0.5 - Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / Math.PI) * height)
  _ray.set(new THREE.Vector3(), local)
  const vertex = (target: THREE.Vector3, x: number, y: number) => target.fromArray(mesh, (y * (width + 1) + x) * 3)
  let best = -Infinity
  for (let dy = -2; dy <= 2; dy++) {
    const y = iy + dy
    if (y < 0 || y >= height) continue
    for (let dx = -2; dx <= 2; dx++) {
      const x = (((ix + dx) % width) + width) % width
      const [a, b, c, d] = _corners
      vertex(a, x + 1, y)
      vertex(b, x, y)
      vertex(c, x, y + 1)
      vertex(d, x + 1, y + 1)
      if (y !== 0 && _ray.intersectTriangle(a, b, d, false, _hit)) best = Math.max(best, _hit.length())
      if (y !== height - 1 && _ray.intersectTriangle(b, c, d, false, _hit)) best = Math.max(best, _hit.length())
    }
  }
  if (best > -Infinity || nudge > 1e-6) return best
  // A ray through a vertex or along an edge can slip between the faces in
  // rounding: the highest of four rays a hair to the side.
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const side = new THREE.Vector3(dx, 0, dz).cross(local).normalize()
    best = Math.max(best, meshRadius(mesh, [width, height], local.clone().addScaledVector(side, nudge * 10).normalize(), nudge * 10))
  }
  return best
}

/**
 * groundDisplacement.ts groundBaseHeight(), line for line: the base sphere's
 * (`base`) triangles' grey at `uv`, the limb sphere's morph target.
 */
export function baseGroundGrey(levels: DemLevel[], [width, height]: SphereSegments, u: number, v: number): number {
  const lod = groundLod(levels[0].height, height)
  const vertex = (x: number, y: number) => {
    const shift = y === 0 ? 0.5 : y === height ? -0.5 : 0
    return readGround(levels, (x + shift) / width, 1 - y / height, lod)
  }
  const cx = u * width
  const cy = (1 - v) * height
  const i = Math.min(Math.floor(cx), width - 1)
  const j = Math.min(Math.floor(cy), height - 1)
  const tx = cx - i
  const ty = cy - j
  const nw = vertex(i, j)
  const se = vertex(i + 1, j + 1)
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  if (j === 0) return mix(nw, mix(vertex(i, j + 1), se, tx), ty)
  if (j === height - 1) return mix(mix(nw, vertex(i + 1, j), tx), se, ty)
  if (ty <= tx) {
    const ne = vertex(i + 1, j)
    return nw + tx * (ne - nw) + ty * (se - ne)
  }
  const sw = vertex(i, j + 1)
  return nw + ty * (sw - nw) + tx * (se - sw)
}

/** The highest any vertex stands over all 8 of its neighbours, grey (≤ 0
 * where none does): a needle a vertex wide. The polar rows are left out. */
export function worstNeedle(grey: ArrayLike<number>, [width, height]: SphereSegments): number {
  const row = width + 1
  let worst = -Infinity
  for (let j = 1; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let around = -Infinity
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di || dj) around = Math.max(around, grey[(j + dj) * row + ((i + di + width) % width)])
        }
      }
      worst = Math.max(worst, grey[j * row + i] - around)
    }
  }
  return worst
}
