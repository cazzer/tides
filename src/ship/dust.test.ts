import { describe, expect, test } from 'vitest'
import { OVERSPEED_MAX, V_NORMAL, V_TOP } from './flight'
import { SHIP_FOV } from './ship-session'
import {
  DUST_HALF_SIZE,
  DUST_SIZE_BASE,
  DUST_SPEED_BASE,
  CRUISE_DIM,
  CRUISE_DIM_DEPTH,
  FOV_KICK_DEPTH,
  EDGE_FADE,
  FOV_KICK,
  MAX_STREAK_SHARE,
  NEAR_FADE,
  STOPPED_OPACITY,
  STREAK_ENERGY_FLOOR,
  distanceFade,
  dustLevel,
  easeToward,
  fovKickShare,
  layerHalfSize,
  motionOpacity,
  positiveMod,
  slotLayer,
  speedDepth,
  speedFov,
  speedFraction,
  streakEnergy,
  streakLength,
  wrapCoord,
  wrapOffset,
  dustAnchor,
} from './dust'

// The world position of the mote `seed` that sits nearest `camera`, by brute
// force over the lattice of box copies.
function nearestCopy(seed: number, halfSize: number, camera: number): number {
  const side = 2 * halfSize
  let best = Infinity
  for (let n = -1000; n <= 1000; n++) {
    const x = seed * side + n * side
    if (Math.abs(x - camera) < Math.abs(best - camera)) best = x
  }
  return best
}

describe('wrap', () => {
  test('positiveMod matches GLSL mod for negatives', () => {
    expect(positiveMod(-0.5, 2)).toBeCloseTo(1.5)
    expect(positiveMod(5, 2)).toBeCloseTo(1)
    expect(positiveMod(0, 2)).toBe(0)
  })

  test('a mote lands in the box around the camera, at its nearest world copy', () => {
    const h = 3
    for (const camera of [0, 0.4, -7.3, 123.456, -999.9]) {
      for (const seed of [0, 0.1, 0.5, 0.77, 0.999]) {
        const rel = wrapCoord(seed, h, wrapOffset(camera, h))
        expect(rel).toBeGreaterThanOrEqual(-h)
        expect(rel).toBeLessThan(h)
        expect(camera + rel).toBeCloseTo(nearestCopy(seed, h, camera), 6)
      }
    }
  })

  test('motes are world-fixed: moving the camera moves them the other way', () => {
    const h = 1
    const seed = 0.6
    const a = wrapCoord(seed, h, wrapOffset(10, h))
    const b = wrapCoord(seed, h, wrapOffset(10.2, h))
    expect(b - a).toBeCloseTo(-0.2)
  })

  test('a mote leaving one face comes back on the opposite one', () => {
    const h = 1
    const seed = 0.5
    // seed 0.5 sits at world 1 (+ multiples of 2). A camera flying +x past
    // x = 2 leaves that copy behind at −h and meets the next one at +h.
    const before = wrapCoord(seed, h, wrapOffset(2 - 0.01, h))
    const after = wrapCoord(seed, h, wrapOffset(2 + 0.01, h))
    expect(before).toBeCloseTo(-h + 0.01)
    expect(after).toBeCloseTo(h - 0.01)
  })

  test('keeps precision far from the origin', () => {
    const h = layerHalfSize(5)
    const camera = 1e7 + 0.123
    const rel = wrapCoord(0.25, h, wrapOffset(camera, h))
    expect(Math.abs(rel)).toBeLessThanOrEqual(h)
  })
})

describe('layers', () => {
  test('level is 0 at or below V_NORMAL and +1 per DUST_SPEED_BASE×', () => {
    expect(dustLevel(0)).toBe(0)
    expect(dustLevel(Number.NaN)).toBe(0)
    expect(dustLevel(V_NORMAL)).toBe(0)
    expect(dustLevel(V_NORMAL * DUST_SPEED_BASE)).toBeCloseTo(1)
    expect(dustLevel(V_NORMAL * DUST_SPEED_BASE ** 3)).toBeCloseTo(3)
  })

  test('layer boxes grow by DUST_SIZE_BASE, slower than the speeds they serve', () => {
    expect(layerHalfSize(0)).toBe(DUST_HALF_SIZE)
    expect(layerHalfSize(2)).toBeCloseTo(DUST_HALF_SIZE * DUST_SIZE_BASE ** 2)
    expect(DUST_SIZE_BASE).toBeLessThan(DUST_SPEED_BASE)
  })

  test('the two slots crossfade with weights summing to 1', () => {
    for (const level of [0, 0.3, 1, 1.5, 2.99, 4.2]) {
      const a = slotLayer(level, 0)
      const b = slotLayer(level, 1)
      expect(a.weight + b.weight).toBeCloseTo(1)
      expect(a.layer % 2).toBe(0)
      expect(b.layer % 2).toBe(1)
      expect(Math.abs(a.layer - b.layer)).toBe(1)
      expect(Math.min(a.layer, b.layer)).toBe(Math.floor(level))
    }
  })

  test('at rest only layer 0 shows', () => {
    expect(slotLayer(0, 0)).toEqual({ layer: 0, weight: 1 })
    expect(slotLayer(0, 1)).toEqual({ layer: 1, weight: 0 })
  })

  test('a slot changes layer only while its weight is ~0', () => {
    const eps = 1e-6
    for (const slot of [0, 1] as const) {
      for (let level = 0; level < 6; level += 0.01) {
        const a = slotLayer(level, slot)
        const b = slotLayer(level + eps, slot)
        if (a.layer !== b.layer) {
          expect(a.weight).toBeLessThan(1e-3)
          expect(b.weight).toBeLessThan(1e-3)
        } else {
          expect(Math.abs(a.weight - b.weight)).toBeLessThan(1e-3)
        }
      }
    }
  })
})

describe('streaks', () => {
  test('zero when stopped', () => {
    expect(streakLength(0, 0, 1)).toBe(0)
  })

  test('grow with speed', () => {
    let last = 0
    for (const speed of [0.05, 0.25, 1, 5, 20, 80]) {
      const level = dustLevel(speed)
      const length = streakLength(speed, level, layerHalfSize(Math.floor(level)))
      expect(length).toBeGreaterThan(last)
      last = length
    }
  })

  test('are dots at skimming speed and streaks in cruise, relative to the box', () => {
    const share = (speed: number) => {
      const level = dustLevel(speed)
      return streakLength(speed, level, layerHalfSize(level))
        / layerHalfSize(level)
    }
    expect(share(V_NORMAL)).toBeLessThan(0.01)
    expect(share(100)).toBeGreaterThan(0.05)
    expect(share(100)).toBeGreaterThan(10 * share(V_NORMAL))
  })

  test('are capped at a share of the layer half-size', () => {
    expect(streakLength(1e6, 3, 5)).toBe(MAX_STREAK_SHARE * 5)
  })

  test('dim as they lengthen, down to a floor', () => {
    expect(streakEnergy(0, 1.5)).toBe(1)
    expect(streakEnergy(3, 1.5)).toBeCloseTo(0.5)
    expect(streakEnergy(3, 1.5)).toBeGreaterThan(streakEnergy(5, 1.5))
    expect(streakEnergy(1e4, 1.5)).toBe(STREAK_ENERGY_FLOOR)
  })
})

describe('fades', () => {
  test('motes vanish at the camera and at the box faces, full in between', () => {
    expect(distanceFade(0, 0, 0)).toBe(0)
    expect(distanceFade(NEAR_FADE[0], 0, 0)).toBe(0)
    expect(distanceFade(0, 0.5, 0)).toBe(1)
    expect(distanceFade(0.4, -0.4, 0.4)).toBe(1)
    expect(distanceFade(0, 0, -EDGE_FADE[1])).toBe(0)
    expect(distanceFade(0.2, EDGE_FADE[1], 0.2)).toBe(0)
    expect(distanceFade(1, 1, 1)).toBe(0)
  })

  test('the near fade clears the deepest near plane on layer 0', () => {
    // shipNear tops out at 0.1 units.
    expect(NEAR_FADE[0] * layerHalfSize(0)).toBeGreaterThanOrEqual(0.1)
  })

  test('field is dimmer at rest, full when moving, dimmed in high cruise', () => {
    expect(motionOpacity(0)).toBeCloseTo(STOPPED_OPACITY)
    expect(motionOpacity(V_NORMAL)).toBeCloseTo(1)
    // Earth → Moon cruise is undimmed; the dimming spans the rest up to V_TOP.
    expect(motionOpacity(2.7)).toBeCloseTo(1)
    expect(motionOpacity(20)).toBeLessThan(1)
    expect(motionOpacity(20)).toBeGreaterThan(motionOpacity(80))
    expect(motionOpacity(V_TOP)).toBeCloseTo(1 - CRUISE_DIM)
    expect(motionOpacity(OVERSPEED_MAX * V_TOP)).toBeCloseTo(1 - CRUISE_DIM)
  })
})

describe('speed depth', () => {
  test('runs 0 at V_NORMAL to 1 at V_TOP on a log scale, clamped', () => {
    expect(speedDepth(0)).toBe(0)
    expect(speedDepth(NaN)).toBe(0)
    expect(speedDepth(V_NORMAL)).toBe(0)
    expect(speedDepth(V_TOP)).toBeCloseTo(1)
    expect(speedDepth(3 * V_TOP)).toBe(1)
    expect(speedDepth(Math.sqrt(V_NORMAL * V_TOP))).toBeCloseTo(0.5)
  })

  test('the cue ranges sit inside V_NORMAL..V_TOP', () => {
    for (const [a, b] of [CRUISE_DIM_DEPTH, FOV_KICK_DEPTH]) {
      expect(a).toBeGreaterThan(0)
      expect(b).toBeLessThanOrEqual(1)
      expect(a).toBeLessThan(b)
    }
  })
})

describe('speed FOV', () => {
  test('fraction of the cruise cap, clamped, 0 before the cap is known', () => {
    expect(speedFraction(0.125, 0.25)).toBeCloseTo(0.5)
    expect(speedFraction(10, 5)).toBe(1)
    expect(speedFraction(1, 0)).toBe(0)
  })

  test('the kick needs real speed, not just a full throttle', () => {
    // Full throttle crawling past the Moon: at the cap, but slow.
    expect(fovKickShare(V_NORMAL, V_NORMAL)).toBe(0)
    expect(fovKickShare(0.8, 0.8)).toBe(0)
    // Earth → Moon cruise, at its cap: barely any.
    expect(fovKickShare(2.7, 2.7)).toBeLessThan(0.01)
    // Interplanetary cruise at the cap: all of it.
    expect(fovKickShare(V_TOP, V_TOP)).toBe(1)
    expect(fovKickShare(100, 100)).toBe(1)
    // Fast but well under the cap.
    expect(fovKickShare(V_TOP / 2, V_TOP)).toBeCloseTo(0.5)
    const top = V_NORMAL * (V_TOP / V_NORMAL) ** FOV_KICK_DEPTH[1]
    expect(fovKickShare(top / 2, top)).toBeGreaterThan(0)
    expect(fovKickShare(top / 2, top)).toBeLessThan(0.5)
  })

  test('overspeed earns no more kick than the cap', () => {
    for (const cap of [V_NORMAL, 5, V_TOP]) {
      expect(fovKickShare(OVERSPEED_MAX * cap, cap)).toBeLessThanOrEqual(1)
      expect(fovKickShare(OVERSPEED_MAX * cap, cap)).toBeLessThanOrEqual(
        fovKickShare(OVERSPEED_MAX * cap, OVERSPEED_MAX * cap)
      )
    }
  })

  test('no kick under prefers-reduced-motion', () => {
    expect(speedFov(1, true)).toBe(SHIP_FOV)
    expect(speedFov(0.5, true)).toBe(SHIP_FOV)
  })

  test('SHIP_FOV at rest, +FOV_KICK at the cap, monotonic between', () => {
    expect(speedFov(0)).toBe(SHIP_FOV)
    expect(speedFov(1)).toBe(SHIP_FOV + FOV_KICK)
    expect(speedFov(0.5)).toBeGreaterThan(SHIP_FOV)
    expect(speedFov(0.5)).toBeLessThan(speedFov(0.6))
  })

  test('eases with the given time constant and never overshoots', () => {
    expect(easeToward(0, 1, 0.5, 0.5)).toBeCloseTo(1 - Math.exp(-1))
    expect(easeToward(1, 0, 10, 0.5)).toBeCloseTo(0)
    expect(easeToward(0, 1, 0, 0.5)).toBe(0)
    let x = 0
    for (let i = 0; i < 120; i++) {
      const next = easeToward(x, 1, 1 / 60, 0.5)
      expect(next).toBeGreaterThan(x)
      expect(next).toBeLessThanOrEqual(1)
      x = next
    }
    expect(x).toBeGreaterThan(0.98)
  })
})

describe('dustAnchor (tides-zmw.9.18)', () => {
  test('wraps on the camera less what the frame carry moved: zero carried is the camera', () => {
    const camera = { x: 1000.25, y: -3.5, z: 7 }
    expect(dustAnchor(camera, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toEqual(camera)
    expect(dustAnchor(camera, { x: 0.25, y: 0.5, z: -1 }, { x: 0, y: 0, z: 0 })).toEqual({ x: 1000, y: -4, z: 8 })
    // A ship carried with Earth, still in the carried frame: the motes keep their wrap.
    const h = 0.01
    const start = dustAnchor(camera, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    const later = dustAnchor({ x: camera.x + 0.3, y: camera.y, z: camera.z }, { x: 0.3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(wrapOffset(later.x, h)).toBeCloseTo(wrapOffset(start.x, h), 9)
  })
})
