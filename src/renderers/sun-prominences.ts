import * as THREE from 'three'
import { activeRegions, seededRandom, solarDirection, type ActiveRegion } from './sun-activity'

/*
 * The Sun's prominences and coronal loops, as one merged mesh of ribbons in
 * the Sun's frame (unit radius; SunProminences scales it). Each strand is a
 * curve the vertex shader widens into a ribbon facing the eye, and the
 * fragment shader turns into fibrous plasma: bright off the limb, a dark
 * filament across the disc (sun-prominence/fragment.frag). Built once at
 * mount from the fixed activity layout, so nothing moves with the date but
 * the Sun's own rotation.
 */

export const PROMINENCE_KIND = { arch: 0, hedgerow: 1, loop: 2 } as const

/** [TUNE] Strand and segment budgets per quality tier. */
export const PROMINENCE_BUDGET = {
  high: { archStrands: 12, hedgeStrands: 20, loopStrands: 7, segments: 24 },
  low: { archStrands: 6, hedgeStrands: 10, loopStrands: 3, segments: 12 },
} as const

/**
 * [TUNE] Below this many CSS px of solar radius the strands fade out (and
 * under the first, aren't drawn at all): thinner than a pixel, they would
 * only flicker.
 */
export const PROMINENCE_FADE_PX = [22, 48] as const

/** [TUNE] The same for the much finer coronal loops. */
export const PROMINENCE_LOOP_FADE_PX = [110, 220] as const

/** The highest any strand reaches, in solar radii from the centre. */
export const PROMINENCE_TOP = 1.3

interface Prominence {
  kind: 0 | 1
  lat: number
  lon: number
  /** Arc along the base, radians. */
  span: number
  /** Heading of the base, radians from east toward north. */
  heading: number
  /** Peak height above the surface, solar radii. */
  height: number
}

const DEG = Math.PI / 180

/**
 * [TUNE] The prominences: arches near the active belts, and hedgerows on
 * the polar crown (~60°), which from the ecliptic sits near the limb most
 * of the year, so some prominence is nearly always in view.
 */
const PROMINENCES: readonly Prominence[] = [
  { kind: 0, lat: 22 * DEG, lon: 75 * DEG, span: 16 * DEG, heading: 0.3, height: 0.13 },
  { kind: 0, lat: -33 * DEG, lon: 205 * DEG, span: 20 * DEG, heading: -0.5, height: 0.16 },
  { kind: 0, lat: 38 * DEG, lon: 265 * DEG, span: 12 * DEG, heading: 0.9, height: 0.1 },
  { kind: 0, lat: -18 * DEG, lon: 300 * DEG, span: 10 * DEG, heading: 0.2, height: 0.08 },
  { kind: 1, lat: 61 * DEG, lon: 140 * DEG, span: 28 * DEG, heading: 0.15, height: 0.12 },
  { kind: 1, lat: -58 * DEG, lon: 20 * DEG, span: 24 * DEG, heading: -0.2, height: 0.1 },
  { kind: 1, lat: 55 * DEG, lon: 330 * DEG, span: 18 * DEG, heading: 0.4, height: 0.08 },
]

type Vec3 = [number, number, number]
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a))

/** East, north and up at a point on the unit sphere. */
function frame(up: Vec3): { east: Vec3; north: Vec3 } {
  const east = normalize(cross([0, 1, 0], up))
  return { east, north: cross(up, east) }
}

/** The point `angle` radians along the great circle from `from` heading `dir`. */
function along(from: Vec3, dir: Vec3, angle: number): Vec3 {
  return add(scale(from, Math.cos(angle)), dir, Math.sin(angle))
}

interface Strand {
  /** Unit-sphere-frame points of the spine, t = 0..1. */
  point: (t: number) => Vec3
  width: number
  kind: number
  /** Overall brightness, 0..1. */
  gain: number
}

function archStrands(p: Prominence, count: number, random: () => number): Strand[] {
  const centre = solarDirection(p.lat, p.lon) as Vec3
  const { east, north } = frame(centre)
  const axis = normalize(add(scale(east, Math.cos(p.heading)), north, Math.sin(p.heading)))
  const side = cross(centre, axis)
  return Array.from({ length: count }, (_, i) => {
    const span = p.span * (0.7 + 0.45 * random())
    const height = p.height * (0.65 + 0.5 * random())
    const offset = (i / Math.max(count - 1, 1) - 0.5) * 0.05 + (random() - 0.5) * 0.02
    const lean = (random() - 0.5) * 0.5
    const sag = 0.05 + 0.15 * random()
    const phase = random() * Math.PI * 2
    return {
      point: (t: number) => {
        const base = along(centre, axis, (t - 0.5) * span)
        // A rope sagging between two lifted shoulders, as arch prominences
        // hang, with a little twist so strands don't lie in one plane.
        const s = Math.sin(Math.PI * t)
        const lift = height * Math.pow(s, 0.6) * (1 - sag * Math.pow(Math.sin(2 * Math.PI * t), 2) * s)
        const twist = 0.012 * Math.sin(phase + 5 * t) * s
        return add(scale(base, 0.994 + lift), side, offset + twist + lean * lift * 0.4)
      },
      width: 0.012 + 0.016 * random(),
      kind: PROMINENCE_KIND.arch,
      gain: 0.6 + 0.4 * random(),
    }
  })
}

function hedgeStrands(p: Prominence, count: number, random: () => number): Strand[] {
  const centre = solarDirection(p.lat, p.lon) as Vec3
  const { east, north } = frame(centre)
  const axis = normalize(add(scale(east, Math.cos(p.heading)), north, Math.sin(p.heading)))
  const crest = random() * 10
  return Array.from({ length: count }, (_, i) => {
    const s = (i + random() * 0.8) / count - 0.5
    const foot = along(centre, axis, s * p.span)
    // A ragged crest: tallest in the middle, with uneven tufts.
    const envelope = Math.pow(Math.cos(Math.PI * s), 0.7)
    const top = p.height * envelope * (0.55 + 0.45 * Math.sin(crest + 9 * s) * Math.sin(crest * 0.7 + 23 * s) + 0.35 * random())
    const lean = (random() - 0.5) * 0.4
    const sway = random() * Math.PI * 2
    return {
      point: (t: number) => {
        const h = Math.max(top, 0.02) * t
        const drift = lean * h + 0.006 * Math.sin(sway + 7 * t) * t
        return add(scale(foot, 0.994 + h), axis, drift)
      },
      width: 0.02 + 0.016 * random(),
      kind: PROMINENCE_KIND.hedgerow,
      gain: 0.55 + 0.45 * random(),
    }
  })
}

function loopStrands(region: ActiveRegion, count: number, random: () => number): Strand[] {
  const centre = region.dir as Vec3
  const { east, north } = frame(centre)
  const axis = normalize(add(scale(east, Math.cos(region.tilt)), north, Math.sin(region.tilt)))
  const side = cross(centre, axis)
  const strands = Math.max(1, Math.round(count * (0.5 + 0.5 * region.strength)))
  return Array.from({ length: strands }, (_, i) => {
    // Nested: the outer loops wider and taller, spreading sideways a little.
    const k = (i + 1) / strands
    const span = region.span * (0.7 + 0.8 * k) * (0.9 + 0.2 * random())
    const height = span * (0.55 + 0.25 * random())
    const offset = (random() - 0.5) * region.span * 0.25
    return {
      point: (t: number) => {
        const base = along(centre, axis, (t - 0.5) * span)
        const lift = height * Math.sin(Math.PI * t)
        return add(scale(base, 0.996 + lift), side, offset)
      },
      width: 0.012 + 0.008 * random(),
      kind: PROMINENCE_KIND.loop,
      gain: 0.5 + 0.5 * random(),
    }
  })
}

/** Every strand of the fixed layout, for a quality tier. */
export function prominenceStrands(low: boolean, regions: ActiveRegion[] = activeRegions()): Strand[] {
  const budget = PROMINENCE_BUDGET[low ? 'low' : 'high']
  const random = seededRandom(0x9e3779b1)
  const strands: Strand[] = []
  for (const p of PROMINENCES) {
    strands.push(...(p.kind === 0 ? archStrands(p, budget.archStrands, random) : hedgeStrands(p, budget.hedgeStrands, random)))
  }
  for (const region of regions) strands.push(...loopStrands(region, budget.loopStrands, random))
  return strands
}

/**
 * The merged ribbon geometry: two vertices per spine sample. Attributes:
 * position (the spine), aTangent, aStrand (t along, side -1/+1, width,
 * seed) and aKind (kind, gain).
 */
export function createProminenceGeometry(low: boolean): THREE.BufferGeometry {
  const { segments } = PROMINENCE_BUDGET[low ? 'low' : 'high']
  const strands = prominenceStrands(low)
  const random = seededRandom(0x51ed270b)
  const verts = strands.length * (segments + 1) * 2
  const position = new Float32Array(verts * 3)
  const tangent = new Float32Array(verts * 3)
  const strand = new Float32Array(verts * 4)
  const kind = new Float32Array(verts * 2)
  const index: number[] = []
  let v = 0
  for (const s of strands) {
    const seed = random() * 50
    const first = v
    for (let i = 0; i <= segments; i++) {
      const t = i / segments
      const p = s.point(t)
      const dt = 0.5 / segments
      const tan = normalize(add(s.point(Math.min(t + dt, 1)), s.point(Math.max(t - dt, 0)), -1))
      for (const side of [-1, 1]) {
        position.set(p, v * 3)
        tangent.set(tan, v * 3)
        strand.set([t, side, s.width, seed], v * 4)
        kind.set([s.kind, s.gain], v * 2)
        v++
      }
      if (i > 0) {
        const a = first + (i - 1) * 2
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangent, 3))
  geometry.setAttribute('aStrand', new THREE.BufferAttribute(strand, 4))
  geometry.setAttribute('aKind', new THREE.BufferAttribute(kind, 2))
  geometry.setIndex(index)
  // The vertex shader widens the strands, so bound them generously.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PROMINENCE_TOP + 0.05)
  return geometry
}

/** The strands' spine points, for tests. */
export function strandPoints(low: boolean, samples = 9): { kind: number; points: Vec3[] }[] {
  return prominenceStrands(low).map((s) => ({
    kind: s.kind,
    points: Array.from({ length: samples }, (_, i) => s.point(i / (samples - 1))),
  }))
}
