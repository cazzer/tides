import type { MoonKey } from '../../moons/moon-keys'
import type { MoonParent } from '../../moons/moons'
import type { Demo, DemoPose } from '../demo-script'

// Planets and moons (tides-ufyr.7): Mercury to Neptune, one stop each, the
// clock sped up so each planet's moons visibly go round.
//
// The stops run back to back: each starts where the last one stops, so the
// clock never jumps and nothing travels; only the eye flies from planet to
// planet (DemoPlayer's flight, demo-flight.ts), the new system spreading
// once it lands. Every stop has one speed, picked so the moon its caption
// names finishes its laps within the stop, after the flight, with
// MIN_LAP_SLACK_SECONDS to spare (MOON_SHOWCASE, moon-laps.ts), and the
// fastest moon of the planet still takes MIN_LAP_FRAMES a lap, so nothing
// strobes. At these speeds, a lap of
// (period / timeScale): Phobos 2.6 s and Deimos 10.1 s at 10 800; Io 5.3 s
// and Ganymede 21.5 s at 28 800; Mimas 1.4 s and Titan 23.9 s at 57 600;
// Miranda 2.1 s and Oberon 20.2 s at 57 600; Triton 11.8 s at 43 200. The
// planets' own spins are slower still to the eye: Saturn's, the quickest,
// a turn every 0.66 s.
//
// aids.moonSystems holds the focused planet's system all the way spread
// (expansionTarget's `spread`) however far out the fit puts the eye; each
// stop's fit keeps the outermost moon it frames (MOON_SHOWCASE.framed) in
// view at that spread, on a phone too. Iapetus, 79 days round, is left to
// run off the edge at Saturn: framing it would shrink Titan to a dot.
//
// Why 2027: the cap (moon-expansion.ts) lets every system spread all the
// way through these weeks. In 2026 Saturn's is held back by its conjunction
// with Neptune.
//
// The AU rings are off for the whole tour (exit puts the user's back): each
// stop is one planet's system, where a ring's label is a stray "2 AU" mid-view
// and says nothing about the planet (tides-ufyr.18). The focus title names
// each stop's planet, with its size.
//
// Mercury and Venus have no moons: their stops show the planet's turn. The
// eye is high over its north, beside the Sun's line and followed, so the
// Sun keeps its place on screen and the day–night line holds still: what
// moves is the planet turning against it, its day from sunrise to sunrise.
// Against the stars the line would sweep round once a year and read as the
// spin: at Venus prograde, though Venus turns backwards. Venus' day is 117
// days, so in this 100-day stop its clouds turn most of the way round,
// clockwise; Mercury's is 176 days, two of its years, so in this 88-day stop
// it turns half way round. They run at four days a second, at which Earth
// would spin four times a second and strobe; the poses keep it out of the
// whole view (registry.test.ts).

const HIGH = { followed: true, azimuth: 90, elevation: 60 } as const

const MERCURY: DemoPose = { focus: 'mercury', ...HIGH, distance: 40 }
const VENUS: DemoPose = { focus: 'venus', ...HIGH, distance: 60 }
const MARS: DemoPose = { focus: 'mars', azimuth: 30, elevation: 30, distance: 45, fit: 10.5 }
const JUPITER: DemoPose = { focus: 'jupiter', azimuth: 30, elevation: 25, distance: 300, fit: 78 }
const SATURN: DemoPose = { focus: 'saturn', azimuth: 20, elevation: 30, distance: 290, fit: 74 }
const URANUS: DemoPose = { focus: 'uranus', azimuth: 45, elevation: 15, distance: 250, fit: 64 }
const NEPTUNE: DemoPose = { focus: 'neptune', azimuth: 30, elevation: 30, distance: 150, fit: 31 }

/** What a moon stop shows: the moon its caption names (the slowest it
 * names) and how many laps of it the stop plays, and the outermost moon its
 * fit frames, spread. */
export interface MoonShowcase {
  named: MoonKey
  laps: number
  framed: MoonKey
}

export const MOON_SHOWCASE: Readonly<Record<MoonParent, MoonShowcase>> = {
  mars: { named: 'deimos', laps: 2, framed: 'deimos' },
  jupiter: { named: 'ganymede', laps: 1, framed: 'callisto' },
  saturn: { named: 'titan', laps: 1, framed: 'titan' },
  // Its caption names no moon: all five go round.
  uranus: { named: 'oberon', laps: 1, framed: 'oberon' },
  neptune: { named: 'triton', laps: 2, framed: 'triton' },
}

export const planets: Demo = {
  id: 'planets',
  title: 'Planets and moons',
  blurb: 'Visit each planet from Mercury to Neptune, with time sped up so you can watch their moons go round.',
  steps: [
    {
      date: '2027-03-01T00:00:00Z',
      until: '2027-05-28T00:00:00Z',
      timeScale: 345_600,
      camera: MERCURY,
      layout: 'single',
      mainPanel: 'main',
      overlays: { showPlanets: true, systemAids: { orbits: true, labels: true, grid: false } },
      aids: { moonSystems: true },
      caption: {
        title: 'Mercury: no moons',
        body: 'Watch a spot by the day–night line: Mercury turns so slowly that sunrise to sunrise takes two of its years.',
      },
    },
    {
      date: '2027-05-28T00:00:00Z',
      until: '2027-09-05T00:00:00Z',
      timeScale: 345_600,
      camera: VENUS,
      caption: {
        title: 'Venus spins backwards',
        body: 'No moons. Watch the dark markings: Venus turns clockwise seen from above, the opposite way to most planets.',
      },
    },
    {
      date: '2027-09-05T00:00:00Z',
      until: '2027-09-08T06:00:00Z',
      timeScale: 10_800,
      camera: MARS,
      caption: {
        title: 'Mars’s two tiny moons',
        body: 'Phobos circles Mars in under 8 hours, faster than Mars spins. Deimos takes 30 hours.',
      },
    },
    {
      date: '2027-09-08T06:00:00Z',
      until: '2027-09-17T00:00:00Z',
      timeScale: 28_800,
      camera: JUPITER,
      caption: {
        title: 'Jupiter’s big four',
        body: 'In the time Ganymede circles Jupiter once, Europa goes round twice and Io four times.',
      },
    },
    {
      date: '2027-09-17T00:00:00Z',
      until: '2027-10-06T00:00:00Z',
      timeScale: 57_600,
      camera: SATURN,
      caption: {
        title: 'Saturn’s rings and Titan',
        body: 'The rings are ice and rock. Titan, the big orange moon, has thick hazy air and takes 16 days round.',
      },
    },
    {
      date: '2027-10-06T00:00:00Z',
      until: '2027-10-23T00:00:00Z',
      timeScale: 57_600,
      camera: URANUS,
      caption: {
        title: 'Uranus on its side',
        body: 'Uranus is tipped on its side, and its moons circle around its tipped-over equator, so their paths stand on end.',
      },
    },
    {
      date: '2027-10-23T00:00:00Z',
      until: '2027-11-06T06:00:00Z',
      timeScale: 43_200,
      camera: NEPTUNE,
      caption: {
        title: 'Triton goes backwards',
        body: 'Neptune’s big moon Triton orbits the opposite way to Neptune’s spin, the only big moon that does.',
      },
    },
  ],
}
