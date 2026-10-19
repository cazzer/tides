import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import {
  diffuseEquatorwardLat,
  geomagneticAxis,
  geomagneticNorthPole,
  kpToAL,
  latLonToLocal,
  magneticLocalTime,
  ovalAt,
  ovalTable,
  sunDirectionLocal,
} from './aurora'
import { calculateLocationAndRotationForLatLng } from './utils'

const DEG = 180 / Math.PI

describe('geomagneticNorthPole', () => {
  // Published IGRF centred-dipole poles (rounded to ~0.1°).
  test.each([
    [2000, 79.6, -71.6],
    [2015, 80.4, -72.6],
    [2020, 80.7, -72.7],
    [2025, 80.8, -72.8],
  ])('%i', (year, lat, lon) => {
    const pole = geomagneticNorthPole(Date.UTC(year, 0, 1))
    expect(pole.lat).toBeCloseTo(lat, 0)
    expect(Math.abs(pole.lat - lat)).toBeLessThan(0.15)
    expect(Math.abs(pole.lon - lon)).toBeLessThan(0.15)
  })

  test('drifts smoothly between epochs and is held long after the last', () => {
    const a = geomagneticNorthPole(Date.UTC(2017, 6, 1))
    expect(a.lat).toBeGreaterThan(80.3)
    expect(a.lat).toBeLessThan(80.6)
    const far = geomagneticNorthPole(Date.UTC(2090, 0, 1))
    const held = geomagneticNorthPole(Date.UTC(2031, 0, 1))
    expect(far).toEqual(held)
    expect(geomagneticNorthPole(Date.UTC(1800, 0, 1))).toEqual(
      geomagneticNorthPole(Date.UTC(1900, 0, 1))
    )
  })

  test('axis is the pole in the Earth frame (matches the location pin)', () => {
    const t = Date.UTC(2020, 0, 1)
    const { lat, lon } = geomagneticNorthPole(t)
    const { position } = calculateLocationAndRotationForLatLng(lat, lon, 1)
    const axis = geomagneticAxis(t)
    expect(axis.x).toBeCloseTo(position.x, 9)
    expect(axis.y).toBeCloseTo(position.y, 9)
    expect(axis.z).toBeCloseTo(position.z, 9)
  })
})

describe('sunDirectionLocal', () => {
  test('June solstice noon UTC: subsolar point near 23.4°N, 0°', () => {
    const s = sunDirectionLocal(Date.UTC(2024, 5, 20, 12, 0))
    const lat = Math.asin(s.y) * DEG
    const lon = Math.atan2(-s.z, s.x) * DEG
    expect(lat).toBeCloseTo(23.4, 0)
    // Equation of time on 20 June is about −1.5 min = 0.4° west.
    expect(Math.abs(lon)).toBeLessThan(1.5)
  })

  test('December solstice 18:00 UTC: subsolar near 23.4°S, 90°W', () => {
    const s = sunDirectionLocal(Date.UTC(2024, 11, 21, 18, 0))
    expect(Math.asin(s.y) * DEG).toBeCloseTo(-23.4, 0)
    const lon = Math.atan2(-s.z, s.x) * DEG
    expect(Math.abs(lon + 90)).toBeLessThan(2)
  })
})

describe('oval boundaries', () => {
  test('Gussenhoven midnight boundary: 66.1 − 1.99·Kp', () => {
    expect(diffuseEquatorwardLat(0, 0)).toBeCloseTo(66.1, 5)
    expect(diffuseEquatorwardLat(9, 0)).toBeCloseTo(66.1 - 1.99 * 9, 5)
    expect(diffuseEquatorwardLat(3, 12)).toBeCloseTo(69.4 - 0.84 * 3, 5)
  })

  test('Gussenhoven fills missing MLT hours by interpolation, wrapping', () => {
    // 02 and 03 lie between the 01 and 04 fits.
    const at1 = diffuseEquatorwardLat(2, 1)
    const at4 = diffuseEquatorwardLat(2, 4)
    expect(diffuseEquatorwardLat(2, 2.5)).toBeCloseTo((at1 + at4) / 2, 5)
    expect(diffuseEquatorwardLat(2, 23.5)).toBeCloseTo(
      (diffuseEquatorwardLat(2, 23) + diffuseEquatorwardLat(2, 0)) / 2,
      5
    )
    expect(diffuseEquatorwardLat(2, 24 + 6)).toBeCloseTo(diffuseEquatorwardLat(2, 6), 9)
  })

  test('Kp to AL (Starkov 1994b) rises monotonically and is held at the top', () => {
    expect(kpToAL(0)).toBe(18)
    let prev = -Infinity
    for (let kp = 0; kp <= 9; kp += 0.25) {
      const al = kpToAL(kp)
      expect(al).toBeGreaterThanOrEqual(prev)
      prev = al
    }
    expect(kpToAL(9)).toBe(kpToAL(8.8))
  })

  test('quiet oval colatitudes are ~17-24°, and it expands with Kp', () => {
    const quiet = ovalAt(1, 0)
    expect(90 - quiet.polewardLat).toBeGreaterThan(15)
    expect(90 - quiet.diffuseLat).toBeLessThan(27)
    let prev = Infinity
    for (let kp = 0; kp <= 9; kp++) {
      const d = ovalAt(kp, 0).diffuseLat
      expect(d).toBeLessThan(prev)
      prev = d
    }
    // Storm curtains come down toward the diffuse edge; quiet ones don't.
    expect(ovalAt(9, 0).equatorwardLat).toBeCloseTo(diffuseEquatorwardLat(9, 0) + 4, 5)
    expect(ovalAt(3, 0).equatorwardLat).toBeGreaterThan(diffuseEquatorwardLat(3, 0) + 3)
    // A G5 storm reaches below 50° at midnight (colatitude ~40°).
    expect(90 - ovalAt(9, 0).diffuseLat).toBeGreaterThan(40)
    expect(90 - ovalAt(9, 0).diffuseLat).toBeLessThan(45)
  })

  test('nightside curtains are wider, lower and brighter than dayside', () => {
    for (const kp of [1, 3, 6, 9]) {
      const night = ovalAt(kp, 0)
      const day = ovalAt(kp, 12)
      expect(night.diffuseLat).toBeLessThan(day.diffuseLat)
      expect(night.polewardLat - night.equatorwardLat).toBeGreaterThan(
        day.polewardLat - day.equatorwardLat
      )
      expect(night.intensity).toBeGreaterThan(3 * day.intensity)
    }
  })

  test('boundaries stay ordered all around the oval', () => {
    for (const kp of [0, 2, 4, 6, 8, 9]) {
      for (let mlt = 0; mlt < 24; mlt += 0.5) {
        const s = ovalAt(kp, mlt)
        expect(s.diffuseLat).toBeLessThanOrEqual(s.equatorwardLat)
        expect(s.equatorwardLat).toBeLessThan(s.polewardLat)
        expect(s.polewardLat).toBeLessThan(90)
        expect(s.intensity).toBeGreaterThan(0)
        expect(s.intensity).toBeLessThanOrEqual(1)
      }
    }
  })

  test('ovalTable packs ovalAt per hour', () => {
    const table = ovalTable(5)
    expect(table).toHaveLength(96)
    const s = ovalAt(5, 7)
    expect(table[28]).toBeCloseTo(s.diffuseLat, 4)
    expect(table[29]).toBeCloseTo(s.equatorwardLat, 4)
    expect(table[30]).toBeCloseTo(s.polewardLat, 4)
    expect(table[31]).toBeCloseTo(s.intensity, 5)
  })
})

describe('magneticLocalTime', () => {
  const pole = new THREE.Vector3(0, 1, 0)
  const sun = latLonToLocal(0, 0)

  test('midnight opposite the Sun, dawn to its east', () => {
    expect(magneticLocalTime(latLonToLocal(60, 180), pole, sun)).toBeCloseTo(0, 6)
    expect(magneticLocalTime(latLonToLocal(60, 0), pole, sun)).toBeCloseTo(12, 6)
    // East of the midnight meridian is after midnight.
    expect(magneticLocalTime(latLonToLocal(60, -90), pole, sun)).toBeCloseTo(6, 6)
    expect(magneticLocalTime(latLonToLocal(-60, 90), pole, sun)).toBeCloseTo(18, 6)
  })
})
