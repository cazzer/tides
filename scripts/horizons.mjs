// JPL Horizons observer-table queries shared by the fixture scripts.

const toJd = (ms) => ms / 86400000 + 2440587.5

// `columns` maps fixture keys to Horizons column-name prefixes. Resolves to
// the rows plus Horizons' header text (target radii, longitude convention).
export async function queryHorizons(query, columns, times) {
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
  return {
    head,
    rows: rows.map((row, i) => {
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
    }),
  }
}

export async function fetchHorizons(query, columns, times) {
  return (await queryHorizons(query, columns, times)).rows
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Horizons' calendar format, e.g. 2026-Jun-21 12:00:00.000
function horizonsDate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${MONTHS[d.getUTCMonth()]}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000`
}
