// The rows of a limb sphere that can be seen (tides-0oi.8). The ground's
// LIMB_SEGMENTS sphere displaces all of its ~131k vertices every frame, with
// several texture taps each, though from close zoom or the ship only a cap
// of it about the eye can be in view: everything past the horizon is behind
// the ground. A SphereGeometry's triangles run in rows of latitude, each
// contiguous in its index, so drawing only the rows that cross that cap is
// a draw range, and drops nothing that could reach a pixel.
//
// The cap: the drawn ground never dips inside a ball of `inner` radius (its
// lowest vertices less its facets' depth), and no vertex stands above
// `outer`. A ground point at most `outer` from the centre can only be seen
// from `distance` out if the line to it clears that ball, so it lies within
// acos(inner / distance) + acos(inner / outer) of the eye's direction.

import type { SphereSegments } from './limb-detail'

/** A range of a geometry's index, for setDrawRange. */
export interface IndexRange {
  start: number
  count: number
}

/** Every triangle. */
export const FULL_RANGE: IndexRange = { start: 0, count: Infinity }

// Triangles per row of THREE.SphereGeometry (full sphere): each polar row is
// a fan, one per quad; every other row two per quad.
const trianglesBefore = (row: number, [width, height]: SphereSegments) =>
  row <= 0 ? 0 : width + 2 * width * (Math.min(row, height - 1) - 1) + (row >= height ? width : 0)

/**
 * The index range of a full THREE.SphereGeometry of `segments` holding
 * triangle rows `first` through `last` (0 at the north pole, +y).
 */
export function sphereRowRange(first: number, last: number, segments: SphereSegments): IndexRange {
  const start = 3 * trianglesBefore(first, segments)
  return { start, count: 3 * trianglesBefore(last + 1, segments) - start }
}

/**
 * The rows a sphere of `radius` and `segments` (centred at the origin, poles
 * on y) can be seen in from `eye`, in the sphere's own frame, when its
 * vertices move only outward along their normals, by `lift.min` to
 * `lift.max`: an index range for setDrawRange, every triangle that could
 * reach a pixel and a row more each side. All of it from inside the ground,
 * and from far enough out that the cap reaches both poles.
 */
export function limbRowRange(
  eye: { x: number; y: number; z: number },
  radius: number,
  segments: SphereSegments,
  lift: { min: number; max: number }
): IndexRange {
  const [width, height] = segments
  const distance = Math.hypot(eye.x, eye.y, eye.z)
  // A facet's centre sits deepest below its corners; twice a cell's half
  // diagonal bounds how far any point of a facet strays from them.
  const halfDiagonal = 0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height)
  const inner = (radius + Math.min(lift.min, 0)) * Math.cos(2 * halfDiagonal)
  const outer = radius + Math.max(lift.max, 0)
  if (!(distance > inner) || !(inner > 0) || !Number.isFinite(distance)) return FULL_RANGE
  const cap = Math.acos(inner / distance) + Math.acos(Math.min(inner / outer, 1))
  const eyeColatitude = Math.acos(Math.max(-1, Math.min(1, eye.y / distance)))
  const north = eyeColatitude - cap
  const south = eyeColatitude + cap
  if (north <= 0 && south >= Math.PI) return FULL_RANGE
  // Triangle row r spans colatitudes r..r+1 rows; a row more each side.
  const rowAngle = Math.PI / height
  const first = Math.max(0, Math.ceil(north / rowAngle) - 2)
  const last = Math.min(height - 1, Math.floor(south / rowAngle) + 1)
  if (first === 0 && last === height - 1) return FULL_RANGE
  return sphereRowRange(first, last, segments)
}
