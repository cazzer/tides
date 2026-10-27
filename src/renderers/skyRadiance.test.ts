// The sky the sea mirrors (tides-07z): its shape, on the TypeScript mirror,
// and the GLSL taking the same constants.
import { describe, expect, it } from 'vitest'
import { ATMOSPHERE_DUSK, ATMOSPHERE_SKY } from './earth-shells'
import { SKY_DAY, SKY_DUSK_END, SKY_FLOOR, SKY_HORIZON, SKY_LEVEL, SKY_RADIANCE_GLSL, skyRadiance } from './skyRadiance'

type V = [number, number, number]
const UP: V = [0, 1, 0]
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
/** The Sun at elevation sine `s`, toward +x. */
const sunAt = (s: number): V => [Math.sqrt(1 - s * s), s, 0]
/** A ray at elevation `deg` toward azimuth `az` (radians from +x). */
const ray = (deg: number, az = 0): V => {
  const e = (deg * Math.PI) / 180
  return [Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)]
}

describe('the sky the sea mirrors (tides-07z)', () => {
  it('is dark once the Sun is SKY_DAY[0] under the horizon', () => {
    for (const s of [-1, -0.5, -0.2, -0.1]) {
      for (const dir of [UP, ray(10), ray(0, Math.PI)]) expect(skyRadiance(dir, UP, sunAt(s))).toEqual([0, 0, 0])
    }
  })

  it('brightens as the Sun climbs', () => {
    let last = -1
    for (const s of [-0.09, -0.05, 0, 0.05, 0.2, 0.5, 0.8, 1]) {
      const l = lum(skyRadiance(ray(30, Math.PI / 2), UP, sunAt(s)))
      expect(l).toBeGreaterThan(last)
      last = l
    }
  })

  it('is bluer at the zenith than at the horizon', () => {
    const sun = sunAt(0.7)
    const zenith = skyRadiance(UP, UP, sun)
    const horizon = skyRadiance(ray(0, Math.PI / 2), UP, sun)
    expect(zenith[2] / zenith[0]).toBeGreaterThan(horizon[2] / horizon[0])
    // and paler at the horizon, as the real sky.
    expect(lum(horizon)).toBeGreaterThan(lum(zenith))
  })

  it('warms toward the low Sun along the horizon', () => {
    const sun = sunAt(0.05)
    const sunward = skyRadiance(ray(2, 0), UP, sun)
    const away = skyRadiance(ray(2, Math.PI), UP, sun)
    expect(sunward[0] / sunward[2]).toBeGreaterThan(away[0] / away[2])
    // At noon the horizon has no dusk in it.
    const noon = skyRadiance(ray(0, Math.PI / 2), UP, UP)
    expect(noon[0] / noon[2]).toBeCloseTo(SKY_HORIZON[0] / SKY_HORIZON[2], 6)
  })

  it('looking up under an overhead Sun, is a modest share of its light', () => {
    // 5x the zenith's luminance: about the sky's share of a horizontal
    // surface's light against the Sun's under a clear sky.
    const l = 5 * lum(skyRadiance(UP, UP, UP))
    expect(l).toBeGreaterThan(0.15)
    expect(l).toBeLessThan(0.3)
  })

  it('writes its constants into the GLSL', () => {
    const f = (x: number) => x.toFixed(6)
    expect(SKY_RADIANCE_GLSL).toContain('vec3 skyRadiance(vec3 dir, vec3 up, vec3 sun)')
    expect(SKY_RADIANCE_GLSL).toContain(`smoothstep(${f(SKY_DAY[0])}, ${f(SKY_DAY[1])}, s)`)
    expect(SKY_RADIANCE_GLSL).toContain(`${f(SKY_LEVEL)} * day * (${f(SKY_FLOOR)} + ${f(1 - SKY_FLOOR)}`)
    expect(SKY_RADIANCE_GLSL).toContain(`smoothstep(0.0, ${f(SKY_DUSK_END)}, s)`)
    for (const c of [ATMOSPHERE_SKY, ATMOSPHERE_DUSK, SKY_HORIZON]) expect(SKY_RADIANCE_GLSL).toContain(`vec3(${c.map(f).join(', ')})`)
  })
})
