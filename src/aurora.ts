// Aurora geometry (tides-qe5): where the auroral ovals sit for a given Kp and
// date. Pure maths; the renderer is ./renderers/AuroraRenderer.tsx and the Kp
// data feed is ./aurora-kp.ts.
//
// All latitudes here are geomagnetic (centred-dipole) latitudes in degrees.
// The published models use corrected geomagnetic (CGM) latitude; the dipole
// is within a few degrees of CGM at auroral latitudes, which is far below what
// the oval's own variability makes visible.
import * as THREE from 'three'
import { EARTH_AXIAL_TILT, earthPosition, earthSpin } from './ephemeris'
import { applyBodyTransform } from './body-transform'

const DEG = Math.PI / 180

/** Kp shown when Real weather is off or no data covers the sim time: "2+" to
 * "3-", a typical quiet-to-unsettled night. */
export const DEFAULT_KP = 2.67

// --- Geomagnetic pole -------------------------------------------------------

/** IGRF degree-1 Gauss coefficients [year, g10, g11, h11] in nT (DGRF/IGRF
 * main-field values, IGRF-13/14). The dipole axis follows from these. */
const IGRF_DIPOLE: readonly (readonly [number, number, number, number])[] = [
  [1900, -31543, -2298, 5922],
  [1950, -30554, -2250, 5815],
  [1980, -29992, -1956, 5604],
  [2000, -29619.4, -1728.2, 5186.1],
  [2010, -29496.57, -1586.42, 4944.26],
  [2015, -29441.46, -1501.77, 4795.99],
  [2020, -29404.8, -1450.9, 4652.5],
  [2025, -29350.0, -1410.3, 4545.5],
]
// The last epoch's rate is carried this many years forward, then held.
const EXTRAPOLATE_YEARS = 5

function decimalYear(ms: number): number {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  return y + (ms - start) / (Date.UTC(y + 1, 0, 1) - start)
}

function dipoleCoefficients(ms: number): [number, number, number] {
  const year = decimalYear(ms)
  const table = IGRF_DIPOLE
  const first = table[0]
  if (year <= first[0]) return [first[1], first[2], first[3]]
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1]
    const b = table[i]
    if (year <= b[0] || i === table.length - 1) {
      // Past the last epoch, extrapolate its rate a few years, like IGRF's
      // secular variation, then hold.
      const y = Math.min(year, table[table.length - 1][0] + EXTRAPOLATE_YEARS)
      const f = (y - a[0]) / (b[0] - a[0])
      return [
        a[1] + f * (b[1] - a[1]),
        a[2] + f * (b[2] - a[2]),
        a[3] + f * (b[3] - a[3]),
      ]
    }
  }
  return [first[1], first[2], first[3]]
}

/** The boreal geomagnetic (centred-dipole) pole, in geographic degrees (lon
 * east-positive). About 80.65°N 72.68°W in 2020. */
export function geomagneticNorthPole(ms: number): { lat: number; lon: number } {
  const [g10, g11, h11] = dipoleCoefficients(ms)
  const b0 = Math.hypot(g10, g11, h11)
  return {
    lat: Math.asin(-g10 / b0) / DEG,
    lon: Math.atan2(-h11, -g11) / DEG,
  }
}

/** A geographic lat/lon as a unit vector in the Earth's local frame: lon 0
 * on +X, east toward −Z, north on +Y (as calculateLocationAndRotationForLatLng). */
export function latLonToLocal(
  lat: number,
  lon: number,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const phi = lat * DEG
  const lambda = -lon * DEG
  return out.set(
    Math.cos(phi) * Math.cos(lambda),
    Math.sin(phi),
    Math.cos(phi) * Math.sin(lambda)
  )
}

/** The northern dipole axis in the Earth's local frame. */
export function geomagneticAxis(ms: number, out = new THREE.Vector3()): THREE.Vector3 {
  const { lat, lon } = geomagneticNorthPole(ms)
  return latLonToLocal(lat, lon, out)
}

// --- Sun direction ----------------------------------------------------------

const earthFrame = new THREE.Object3D()
const inverse = new THREE.Quaternion()

/** Unit vector toward the Sun in the Earth's local (rotating) frame: the
 * direction Sunlight.tsx shines from, undone by the Earth's tilt and spin. */
export function sunDirectionLocal(ms: number, out = new THREE.Vector3()): THREE.Vector3 {
  applyBodyTransform(
    earthFrame,
    { axialTilt: EARTH_AXIAL_TILT, spinAt: earthSpin },
    ms
  )
  earthFrame.updateMatrix()
  const [x, y, z] = earthPosition(ms)
  inverse.copy(earthFrame.quaternion).invert()
  return out.set(-x, -y, -z).normalize().applyQuaternion(inverse)
}

// --- Oval boundaries --------------------------------------------------------

/** Gussenhoven, Hardy & Heinemann (1983), "Systematics of the equatorward
 * diffuse auroral boundary", JGR 88(A7), 5692-5708: per-MLT-hour linear fits
 * λ = λ0 + α·Kp for the equatorward edge of the diffuse aurora. Coefficients
 * as tabulated in ocbpy (boundaries/models.py, gussenhoven_colatitudes);
 * 02, 03, 13 and 14 MLT have no fit and are interpolated. */
const GUSSENHOVEN: Readonly<Record<number, readonly [number, number]>> = {
  0: [66.1, -1.99],
  1: [65.1, -1.55],
  4: [67.7, -1.48],
  5: [67.8, -1.87],
  6: [68.2, -1.9],
  7: [68.9, -1.91],
  8: [69.3, -1.87],
  9: [69.5, -1.67],
  10: [69.6, -1.41],
  11: [70.1, -1.25],
  12: [69.4, -0.84],
  15: [70.9, -0.81],
  16: [71.6, -1.28],
  17: [71.1, -1.31],
  18: [71.2, -1.74],
  19: [70.4, -1.83],
  20: [69.4, -1.89],
  21: [68.6, -1.86],
  22: [67.9, -1.78],
  23: [67.8, -2.07],
}

const GUSSENHOVEN_HOURS = Object.keys(GUSSENHOVEN)
  .map(Number)
  .sort((a, b) => a - b)

/** Equatorward edge of the diffuse aurora (geomagnetic latitude, degrees). */
export function diffuseEquatorwardLat(kp: number, mltHours: number): number {
  const h = ((mltHours % 24) + 24) % 24
  let lo = GUSSENHOVEN_HOURS[GUSSENHOVEN_HOURS.length - 1] - 24
  let hi = GUSSENHOVEN_HOURS[0] + 24
  for (const hour of GUSSENHOVEN_HOURS) {
    if (hour <= h) lo = hour
    if (hour >= h) {
      hi = hour
      break
    }
  }
  const at = (hour: number) => {
    const [l0, a] = GUSSENHOVEN[(hour + 24) % 24]
    return l0 + a * kp
  }
  if (hi === lo) return at(lo)
  return at(lo) + ((h - lo) / (hi - lo)) * (at(hi) - at(lo))
}

/** Starkov (1994), "Mathematical model of the auroral boundaries", Geomagn.
 * Aeron. 34(3), 331-336: each boundary is A0 + Σ Ai·cos(15°·(i·MLT + αi)),
 * every coefficient a cubic in log10|AL|. Coefficients as in ocbpy
 * (starkov_coefficient_values). 'eab' and 'ocb' bound the discrete oval. */
const STARKOV = {
  eab: {
    A0: [1.16, 23.21, -10.97, 2.03],
    A1: [-9.59, 17.78, -7.2, 0.96],
    alpha1: [-2.22, 1.5, -0.58, 0.08],
    A2: [-12.07, 17.49, -7.96, 1.15],
    alpha2: [-23.98, 42.79, -26.96, 5.56],
    A3: [-6.56, 11.44, -6.73, 1.31],
    alpha3: [-20.07, 36.67, -24.2, 5.11],
  },
  ocb: {
    A0: [-0.07, 24.54, -12.53, 2.15],
    A1: [-10.06, 19.83, -9.33, 1.24],
    alpha1: [-6.61, 10.17, -5.8, 1.19],
    A2: [-4.44, 7.47, -3.01, 0.25],
    alpha2: [6.37, -1.1, 0.34, -0.38],
    A3: [-3.77, 7.9, -4.73, 0.91],
    alpha3: [-4.48, 10.16, -5.87, 0.98],
  },
} as const

type StarkovBoundary = keyof typeof STARKOV

/** |AL| (nT) from Kp, Starkov (1994b) as used by Sigernes et al. (2011),
 * "Two methods to forecast auroral displays", J. Space Weather Space Clim. 1,
 * A03: AL = 18 − 12.3Kp + 27.2Kp² − 2Kp³. The cubic dips just below 18 near
 * Kp 0.2 and peaks near Kp 8.8, so it is held at both rather than turning
 * back. */
export function kpToAL(kp: number): number {
  const k = Math.min(Math.max(kp, 0), 8.8)
  return Math.max(18, 18 - 12.3 * k + 27.2 * k * k - 2 * k * k * k)
}

function starkovColatitude(boundary: StarkovBoundary, al: number, mltHours: number) {
  const l = Math.log10(Math.max(Math.abs(al), 1))
  const c = STARKOV[boundary]
  const poly = (t: readonly number[]) => t[0] + t[1] * l + t[2] * l * l + t[3] * l * l * l
  const deg = 15 * DEG
  return (
    poly(c.A0) +
    poly(c.A1) * Math.cos(deg * (mltHours + poly(c.alpha1))) +
    poly(c.A2) * Math.cos(deg * (2 * mltHours + poly(c.alpha2))) +
    poly(c.A3) * Math.cos(deg * (3 * mltHours + poly(c.alpha3)))
  )
}

export interface OvalSlice {
  /** Equatorward edge of the diffuse glow (Gussenhoven). */
  diffuseLat: number
  /** Equatorward edge of the discrete curtains (Starkov 'eab'). */
  equatorwardLat: number
  /** Poleward edge of the oval (Starkov 'ocb'). */
  polewardLat: number
  /** Relative brightness, 0..1, of this MLT sector at this activity. */
  intensity: number
}

/** Pre-midnight, where substorm arcs brighten first (Hardy & Gussenhoven
 * 1985 put the electron energy-flux peak at ~22-23 MLT). */
const BRIGHTEST_MLT = 23
/** Degrees poleward of the diffuse boundary that severe-storm curtains reach. */
const STORM_REACH = 4

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export function ovalAt(kp: number, mltHours: number): OvalSlice {
  const al = kpToAL(kp)
  const polewardLat = 90 - starkovColatitude('ocb', al, mltHours)
  const diffuse = diffuseEquatorwardLat(kp, mltHours)
  // Kp tops out at 9 and Starkov's AL(Kp) near 8, so on their own the
  // curtains stall around 60° however big the storm. In severe storms they
  // may reach to within STORM_REACH of the (linear) diffuse boundary, which
  // puts G5 curtains near 52° at midnight, where they were seen overhead in
  // May 2024. Below Kp ~7 this changes nothing. Keep a sliver of oval where
  // the fits cross.
  const reach = STORM_REACH + 20 * (1 - smoothstep(5, 8.5, kp))
  const equatorwardLat = Math.min(
    90 - starkovColatitude('eab', al, mltHours),
    diffuse + reach,
    polewardLat - 1
  )
  const diffuseLat = Math.min(diffuse, equatorwardLat)
  const night = 0.5 + 0.5 * Math.cos(((mltHours - BRIGHTEST_MLT) / 24) * 2 * Math.PI)
  const activity = 0.3 + 0.7 * Math.min(Math.max(kp / 8, 0), 1)
  return {
    diffuseLat,
    equatorwardLat,
    polewardLat,
    intensity: activity * (0.12 + 0.88 * night ** 1.5),
  }
}

export const OVAL_TABLE_HOURS = 24

/** ovalAt for each whole MLT hour, packed (diffuse, equatorward, poleward,
 * intensity) for the shader's vec4 uniform array. */
export function ovalTable(kp: number, out = new Float32Array(OVAL_TABLE_HOURS * 4)) {
  for (let h = 0; h < OVAL_TABLE_HOURS; h++) {
    const s = ovalAt(kp, h)
    out[h * 4] = s.diffuseLat
    out[h * 4 + 1] = s.equatorwardLat
    out[h * 4 + 2] = s.polewardLat
    out[h * 4 + 3] = s.intensity
  }
  return out
}

/** Magnetic local time (hours) of a local-frame unit vector: 0 on the
 * anti-sunward meridian, increasing eastward. Mirrors the shader. */
export function magneticLocalTime(
  point: THREE.Vector3,
  pole: THREE.Vector3,
  sun: THREE.Vector3
): number {
  const midnight = sun.clone().addScaledVector(pole, -sun.dot(pole)).negate().normalize()
  const dawn = new THREE.Vector3().crossVectors(pole, midnight)
  const p = point.clone().addScaledVector(pole, -point.dot(pole))
  const angle = Math.atan2(p.dot(dawn), p.dot(midnight))
  return (((angle / (2 * Math.PI)) * 24) % 24 + 24) % 24
}
