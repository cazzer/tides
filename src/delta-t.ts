// ΔT = TT − UT for astronomy-engine. The sim clock's timestamps are UTC, and
// since 1972 TT − UTC is exactly 32.184 s plus the leap seconds (TAI − UTC);
// UT1 stays within 0.9 s of UTC. astronomy-engine's default extrapolates
// Espenak–Meeus past 2005: 75.5 s instead of 69.2 s in 2026 and 203 s by
// 2100, which turns Jupiter 0.06° (1.3° by 2100) and puts the Moon 0.001°
// (0.02°) off JPL Horizons, which holds TT − UTC at its current value
// (tides-b5i). Before 1972, the default stands.
import { DeltaT_EspenakMeeus, SetDeltaTFunction } from 'astronomy-engine'

const MS_PER_DAY = 86_400_000
const J2000 = Date.UTC(2000, 0, 1, 12)

// [year, month (1-12), TAI − UTC from that month's first day]
const LEAP_SECONDS: readonly (readonly [number, number, number])[] = [
  [1972, 1, 10], [1972, 7, 11], [1973, 1, 12], [1974, 1, 13], [1975, 1, 14],
  [1976, 1, 15], [1977, 1, 16], [1978, 1, 17], [1979, 1, 18], [1980, 1, 19],
  [1981, 7, 20], [1982, 7, 21], [1983, 7, 22], [1985, 7, 23], [1988, 1, 24],
  [1990, 1, 25], [1991, 1, 26], [1992, 7, 27], [1993, 7, 28], [1994, 7, 29],
  [1996, 1, 30], [1997, 7, 31], [1999, 1, 32], [2006, 1, 33], [2009, 1, 34],
  [2012, 7, 35], [2015, 7, 36], [2017, 1, 37],
]
const STEPS = LEAP_SECONDS.map(([year, month, seconds]) => ({
  ut: (Date.UTC(year, month - 1, 1) - J2000) / MS_PER_DAY,
  seconds,
}))

/** TT − UT in seconds at `ut` days from J2000. */
export function deltaT(ut: number): number {
  if (ut < STEPS[0].ut) return DeltaT_EspenakMeeus(ut)
  let i = STEPS.length - 1
  while (STEPS[i].ut > ut) i--
  return 32.184 + STEPS[i].seconds
}

SetDeltaTFunction(deltaT)
