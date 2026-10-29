import { describe, expect, it } from 'vitest'
import { circlePoints, lunarEclipseTrack, moonInShadow, shadowFrame, shadowRadii } from './earth-shadow'

const at = (hms: string) => Date.parse(`2026-03-03T${hms}Z`)
// Greatest eclipse in the app. astronomy-engine's own ΔT puts every contact
// 6.3 s earlier (08:44:02, 09:49:45, 11:03:58, 12:03:23, 13:17:35, 14:23:19,
// greatest 11:33:40); the app holds TT − UTC at its current value instead
// (delta-t.ts, loaded with the ephemeris).
const PEAK = at('11:33:46')

describe('earth shadow, 3 March 2026', () => {
  const eclipse = lunarEclipseTrack(PEAK)!

  it('is 2.68 Moon radii across the umbra and 4.75 the penumbra', () => {
    for (const t of [at('08:44:02'), PEAK, at('14:23:19')]) {
      const { umbra, penumbra } = shadowRadii(t)
      expect(Math.abs(umbra - 2.684)).toBeLessThan(0.01)
      expect(Math.abs(penumbra - 4.751)).toBeLessThan(0.01)
    }
  })

  it('finds the contacts astronomy-engine gives, to 2 s', () => {
    const { penumbral, partial, total } = eclipse.contacts
    const expected = ['08:44:08', '09:49:51', '11:04:04', '12:03:29', '13:17:41', '14:23:25'].map(at)
    const got = [penumbral[0], partial![0], total![0], total![1], partial![1], penumbral[1]]
    got.forEach((t, i) => expect(Math.abs(t - expected[i])).toBeLessThan(2000))
  })

  it('puts the Moon on each circle at its contacts', () => {
    const { penumbral, partial, total } = eclipse.contacts
    const { umbra, penumbra } = shadowRadii(PEAK)
    const dist = (t: number) => Math.hypot(...moonInShadow(t))
    // astronomy-engine's contacts come from its own shadow (Earth 6371 km plus
    // 88 km of air), 16 km wider than the drawn one (eclipse.ts' Danjon
    // radius), so at each the Moon sits ~0.01 radii, ~20 s, outside its circle.
    for (const t of penumbral) expect(Math.abs(dist(t) - (penumbra + 1) - 0.01)).toBeLessThan(0.005)
    for (const t of partial!) expect(Math.abs(dist(t) - (umbra + 1) - 0.01)).toBeLessThan(0.005)
    for (const t of total!) expect(Math.abs(dist(t) - (umbra - 1) - 0.01)).toBeLessThan(0.005)
  })

  it('runs the track east from penumbral contact to penumbral contact', () => {
    const { track, ticks } = eclipse
    const n = track.length / 3
    const [x0, y0] = moonInShadow(eclipse.contacts.penumbral[0])
    const [x1, y1] = moonInShadow(eclipse.contacts.penumbral[1])
    expect(track[0]).toBeCloseTo(x0, 5)
    expect(track[1]).toBeCloseTo(y0, 5)
    expect(track[(n - 1) * 3]).toBeCloseTo(x1, 5)
    expect(track[(n - 1) * 3 + 1]).toBeCloseTo(y1, 5)
    for (let i = 1; i < n; i++) expect(track[i * 3]).toBeGreaterThan(track[(i - 1) * 3])
    expect(ticks.length).toBe(4 * 3)
  })

  it('places the February and April full Moons well clear of the shadow', () => {
    const { penumbra } = shadowRadii(PEAK)
    expect(eclipse.ghosts).toHaveLength(2)
    const [before, after] = eclipse.ghosts
    expect(before[1]).toBeGreaterThan(0)
    expect(after[1]).toBeLessThan(0)
    for (const ghost of eclipse.ghosts) expect(Math.hypot(...ghost)).toBeGreaterThan(penumbra + 1)
  })

  it('finds the ghosts on the full Moons of 1 February and 2 April', () => {
    const feb = Date.parse('2026-02-01T22:09:00Z')
    const apr = Date.parse('2026-04-02T02:12:00Z')
    const [before, after] = eclipse.ghosts
    const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])
    // The Moon crosses the shadow at about two radii an hour, so 0.05 is
    // within about a minute and a half of each full Moon.
    expect(near(before, moonInShadow(feb))).toBeLessThan(0.05)
    expect(near(after, moonInShadow(apr))).toBeLessThan(0.05)
  })

  it('frames the shadow square to the Sun line, centred where the Moon is off it', () => {
    const frame = shadowFrame(PEAK)
    expect(frame.axis.dot(frame.north)).toBeCloseTo(0, 9)
    expect(frame.east.dot(frame.axis)).toBeCloseTo(0, 9)
    expect(frame.centre.dot(frame.axis)).toBeCloseTo(0, 6)
    const [x, y] = moonInShadow(PEAK)
    expect(frame.centre.dot(frame.east)).toBeCloseTo(-x, 6)
    expect(frame.centre.dot(frame.north)).toBeCloseTo(-y, 6)
  })

  it('has no eclipse a month either side', () => {
    expect(lunarEclipseTrack(Date.parse('2026-02-01T22:09:00Z'))).toBeNull()
    expect(lunarEclipseTrack(Date.parse('2026-04-02T02:12:00Z'))).toBeNull()
  })
})

describe('circlePoints', () => {
  it('closes a circle of the radius asked for', () => {
    const points = circlePoints(2, 8)
    expect(points.length).toBe(9 * 3)
    for (let i = 0; i < 9; i++) expect(Math.hypot(points[i * 3], points[i * 3 + 1])).toBeCloseTo(2, 6)
    expect(points[24]).toBeCloseTo(points[0], 6)
    expect(points[25]).toBeCloseTo(points[1], 6)
  })
})
