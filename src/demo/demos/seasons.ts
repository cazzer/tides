import type { Demo, DemoPose } from '../demo-script'

// Why there are seasons: a year of Earth's tilted axis at the 2026 equinoxes
// and solstices, then perihelion, 3 January 2027. The instants are
// astronomy-engine's, UTC: Seasons(2026) gives the March equinox at
// 14:45:42 on 20 March, the June solstice 08:25:06 on 21 June, the September
// equinox 00:05:45 on 23 September and the December solstice 20:50:29 on
// 21 December; SearchPlanetApsis(Body.Earth, 2026-12-25) perihelion at
// 02:07:49 on 3 January, 0.98336 AU. registry.test.ts checks these.
//
// aids.seasons draws Earth's axis, the subsolar dot and the readout
// latitude's ring (SeasonsGlobe.tsx) and the sunlight readout
// (SeasonsReadout.tsx) for the user's pin, or 45°N without one. Its sums are
// seasons.ts: the day's mean sunlight above the air
// Q = S0/(π r²)·(H0 sin φ sin δ + cos φ cos δ sin H0), the tilt's share against
// the equinox at 1 AU and the distance's against 1 AU. At 45°N: 309 W/m² at
// the March equinox, 484 at the June solstice (+63%), 120 at the December
// solstice (−62%), and perihelion's 3.4% more sunlight is +4 W/m².
//
// Every step plays one day at an hour a second, so the dot slides west once
// round the globe; no step sets a location, so the user's pin stands.

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Sun-relative, 45° round from the Sun's side and just above the ecliptic:
// the subsolar dot (which holds still on screen as the globe turns under it)
// sits well inside the lit face, and the axis's lean toward the Sun in June
// and away in December shows both across the screen and as the north pole
// tipping toward or away from the eye. Nearer the side view (azimuth 90) the
// lean would read more purely but the dot would sit on the limb.
const CAMERA: DemoPose = { focus: 'earth', azimuth: 45, elevation: 8, distance: 30 }

function day(date: string) {
  return { date, until: new Date(Date.parse(date) + DAY).toISOString(), timeScale: 3600, camera: CAMERA }
}

export const seasons: Demo = {
  id: 'seasons',
  title: 'The seasons',
  blurb: 'See why seasons come from Earth’s tilt, not its distance from the Sun, with the sunlight worked out for your latitude.',
  steps: [
    {
      ...day('2026-03-20T14:45:42Z'),
      layout: 'single',
      mainPanel: 'main',
      aids: { seasons: true },
      caption: {
        title: 'A tilted axis that holds still',
        body: 'Earth spins about a tilted axis (white line), 23.4° from upright, that points the same way in space all year. The yellow dot is where the Sun is overhead; the ring is the readout’s latitude.',
      },
    },
    {
      ...day('2026-06-21T08:25:06Z'),
      caption: {
        title: 'June solstice',
        body: 'The north pole leans toward the Sun and the dot reaches 23.4°N, its farthest north. North of the equator the noon Sun is highest and days longest; south of it, lowest and shortest.',
      },
    },
    {
      ...day('2026-09-23T00:05:45Z'),
      caption: {
        title: 'September equinox',
        body: 'Neither pole leans toward the Sun. The dot is back on the equator, the day–night line runs through both poles and every latitude gets about 12 hours of daylight.',
      },
    },
    {
      ...day('2026-12-21T20:50:29Z'),
      caption: {
        title: 'December solstice',
        body: 'The axis still points the same way, but Earth is across its orbit: now the south pole leans sunward and the dot is at 23.4°S. The south has the high Sun and long days, the north the low Sun.',
      },
    },
    {
      ...day('2027-01-03T02:07:49Z'),
      caption: {
        title: 'Nearest the Sun, in January',
        body: 'Earth is closest to the Sun around 3 January, getting 3.4% more sunlight than at 1 AU, in the northern winter. The readout compares it: outside the tropics the tilt moves a day’s energy far more.',
      },
    },
  ],
}
