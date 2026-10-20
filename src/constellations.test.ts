import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import constellations from './assets/constellations.json'
import starsMeta from './assets/stars.meta.json'
import { constellationSegmentsEQJ } from './constellations'
import { starDirectionsEQJ } from './renderers/Starfield'

const DEG = 180 / Math.PI

const starData = new Float32Array(
  readFileSync(new URL('./assets/stars.bin', import.meta.url)).buffer.slice(0)
)
const starDirections = starDirectionsEQJ(starData, starsMeta.stride)
const starCount = starDirections.length / 3

// Angle (degrees) from a direction to the nearest Starfield vertex.
function nearestStar(segments: Float32Array, at: number) {
  let bestDot = -Infinity
  for (let i = 0; i < starCount; i++) {
    const dot =
      segments[at] * starDirections[i * 3] +
      segments[at + 1] * starDirections[i * 3 + 1] +
      segments[at + 2] * starDirections[i * 3 + 2]
    if (dot > bestDot) bestDot = dot
  }
  return Math.acos(Math.min(bestDot, 1)) * DEG
}

describe('constellation lines', () => {
  const segments = constellationSegmentsEQJ(constellations.figures)

  test('draws the major figures', () => {
    expect(Object.keys(constellations.figures)).toHaveLength(46)
    for (const id of ['Ori', 'UMa', 'Cru', 'Cas', 'Sco', 'Leo']) {
      expect(constellations.figures).toHaveProperty(id)
    }
  })

  // Same frame as the stars: every endpoint lands on a catalog star.
  test('every endpoint sits on a Starfield star', () => {
    let worst = 0
    for (let at = 0; at < segments.length; at += 3) {
      worst = Math.max(worst, nearestStar(segments, at))
    }
    expect(worst).toBeLessThan(0.05)
  })
})
