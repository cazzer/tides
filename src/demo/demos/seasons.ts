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

// Sun-relative, from nearly side on (azimuth 90 is square to the Sun line),
// so the Sun's light comes from the left: at the solstices the axis leans
// ~23° toward or away from the lit side, at the equinoxes it stands near
// upright along the day-night line. The subsolar dot, which holds still on
// screen as the globe turns under it, sits just inside the lit limb.
const CAMERA: DemoPose = { focus: 'earth', azimuth: 75, elevation: 10, distance: 30 }

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
        title: 'Earth’s tilted axis',
        body: 'Earth spins on an axis (white line) tilted 23.4°, aimed the same way in space all year. Sunlight comes from the left. The yellow dot is where the Sun is straight overhead; the blue ring is the panel’s latitude.',
      },
    },
    {
      ...day('2026-06-21T08:25:06Z'),
      caption: {
        title: 'June solstice',
        body: 'The north pole leans toward the Sun; the dot reaches 23.4°N. The north’s high noon Sun shines steeply through little air; the south’s low Sun spreads its light thin through more air, so less reaches the ground.',
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
        body: 'Half an orbit on, the axis aims the same way, so the south pole leans sunward and the dot is at 23.4°S. The south gets the high Sun and long days; the north a low Sun, short days and light dimmed by more air.',
      },
    },
    {
      ...day('2027-01-03T02:07:49Z'),
      caption: {
        title: 'Nearest the Sun, in January',
        body: 'Earth is nearest the Sun around 3 January, in the northern winter, and gets 3.4% more sunlight than at its average distance. Compare the panel’s last two lines: the tilt changes a day’s sunlight far more.',
      },
    },
  ],
}
