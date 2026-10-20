// One-off: fetch the JPL Horizons reference data for src/orbit-accuracy.test.ts
// (the tides-b5i report, reports/orbit-accuracy.md). Run with
// `node scripts/fetch-orbitcheck-fixtures.mjs`; the test only reads the JSON.
//
// Sun (10) from the geocentre (500@399):
//   2  apparent RA & Dec (Dec is the sub-solar latitude)
//   20 range (the Earth's heliocentric distance)
//   31 apparent ecliptic-of-date longitude & latitude
// and from a site at 0°N 0°E: 7, local apparent sidereal time = GAST.
//
// Sun, Moon and planets from the geocentre:
//   14 sub-Earth planetodetic longitude & latitude (orientation, libration)
//   17 north-pole position angle from true-of-date celestial north
//   20 range, 21 one-way light time, 31 apparent ecliptic lon & lat
// and for the planets
//   18 geometric heliocentric J2000 ecliptic lon & lat, 19 heliocentric range,
//      both when the light seen at the geocentre left the planet
// (from 500@10 Horizons gives ICRF/J2000 directions even for "of date"
// quantities, so the of-date heliocentric direction is precessed in the test).
// Planets from the Sun's centre (500@10): 14 (the sub-solar point) and 21.
//
// Each body's longitude convention (east or west positive) and radii come
// from the Horizons header.
import { writeFile } from 'node:fs/promises'
import { queryHorizons } from './horizons.mjs'

const OUT = new URL('../src/__fixtures__/horizons-orbitcheck.json', import.meta.url)

// Equinoxes, solstices, perihelion and the lunar node from astronomy-engine's
// Seasons, SearchPlanetApsis and SearchMoonNode, to the minute.
const EPOCHS = [
  ['1900', Date.UTC(1900, 0, 1, 12)],
  ['1950', Date.UTC(1950, 6, 1, 0)],
  ['J2000', Date.UTC(2000, 0, 1, 12)],
  ['2026 perihelion', Date.UTC(2026, 0, 3, 16, 42)],
  ['2026 Mar equinox', Date.UTC(2026, 2, 20, 14, 46)],
  ['2026 Jun solstice', Date.UTC(2026, 5, 21, 8, 25)],
  ['2026 Sep equinox', Date.UTC(2026, 8, 23, 0, 6)],
  ['2026 lunar node', Date.UTC(2026, 9, 7, 1, 19)],
  ['2026-10-20', Date.UTC(2026, 9, 20, 0)],
  ['2026 Dec solstice', Date.UTC(2026, 11, 21, 20, 50)],
  ['2050', Date.UTC(2050, 6, 1, 0)],
  ['2100', Date.UTC(2100, 0, 1, 12)],
]
const times = EPOCHS.map(([, t]) => t)

const BODIES = {
  sun: '10',
  moon: '301',
  mercury: '199',
  venus: '299',
  mars: '499',
  jupiter: '599',
  saturn: '699',
  uranus: '799',
  neptune: '899',
}

const GEO = {
  subLonDeg: 'ObsSub-LON',
  subLatDeg: 'ObsSub-LAT',
  northPoleAngleDeg: 'NP.ang',
  rangeAu: 'delta',
  lightTimeMin: '1-way_down_LT',
  eclipticLonDeg: 'ObsEcLon',
  eclipticLatDeg: 'ObsEcLat',
}

function targetFrame(head) {
  const pole = head.match(/Target pole\/equ\s*:\s*(\S+)\s*\{(East|West)-longitude positive\}/)
  const radii = head.match(/Target radii\s*:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+) km/)
  if (!pole || !radii) throw new Error(`Horizons: no target frame in\n${head}`)
  return {
    frame: pole[1],
    longitude: pole[2].toLowerCase(),
    radiiKm: radii.slice(1).map(Number),
  }
}

const HELIO = {
  helioLonJ2000Deg: 'hEcl-Lon',
  helioLatJ2000Deg: 'hEcl-Lat',
  helioRangeAu: 'r',
}

const earth = (
  await queryHorizons(
    { COMMAND: "'10'", CENTER: "'500@399'", QUANTITIES: "'2,20,31'" },
    {
      raDeg: 'R.A.',
      decDeg: 'DEC',
      sunRangeAu: 'delta',
      sunEclipticLonDeg: 'ObsEcLon',
      sunEclipticLatDeg: 'ObsEcLat',
    },
    times
  )
).rows
const sidereal = (
  await queryHorizons(
    {
      COMMAND: "'10'",
      CENTER: "'coord@399'",
      COORD_TYPE: "'GEODETIC'",
      SITE_COORD: "'0,0,0'",
      QUANTITIES: "'7'",
    },
    { gastHours: 'L_Ap_Sid_Time' },
    times
  )
).rows
earth.forEach((row, i) => (row.gastHours = sidereal[i].gastHours))

const bodies = {}
for (const [key, command] of Object.entries(BODIES)) {
  const planet = key !== 'sun' && key !== 'moon'
  const geo = await queryHorizons(
    {
      COMMAND: `'${command}'`,
      CENTER: "'500@399'",
      QUANTITIES: planet ? "'14,17,18,19,20,21,31'" : "'14,17,20,21,31'",
    },
    planet ? { ...GEO, ...HELIO } : GEO,
    times
  )
  bodies[key] = { command, ...targetFrame(geo.head), geocentric: geo.rows }
  if (!planet) continue
  bodies[key].fromSun = (
    await queryHorizons(
      { COMMAND: `'${command}'`, CENTER: "'500@10'", QUANTITIES: "'14,21'" },
      { subLonDeg: 'ObsSub-LON', subLatDeg: 'ObsSub-LAT', lightTimeMin: '1-way_down_LT' },
      times
    )
  ).rows
}

await writeFile(
  OUT,
  JSON.stringify(
    {
      source: 'JPL Horizons API (scripts/fetch-orbitcheck-fixtures.mjs)',
      fetchedAt: new Date().toISOString(),
      epochs: EPOCHS.map(([label, t]) => ({ label, t: new Date(t).toISOString() })),
      earth,
      bodies,
    },
    null,
    2
  ) + '\n'
)
console.log('wrote', OUT.pathname)
