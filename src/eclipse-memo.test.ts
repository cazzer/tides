import * as THREE from 'three'
import {
  Body,
  GeoMoon,
  GeoVector,
  KM_PER_AU,
  RotateVector,
  Rotation_EQJ_ECT,
} from 'astronomy-engine'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { eclipticToScene } from './ephemeris'
import { eclipseBodies, type EclipseBodies } from './eclipse'

// Counts the ephemeris calls eclipseBodies makes, passing through to the real ones.
const calls = vi.hoisted(() => ({ moon: 0 }))
vi.mock('astronomy-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('astronomy-engine')>()
  return {
    ...real,
    GeoMoon: (date: Parameters<typeof real.GeoMoon>[0]) => {
      calls.moon += 1
      return real.GeoMoon(date)
    },
  }
})

// The unmemoized computation, as eclipseBodies did it before the cache.
function reference(t: number): EclipseBodies {
  const date = new Date(t)
  const toEcliptic = Rotation_EQJ_ECT(date)
  return {
    sun: eclipticToScene(
      RotateVector(toEcliptic, GeoVector(Body.Sun, date, true)),
      new THREE.Vector3()
    ).multiplyScalar(KM_PER_AU),
    moon: eclipticToScene(
      RotateVector(toEcliptic, GeoMoon(date)),
      new THREE.Vector3()
    ).multiplyScalar(KM_PER_AU),
  }
}

const blank = (): EclipseBodies => ({ sun: new THREE.Vector3(), moon: new THREE.Vector3() })
// Minutes apart: astronomy-engine reuses its nutation for times within ~86 ms
// of the last one it computed, which would blur the comparisons.
const T1 = Date.UTC(2024, 3, 8, 18, 17)
const T2 = Date.UTC(2025, 2, 14, 6, 58)
const MINUTE = 60_000

describe('eclipseBodies memo', () => {
  beforeEach(() => {
    calls.moon = 0
  })

  test('the same t is computed once and every caller gets the same bits', () => {
    const t = T1 + MINUTE
    const a = eclipseBodies(t, blank())
    const b = eclipseBodies(t, blank())
    const c = eclipseBodies(t)
    expect(calls.moon).toBe(1)
    const want = reference(t)
    for (const got of [a, b, c]) {
      expect(got.sun.toArray()).toEqual(want.sun.toArray())
      expect(got.moon.toArray()).toEqual(want.moon.toArray())
    }
  })

  test('a different t recomputes, and going back gives the first values again', () => {
    const first = eclipseBodies(T1, blank())
    const second = eclipseBodies(T2, blank())
    const again = eclipseBodies(T1, blank())
    expect(calls.moon).toBe(3)
    expect(second.moon.toArray()).toEqual(reference(T2).moon.toArray())
    expect(second.moon.equals(first.moon)).toBe(false)
    expect(again.sun.toArray()).toEqual(first.sun.toArray())
    expect(again.moon.toArray()).toEqual(first.moon.toArray())
  })

  test('fills and returns the caller’s own out, which it may then change freely', () => {
    const t = T2 + MINUTE
    const out = blank()
    const got = eclipseBodies(t, out)
    expect(got).toBe(out)
    out.sun.set(0, 0, 0)
    out.moon.multiplyScalar(2)
    const other = eclipseBodies(t, blank())
    expect(other.sun.toArray()).toEqual(reference(t).sun.toArray())
    expect(other.moon.toArray()).toEqual(reference(t).moon.toArray())
    expect(other.sun).not.toBe(out.sun)
  })
})
