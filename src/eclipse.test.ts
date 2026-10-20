import * as THREE from 'three'
import { afterAll, describe, expect, test } from 'vitest'
import { earthSpin, earthTilt } from './ephemeris'
import { applyBodyTransform } from './body-transform'
import { calculateLocationAndRotationForLatLng } from './utils'
import {
  coveredFraction,
  createEclipseShading,
  shadingAt,
  surfacePoint,
  updateEclipseShading,
} from './eclipse'
import { createEclipseShadow } from './renderers/eclipseShadow'

// Eclipse circumstances from NASA's eclipse site (Espenak): the 2024-04-08
// total solar and 2025-03-14 total lunar eclipses. The shadows are traced as
// the shader does: from the texel at a lat/lon on the scene's Earth, oriented
// as the scene orients it.

const SECOND = 1000
const MINUTE = 60 * SECOND
const fmt = (t: number) => new Date(t).toISOString().slice(11, 19)

const earth = createEclipseShading('earth')
const moon = createEclipseShading('moon')
const identity = new THREE.Quaternion()

function sunVisibleAt(t: number, lat: number, lon: number): number {
  const body = new THREE.Object3D()
  applyBodyTransform(
    body,
    { tiltAt: earthTilt, spinAt: earthSpin },
    t
  )
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, 1)
  const local = new THREE.Vector3(position.x, position.y, position.z)
  updateEclipseShading(earth, 'earth', t)
  return shadingAt(earth, surfacePoint(earth, local, body.quaternion))
}

// Totality at a place, to the second.
function totality(lat: number, lon: number, from: string, to: string) {
  let start: number | null = null
  let end: number | null = null
  for (let t = Date.parse(from); t <= Date.parse(to); t += SECOND) {
    if (sunVisibleAt(t, lat, lon) === 0) {
      start ??= t
      end = t
    }
  }
  return { start, end }
}

// Points on the Moon's limb as seen from the Earth's centre, where the
// tables' contacts are measured.
function moonLimb(t: number): THREE.Vector3[] {
  updateEclipseShading(moon, 'moon', t)
  const toEarth = moon.occluder.clone().normalize()
  const u = new THREE.Vector3(0, 1, 0).cross(toEarth).normalize()
  const v = toEarth.clone().cross(u)
  return Array.from({ length: 180 }, (_, i) => {
    const a = (i / 180) * 2 * Math.PI
    const dir = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a))
    return surfacePoint(moon, dir, identity)
  })
}

const report: Record<string, unknown>[] = []
afterAll(() => console.table(report))

describe('coveredFraction', () => {
  test('apart, touching, inside', () => {
    expect(coveredFraction(1, 1, 2.5)).toBe(0)
    expect(coveredFraction(1, 1, 2)).toBe(0)
    expect(coveredFraction(1, 1.05, 0.02)).toBe(1)
    // Annular: the Moon's disc's share of the Sun's area.
    expect(coveredFraction(1, 0.9, 0.05)).toBeCloseTo(0.81, 10)
  })

  test('lens of two equal discs one radius apart', () => {
    // 2·acos(½) − ½·√3, over π.
    const lens = (2 * Math.acos(0.5) - Math.sqrt(3) / 2) / Math.PI
    expect(coveredFraction(2, 2, 2)).toBeCloseTo(lens, 12)
  })

  test('continuous across the internal contact', () => {
    const r = 0.9
    const edge = 1 - r
    expect(coveredFraction(1, r, edge + 1e-9)).toBeCloseTo(r * r, 6)
    expect(coveredFraction(1, 1.1, 0.1 + 1e-9)).toBeCloseTo(1, 6)
  })

  test('grows as the discs close', () => {
    let last = 0
    for (let d = 2; d >= 0; d -= 0.01) {
      const f = coveredFraction(1, 1.03, d)
      expect(f).toBeGreaterThanOrEqual(last - 1e-12)
      last = f
    }
  })
})

describe('total solar eclipse 2024-04-08', () => {
  test('greatest eclipse: 25.29°N 104.14°W, 4m28s around 18:17:16', () => {
    const { start, end } = totality(
      25.29,
      -104.14,
      '2024-04-08T18:12:00Z',
      '2024-04-08T18:23:00Z'
    )
    expect(start).not.toBeNull()
    const duration = (end! - start! + SECOND) / SECOND
    const mid = (start! + end!) / 2
    report.push({ case: 'greatest', C2: fmt(start!), C3: fmt(end!), s: duration })
    expect(Math.abs(duration - 268)).toBeLessThan(10)
    expect(Math.abs(mid - Date.parse('2024-04-08T18:17:16Z'))).toBeLessThan(15 * SECOND)
  })

  test('Dallas: totality 1:40–1:44 pm CDT, 3m51s', () => {
    const { start, end } = totality(
      32.7767,
      -96.797,
      '2024-04-08T18:36:00Z',
      '2024-04-08T18:49:00Z'
    )
    expect(start).not.toBeNull()
    const duration = (end! - start! + SECOND) / SECOND
    report.push({ case: 'Dallas', C2: fmt(start!), C3: fmt(end!), s: duration })
    expect(fmt(start!).slice(0, 5)).toBe('18:40')
    expect(fmt(end!).slice(0, 5)).toBe('18:44')
    expect(Math.abs(duration - 231)).toBeLessThan(15)
  })

  test('outside the path: Houston partial, New York ~90%', () => {
    let houston = 1
    let newYork = 1
    for (let t = Date.parse('2024-04-08T18:30:00Z'); t < Date.parse('2024-04-08T19:45:00Z'); t += 10 * SECOND) {
      houston = Math.min(houston, sunVisibleAt(t, 29.7604, -95.3698))
      newYork = Math.min(newYork, sunVisibleAt(t, 40.7128, -74.006))
    }
    report.push({ case: 'Houston max obscuration', value: +(1 - houston).toFixed(3) })
    report.push({ case: 'New York max obscuration', value: +(1 - newYork).toFixed(3) })
    expect(houston).toBeGreaterThan(0)
    expect(1 - houston).toBeGreaterThan(0.9)
    expect(1 - newYork).toBeGreaterThan(0.87)
    expect(1 - newYork).toBeLessThan(0.92)
  })

  test('the night side and the far side of the Earth stay lit', () => {
    const t = Date.parse('2024-04-08T18:17:16Z')
    expect(sunVisibleAt(t, -25.29, 75.86)).toBe(1)
    expect(sunVisibleAt(t, 0, 0)).toBe(1)
  })
})

describe('total lunar eclipse 2025-03-14', () => {
  // NASA: P1 03:57:28, U1 05:09:40, U2 06:26:06, greatest 06:58:43,
  // U3 07:31:26, U4 08:47:59, P4 10:00:09 UTC.
  const expected = {
    P1: '03:57:28',
    U1: '05:09:40',
    U2: '06:26:06',
    U3: '07:31:26',
    U4: '08:47:59',
    P4: '10:00:09',
  }
  const found: Record<string, number> = {}
  let previous = { penumbra: false, someUmbra: false, allUmbra: false }
  for (
    let t = Date.parse('2025-03-14T03:30:00Z');
    t < Date.parse('2025-03-14T10:30:00Z');
    t += 2 * SECOND
  ) {
    const visible = moonLimb(t).map((p) => shadingAt(moon, p))
    const now = {
      penumbra: visible.some((f) => f < 1),
      someUmbra: visible.some((f) => f === 0),
      allUmbra: visible.every((f) => f === 0),
    }
    if (now.penumbra !== previous.penumbra) found[now.penumbra ? 'P1' : 'P4'] = t
    if (now.someUmbra !== previous.someUmbra) found[now.someUmbra ? 'U1' : 'U4'] = t
    if (now.allUmbra !== previous.allUmbra) found[now.allUmbra ? 'U2' : 'U3'] = t
    previous = now
  }

  test.each(Object.entries(expected))('%s at %s', (contact, time) => {
    const want = Date.parse(`2025-03-14T${time}Z`)
    expect(found[contact]).toBeDefined()
    const error = (found[contact] - want) / SECOND
    report.push({ case: `lunar ${contact}`, NASA: time, scene: fmt(found[contact]), 'err s': error })
    // The penumbral contacts are the softest to time.
    expect(Math.abs(error)).toBeLessThan(contact.startsWith('P') ? 45 : 20)
  })

  test('the Moon is wholly dark at greatest eclipse and lit after', () => {
    const greatest = Date.parse('2025-03-14T06:58:43Z')
    for (const p of moonLimb(greatest)) expect(shadingAt(moon, p)).toBe(0)
    for (const p of moonLimb(greatest + 4 * 60 * MINUTE)) {
      expect(shadingAt(moon, p)).toBe(1)
    }
  })
})

describe('no eclipse', () => {
  test.each([
    ['new moon 2024-05-08', '2024-05-08T03:22:00Z'],
    ['full moon 2024-04-23', '2024-04-23T23:49:00Z'],
    ['quarter moon 2024-04-15', '2024-04-15T19:13:00Z'],
  ])('%s', (_, iso) => {
    const t = Date.parse(iso)
    for (let lat = -80; lat <= 80; lat += 20) {
      for (let lon = -180; lon < 180; lon += 30) {
        expect(sunVisibleAt(t, lat, lon)).toBe(1)
      }
    }
    for (const p of moonLimb(t)) expect(shadingAt(moon, p)).toBe(1)
  })
})

describe('shader patch', () => {
  test.each(['phong', 'lambert'] as const)('%s material compiles the shadow in', (name) => {
    const shadow = createEclipseShadow('moon')
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[name].uniforms),
      vertexShader: THREE.ShaderLib[name].vertexShader,
      fragmentShader: THREE.ShaderLib[name].fragmentShader,
    }
    shadow.material.onBeforeCompile(
      shader as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer
    )
    expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+\{\s+vec3 eclipseLocal/)
    expect(shader.fragmentShader).toMatch(
      /#include <lights_fragment_end>\s+if \(uEclipseActive/
    )

    shadow.update(Date.parse('2025-03-14T06:58:43Z'))
    expect(shader.uniforms.uEclipseActive.value).toBe(1)
    shadow.update(Date.parse('2024-04-15T19:13:00Z'))
    expect(shader.uniforms.uEclipseActive.value).toBe(0)
  })
})
