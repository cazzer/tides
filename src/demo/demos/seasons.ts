import type { Demo, DemoPose, DemoTravel } from '../demo-script'

// Why there are seasons: a year of Earth's tilted axis at the 2026 equinoxes
// and solstices, then perihelion, 3 January 2027. The instants are
// astronomy-engine's, UTC: Seasons(2026) gives the March equinox at
// 14:45:42 on 20 March, the June solstice 08:25:06 on 21 June, the September
// equinox 00:05:45 on 23 September and the December solstice 20:50:29 on
// 21 December; SearchPlanetApsis(Body.Earth, 2026-12-25) perihelion at
// 02:07:49 on 3 January, 0.98333 AU. registry.test.ts checks these.
//
// aids.seasons draws Earth's axis, bold and arrowed north, and in the wide
// view between stops a faint pale dot and axis left at each stop reached
// (four parallel axes by the December leg) and the orbit's nearest and
// farthest points with their distances (SeasonsOrbit.tsx); the subsolar dot
// and the readout latitude's ring (SeasonsGlobe.tsx); and the sunlight
// readout (SeasonsReadout.tsx) for the user's pin, or 45°N without one. Its
// sums are seasons.ts: the day's mean sunlight above the air
// Q = S0/(π r²)·(H0 sin φ sin δ + cos φ cos δ sin H0), the tilt's share against
// the equinox at 1 AU and the distance's against 1 AU. At 45°N: 309 W/m² at
// the March equinox, 484 at the June solstice (+63%), 120 at the December
// solstice (−62%), and perihelion's 3.4% more sunlight is +4 W/m².
//
// Every step plays one day at an hour a second, so the dot slides west once
// round the globe; no step sets a location, so the user's pin stands. The
// Moon is hidden throughout (aids.hideMoon): it is not part of the story.

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Against the stars, from 45° above the ecliptic on the scene's -X side,
// looking along the equinox line: the axis, which leans toward +Z, keeps one
// on-screen direction at every stop, and at the solstices the Sun is beside
// Earth. The close-up looks at the globe; on the way between stops the eye
// backs out (WIDE) to show the Sun, the orbit and Earth, far enough on a
// narrow screen to keep 60 units (Earth's orbit is 50) about Earth in view.
const CLOSE: DemoPose = { focus: 'earth', frame: 'stars', azimuth: 0, elevation: 45, distance: 30 }
const WIDE: Omit<DemoPose, 'focus'> = { frame: 'stars', azimuth: 0, elevation: 45, distance: 170, fit: 60 }

const SEPTEMBER_DISTANCE = 80

function day(date: string) {
  return { date, until: new Date(Date.parse(date) + DAY).toISOString(), timeScale: 3600, camera: CLOSE }
}

// Earth's spin and the Moon are held on the way, so the globe doesn't strobe.
const travel = (seconds: number): DemoTravel => ({ seconds, hold: ['spin', 'moon'], camera: WIDE })

export const seasons: Demo = {
  id: 'seasons',
  title: 'The seasons',
  blurb: 'See why seasons come from Earth’s tilt, not its distance from the Sun, with the sunlight worked out for your latitude.',
  steps: [
    {
      ...day('2026-03-20T14:45:42Z'),
      layout: 'single',
      mainPanel: 'main',
      aids: { seasons: true, hideMoon: true },
      caption: {
        title: 'Earth’s tilted axis',
        body: 'Earth’s axis (white) tilts 23° and always points the same way in space. Watch it as Earth circles the Sun.',
      },
    },
    {
      ...day('2026-06-21T08:25:06Z'),
      travel: travel(6),
      caption: {
        title: 'June solstice',
        body: 'The north tips toward the Sun: high Sun, long days, summer. The south gets winter.',
      },
    },
    {
      ...day('2026-09-23T00:05:45Z'),
      // Further out, the same way: the Sun is behind Earth from here, so its
      // edge and the lit limb come into frame past the night side.
      camera: { ...CLOSE, distance: SEPTEMBER_DISTANCE },
      travel: travel(6),
      caption: {
        title: 'September equinox',
        body: 'Neither pole tips toward the Sun. Day and night are about equal nearly everywhere.',
      },
    },
    {
      ...day('2026-12-21T20:50:29Z'),
      travel: travel(6),
      caption: {
        title: 'December solstice',
        body: 'Same axis, other side: now the south tips sunward. The north’s low Sun spreads thin over short days.',
      },
    },
    {
      ...day('2027-01-03T02:07:49Z'),
      travel: travel(3),
      caption: {
        title: 'Closest in January',
        body: 'Earth is closest to the Sun in northern winter. For most places, distance barely matters; tilt does.',
      },
    },
  ],
}
