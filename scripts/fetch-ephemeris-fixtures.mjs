// One-off: fetch reference ephemeris data for src/ephemeris.accuracy.test.ts.
// Run with `node scripts/fetch-ephemeris-fixtures.mjs`; the tests only read the
// JSON it writes, so they run offline.
//
// JPL Horizons, target Sun (10) from a site at 0°N 0°E on the geoid (parallax
// to the geocentre is under 9″):
//   2  apparent RA & Dec (Dec is the sub-solar latitude)
//   7  local apparent sidereal time, which at 0°E is GAST
//      (sub-solar longitude = RA − GAST)
//   31 apparent ecliptic-of-date longitude (the scene puts Earth at this angle)
// Horizons' own sub-solar quantity (15) isn't used: from the Earth's centre it
// is undefined, and from the Sun it is retarded by 8.3 min of light time.
//
// JPL Horizons, target Moon (301) from the geocentre (500@399):
//   10 illuminated fraction (%)
//   14 sub-observer (sub-Earth) longitude & latitude, i.e. libration
//   20 range (au)
//   24 Sun–Moon–Earth phase angle
//   31 apparent ecliptic-of-date longitude & latitude
//
// USNO AA rstt/oneday: sunrise and sunset in UTC (whole minutes, Sun's upper
// limb at the horizon with standard refraction, i.e. centre at −0.8333°).
import { writeFile, mkdir } from 'node:fs/promises'

const OUT_DIR = new URL('../src/__fixtures__/', import.meta.url)

const YEARS = [1950, 1975, 2000, 2026, 2050, 2075, 2100]
const DAYS = [
  [3, 20],
  [6, 21],
  [9, 23],
  [12, 21],
]
const HOURS = [0, 6, 12, 18]

const timestamps = []
YEARS.forEach((year, y) =>
  DAYS.forEach(([month, day], d) =>
    timestamps.push(Date.UTC(year, month - 1, day, HOURS[(y + d) % 4]))
  )
)
// The screenshot frames, plus two off-cardinal dates.
timestamps.push(
  Date.UTC(2026, 5, 21, 12),
  Date.UTC(2026, 8, 23, 12),
  Date.UTC(1987, 1, 14, 3, 30),
  Date.UTC(2033, 10, 2, 21, 15)
)
const unique = [...new Set(timestamps)].sort((a, b) => a - b)

// The same grid plus 2026 new and full moons (USNO), for the phase extremes.
const moonTimestamps = [
  ...new Set([
    ...timestamps,
    Date.UTC(2026, 0, 18, 19, 52), // new
    Date.UTC(2026, 2, 3, 11, 38), // full (total lunar eclipse)
    Date.UTC(2026, 7, 12, 17, 37), // new (total solar eclipse)
    Date.UTC(2026, 7, 28, 4, 18), // full
    Date.UTC(2026, 9, 10, 15, 50), // new
    Date.UTC(2026, 9, 3, 13, 25), // last quarter
    Date.UTC(2026, 9, 18, 16, 12), // first quarter
    Date.UTC(2026, 9, 26, 4, 12), // full
  ]),
].sort((a, b) => a - b)

const toJd = (ms) => ms / 86400000 + 2440587.5

// `columns` maps fixture keys to Horizons column-name prefixes.
async function fetchHorizons(query, columns, times) {
  const params = new URLSearchParams({
    format: 'json',
    EPHEM_TYPE: "'OBSERVER'",
    TIME_TYPE: "'UT'",
    ANG_FORMAT: "'DEG'",
    EXTRA_PREC: "'YES'",
    CSV_FORMAT: "'YES'",
    ...query,
    TLIST: times.map((t) => `'${toJd(t).toFixed(9)}'`).join(','),
  })
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`)
  if (!res.ok) throw new Error(`Horizons ${res.status}`)
  const { result } = await res.json()
  const [head, rest] = result.split('$$SOE')
  const body = rest?.split('$$EOE')[0]
  if (!body) throw new Error(`Horizons: no ephemeris\n${result}`)
  const header = head
    .split('\n')
    .findLast((line) => line.includes('Date__(UT)'))
    ?.split(',')
    .map((c) => c.trim())
  if (!header) throw new Error(`Horizons: no column header\n${result}`)
  const column = (prefix) => {
    const i = header.findIndex((name) => name.startsWith(prefix))
    if (i < 0) throw new Error(`Horizons: no ${prefix} column in ${header}`)
    return i
  }
  const COLS = Object.fromEntries(
    Object.entries(columns).map(([key, prefix]) => [key, column(prefix)])
  )
  const rows = body.trim().split('\n')
  if (rows.length !== times.length) {
    throw new Error(`Horizons: ${rows.length} rows for ${times.length} times`)
  }
  return rows.map((row, i) => {
    const cols = row.split(',').map((c) => c.trim())
    // Guards against TLIST being read in another time scale.
    if (cols[0] !== horizonsDate(times[i])) {
      throw new Error(`Horizons: row ${cols[0]} for ${new Date(times[i]).toISOString()}`)
    }
    const values = Object.fromEntries(
      Object.entries(COLS).map(([key, c]) => {
        const value = Number(cols[c])
        if (cols[c] === '' || !Number.isFinite(value)) {
          throw new Error(`Horizons: bad ${key} in ${row}`)
        }
        return [key, value]
      })
    )
    return { t: new Date(times[i]).toISOString(), horizonsDate: cols[0], ...values }
  })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Horizons' calendar format, e.g. 2026-Jun-21 12:00:00.000
function horizonsDate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${MONTHS[d.getUTCMonth()]}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000`
}

const PLACES = [
  { name: 'Seattle', lat: 47.61, lon: -122.33 },
  { name: 'Quito', lat: -0.18, lon: -78.47 },
  { name: 'Cape Town', lat: -33.92, lon: 18.42 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
]
const USNO_DATES = ['2000-03-20', '2026-06-21', '2026-09-23', '2026-12-21', '2050-06-21']

async function fetchUsno() {
  const events = []
  for (const place of PLACES) {
    for (const date of USNO_DATES) {
      const url = `https://aa.usno.navy.mil/api/rstt/oneday?date=${date}&coords=${place.lat},${place.lon}&tz=0`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`USNO ${res.status} ${url}`)
      const { properties } = await res.json()
      const riseSet = properties.data.sundata.filter(
        ({ phen }) => phen === 'Rise' || phen === 'Set'
      )
      if (riseSet.length !== 2 || riseSet[0].phen === riseSet[1].phen) {
        throw new Error(`USNO: expected one Rise and one Set from ${url}`)
      }
      for (const { phen, time } of riseSet) {
        if (!/^\d\d:\d\d$/.test(time)) {
          throw new Error(`USNO: bad time ${time} from ${url}`)
        }
        events.push({
          place: place.name,
          lat: place.lat,
          lon: place.lon,
          phen,
          t: `${date}T${time}:00Z`,
        })
      }
    }
  }
  return events
}

await mkdir(OUT_DIR, { recursive: true })
const fetchedAt = new Date().toISOString()
await writeFile(
  new URL('horizons-sun.json', OUT_DIR),
  JSON.stringify(
    {
      source: 'JPL Horizons API, COMMAND=10, CENTER=coord@399 SITE_COORD=0,0,0, QUANTITIES=2,7,31',
      fetchedAt,
      rows: await fetchHorizons(
        {
          COMMAND: "'10'",
          CENTER: "'coord@399'",
          COORD_TYPE: "'GEODETIC'",
          SITE_COORD: "'0,0,0'",
          QUANTITIES: "'2,7,31'",
        },
        {
          raDeg: 'R.A.',
          decDeg: 'DEC',
          gastHours: 'L_Ap_Sid_Time',
          eclipticLonDeg: 'ObsEcLon',
        },
        unique
      ),
    },
    null,
    2
  ) + '\n'
)
await writeFile(
  new URL('horizons-moon.json', OUT_DIR),
  JSON.stringify(
    {
      source: 'JPL Horizons API, COMMAND=301, CENTER=500@399, QUANTITIES=10,14,20,24,31',
      fetchedAt,
      rows: await fetchHorizons(
        { COMMAND: "'301'", CENTER: "'500@399'", QUANTITIES: "'10,14,20,24,31'" },
        {
          illuminatedPercent: 'Illu%',
          subEarthLonDeg: 'ObsSub-LON',
          subEarthLatDeg: 'ObsSub-LAT',
          rangeAu: 'delta',
          phaseAngleDeg: 'S-T-O',
          eclipticLonDeg: 'ObsEcLon',
          eclipticLatDeg: 'ObsEcLat',
        },
        moonTimestamps
      ),
    },
    null,
    2
  ) + '\n'
)
await writeFile(
  new URL('usno-sun-rise-set.json', OUT_DIR),
  JSON.stringify(
    {
      source: 'USNO AA API rstt/oneday, tz=0',
      fetchedAt,
      events: await fetchUsno(),
    },
    null,
    2
  ) + '\n'
)
console.log('wrote', OUT_DIR.pathname)
