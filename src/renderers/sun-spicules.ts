import * as THREE from 'three'
import type { SphereSegments } from '../ship/limb-detail'
import { seededRandom } from './sun-activity'

/*
 * The Sun's spicules: the chromosphere's fine jets, which make its limb a
 * ragged fringe rather than a ruled circle. Two layers. At every tier the
 * photosphere's own shader traces the fringe on the limb (sun/fragment.frag,
 * SUN_FRINGE). On the high tier, close in, SunSpicules adds them as 3D
 * blades, clustered in tufts on the supergranule network's lanes as real
 * spicules are (bushes and rosettes, not an even fur), so they stand in
 * parallax against the disc. Built once at mount, in the Sun's frame (unit
 * radius), so the layout turns with the Sun and is the same on every date.
 */

/**
 * [TUNE] The fringe's tallest jets above the limb, solar radii. The shell
 * round them (SUN_SHELL) must stay under the ship's stop (COLLISION_MARGIN)
 * by more than the near plane's distance there (NEAR_SHARE of the gap), or
 * the near plane cuts a hole in the Sun under the ship.
 */
export const SUN_FRINGE = 0.01

/**
 * [TUNE] The fringe's height on screen, CSS px, over which it rises from
 * nothing to full: under a pixel or so it would only shimmer.
 */
export const SUN_FRINGE_FADE_PX = [1.5, 5] as const

/**
 * The Sun's shell (its sphere scaled out by this) encloses the fringe's
 * tallest jets everywhere, its flattest facets included, so every fringe
 * pixel has a fragment to trace from. A facet's plane lies no deeper than
 * its circumcircle, whose radius is the cell's half diagonal (as
 * limbFacetPx measures it); a cell's full width, π over the fewer segments,
 * is kept as a floor for margin on the square-celled limb sphere.
 */
export function sunShellScale([width, height]: SphereSegments): number {
  const halfDiagonal = 0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height)
  const sag = Math.max(halfDiagonal, Math.PI / Math.min(width, height))
  return (1 + SUN_FRINGE) / Math.cos(sag)
}

/**
 * The Sun's sphere. The trace makes its silhouette exact, so it needs no
 * finer limb sphere close in (limb-detail.ts).
 */
export const SUN_SEGMENTS = [128, 128] as const

/** The shell SunRenderer draws the Sun's sphere scaled out to. */
export const SUN_SHELL = sunShellScale(SUN_SEGMENTS)

/**
 * [TUNE] The 3D blades (high tier only): tufts, and blades per tuft (from,
 * to). ~108k blades; SunSpicules draws none until they would be wide enough
 * to see.
 */
export const SPICULE_BUDGET = {
  high: { tufts: 12000, blades: [6, 12] },
} as const

/** The most blades the budget can lay out. */
export const SPICULE_MAX_BLADES = SPICULE_BUDGET.high.tufts * SPICULE_BUDGET.high.blades[1]

/**
 * The supergranule network's scale: cells per solar radius, as the surface
 * bake draws it (sun-bake/fragment.frag, worley(n * 13.0)), so the tufts sit
 * on lanes the size of the ones on the disc.
 */
export const NETWORK_SCALE = 13

/**
 * [TUNE] How close to a cell's edge a tuft stands: F2 − F1 (cellEdgeDistance)
 * under this, in network cell units.
 */
export const EDGE_BAND = 0.07

/** [TUNE] A tuft's feet scatter within this of its centre, solar radii. */
export const TUFT_RADIUS = 0.003

/** [TUNE] A blade's feet stand between these radii, just under the limb. */
export const SPICULE_FOOT = [0.996, 0.999] as const

/** [TUNE] Blade widths, solar radii (from, to). */
export const SPICULE_WIDTH = [0.0012, 0.0022] as const

/**
 * [TUNE] A blade's width on screen, CSS px, over which it fades in: thinner,
 * it would only flicker.
 */
export const SPICULE_FADE_PX = [0.6, 2] as const

/** The steepest a blade leans off the vertical: tan 30°. */
export const SPICULE_MAX_LEAN = Math.tan(Math.PI / 6)

type Vec3 = [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

// The lattice spans the unit sphere's cells and their neighbours.
const LATTICE_MIN = -NETWORK_SCALE - 1
const LATTICE_SIZE = 2 * NETWORK_SCALE + 2

let lattice: Float32Array | null = null

/**
 * The network's cell centres: one per cell of a lattice NETWORK_SCALE to
 * the solar radius, jittered within it as the bake's Worley noise is
 * (0.15 + 0.7 · hash), seeded so the layout never changes.
 */
export function networkCells(): Float32Array {
  if (lattice) return lattice
  const random = seededRandom(0x5ca1ab1e)
  const cells = new Float32Array(LATTICE_SIZE ** 3 * 3)
  for (let i = 0; i < LATTICE_SIZE ** 3; i++) {
    const x = (i % LATTICE_SIZE) + LATTICE_MIN
    const y = (Math.floor(i / LATTICE_SIZE) % LATTICE_SIZE) + LATTICE_MIN
    const z = Math.floor(i / LATTICE_SIZE ** 2) + LATTICE_MIN
    cells[i * 3] = x + 0.15 + 0.7 * random()
    cells[i * 3 + 1] = y + 0.15 + 0.7 * random()
    cells[i * 3 + 2] = z + 0.15 + 0.7 * random()
  }
  lattice = cells
  return cells
}

/**
 * Worley F2 − F1 at a direction on the unit sphere, in network cell units:
 * 0 on the lane between two cells, growing toward a cell's middle.
 */
export function cellEdgeDistance(dir: Vec3): number {
  const cells = networkCells()
  const px = dir[0] * NETWORK_SCALE
  const py = dir[1] * NETWORK_SCALE
  const pz = dir[2] * NETWORK_SCALE
  const bx = Math.floor(px) - LATTICE_MIN
  const by = Math.floor(py) - LATTICE_MIN
  const bz = Math.floor(pz) - LATTICE_MIN
  // Squared until the end: this runs ~50k times at mount.
  let f1 = Infinity
  let f2 = Infinity
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = 3 * (((bz + dz) * LATTICE_SIZE + by + dy) * LATTICE_SIZE + bx + dx)
        const ex = cells[i] - px
        const ey = cells[i + 1] - py
        const ez = cells[i + 2] - pz
        const d = ex * ex + ey * ey + ez * ez
        if (d < f1) {
          f2 = f1
          f1 = d
        } else if (d < f2) {
          f2 = d
        }
      }
    }
  }
  return Math.sqrt(f2) - Math.sqrt(f1)
}

export interface SpiculeBlade {
  /** The foot, in the Sun's frame: its length is the foot's radius. */
  foot: Vec3
  /** Tangent at the foot, solar radii per radius of rise: the blade's lean. */
  lean: Vec3
  /** Solar radii. */
  height: number
  width: number
  /** 0..1, phases the blade's rise and fall. */
  seed: number
}

export interface SpiculeTuft {
  /** The tuft's centre, a unit vector in the Sun's frame. */
  axis: Vec3
  blades: SpiculeBlade[]
}

/**
 * The tufts, on the network's lanes. A tuft's blades lean out from its
 * centre in proportion to how far out they stand, so it opens as a sheaf;
 * the middle ones are the tallest.
 */
export function spiculeTufts(): SpiculeTuft[] {
  const { tufts: count, blades: [fewest, most] } = SPICULE_BUDGET.high
  const random = seededRandom(0x5b1c0de5)
  const out: SpiculeTuft[] = []
  while (out.length < count) {
    // Uniform on the sphere, then kept only on a lane.
    const y = 2 * random() - 1
    const a = 2 * Math.PI * random()
    const r = Math.sqrt(1 - y * y)
    const axis: Vec3 = [r * Math.cos(a), y, r * Math.sin(a)]
    if (cellEdgeDistance(axis) >= EDGE_BAND) continue
    const east = normalize(cross(Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0], axis))
    const north = cross(axis, east)
    const n = fewest + Math.floor(random() * (most - fewest + 1))
    const blades: SpiculeBlade[] = []
    // A sheaf's spread is its own, so tufts differ.
    const spread = SPICULE_MAX_LEAN * (0.5 + 0.5 * random())
    for (let k = 0; k < n; k++) {
      // Linear in the radius, not its root: denser at the core, as a bush.
      const offset = TUFT_RADIUS * random()
      const turn = 2 * Math.PI * random()
      const t: Vec3 = [
        east[0] * Math.cos(turn) + north[0] * Math.sin(turn),
        east[1] * Math.cos(turn) + north[1] * Math.sin(turn),
        east[2] * Math.cos(turn) + north[2] * Math.sin(turn),
      ]
      const dir = normalize([axis[0] + t[0] * offset, axis[1] + t[1] * offset, axis[2] + t[2] * offset])
      const radius = SPICULE_FOOT[0] + (SPICULE_FOOT[1] - SPICULE_FOOT[0]) * random()
      // The lean, tangent at the foot itself.
      const along = dot(t, dir)
      const lean = (spread * offset) / TUFT_RADIUS
      const tangent = normalize([t[0] - along * dir[0], t[1] - along * dir[1], t[2] - along * dir[2]])
      const centrality = 1 - offset / TUFT_RADIUS
      blades.push({
        foot: [dir[0] * radius, dir[1] * radius, dir[2] * radius],
        lean: [tangent[0] * lean, tangent[1] * lean, tangent[2] * lean],
        // Most stand over the traced fringe, so the tufts show above it.
        height: SUN_FRINGE * (0.9 + 1.0 * random() ** 2) * (0.75 + 0.25 * centrality),
        width: SPICULE_WIDTH[0] + (SPICULE_WIDTH[1] - SPICULE_WIDTH[0]) * random(),
        seed: random(),
      })
    }
    out.push({ axis, blades })
  }
  return out
}

export interface SpiculeArrays {
  /** Per blade: foot (xyz), seed. */
  spicule: Float32Array
  /** Per blade: lean (xyz). */
  lean: Float32Array
  /** Per blade: height, width. */
  size: Float32Array
  count: number
}

/**
 * The blades packed for the GPU. The tufts' objects (~100k) are garbage
 * once this returns: only the typed arrays live on.
 */
export function spiculeArrays(): SpiculeArrays {
  const blades = spiculeTufts().flatMap((t) => t.blades)
  const spicule = new Float32Array(blades.length * 4)
  const lean = new Float32Array(blades.length * 3)
  const size = new Float32Array(blades.length * 2)
  blades.forEach((b, i) => {
    spicule.set([...b.foot, b.seed], i * 4)
    lean.set(b.lean, i * 3)
    size.set([b.height, b.width], i * 2)
  })
  return { spicule, lean, size, count: blades.length }
}

/**
 * The blades as one instanced quad (SunSpicules; sun-spicule/vertex.glsl
 * stands each one up and turns it to the eye): aSpicule (foot xyz, seed),
 * aLean (xyz), aSize (height, width).
 */
export function createSpiculeGeometry(): THREE.InstancedBufferGeometry {
  const { spicule, lean, size, count } = spiculeArrays()
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3)
  )
  geometry.setIndex([0, 1, 2, 1, 3, 2])
  geometry.setAttribute('aSpicule', new THREE.InstancedBufferAttribute(spicule, 4))
  geometry.setAttribute('aLean', new THREE.InstancedBufferAttribute(lean, 3))
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2))
  geometry.instanceCount = count
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1 + 2 * SUN_FRINGE)
  return geometry
}

const toObject = new THREE.Matrix4()

/**
 * The eye (perspective) and the view direction (orthographic) in `mesh`'s
 * own frame, into `eye` and `dir`: the photosphere traces its sphere there
 * (sun/fragment.frag), so any parent's turn, scale or squash is undone.
 */
export function eyeInObject(camera: THREE.Camera, mesh: THREE.Object3D, eye: THREE.Vector3, dir: THREE.Vector3) {
  toObject.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).invert()
  eye.set(0, 0, 0).applyMatrix4(toObject)
  dir.set(0, 0, -1).transformDirection(toObject)
}

const centre = new THREE.Vector3()
const eyeWorld = new THREE.Vector3()

/**
 * How many of `blades` to draw for `camera` and a blade mesh (`mesh`,
 * scaled to the Sun's radius) in a view `viewHeight` CSS px tall: all, or
 * none while even the widest blade, at the nearest the surface comes to
 * the eye, would be under SPICULE_FADE_PX.
 */
export function spiculeInstanceCount(
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  viewHeight: number,
  blades: number
): number {
  const radius = mesh.matrixWorld.getMaxScaleOnAxis()
  let px = SPICULE_WIDTH[1] * radius * camera.projectionMatrix.elements[5] * 0.5 * viewHeight
  if (!(camera as THREE.OrthographicCamera).isOrthographicCamera) {
    centre.setFromMatrixPosition(mesh.matrixWorld)
    eyeWorld.setFromMatrixPosition(camera.matrixWorld)
    px /= Math.max(centre.distanceTo(eyeWorld) - radius, 1e-9)
  }
  return px < SPICULE_FADE_PX[0] ? 0 : blades
}
