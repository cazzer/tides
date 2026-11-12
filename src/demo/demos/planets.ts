import type { MoonKey } from '../../moons/moon-keys'
import type { MoonParent } from '../../moons/moons'
import type { Demo, DemoPose } from '../demo-script'

// Planets and moons (tides-ufyr.7): Mercury to Neptune, one stop each, the
// clock sped up so each planet's moons visibly go round.
//
// The stops run back to back: each starts where the last one stops, so the
// clock never jumps and nothing travels; only the eye flies from planet to
// planet (DemoPlayer's flight). Every stop has one speed, picked so the moon
// its caption names finishes its laps within the stop, after the flight
// (MOON_SHOWCASE, moon-laps.ts), and the fastest moon of the planet still
// takes MIN_LAP_FRAMES a lap, so nothing strobes. At these speeds, a lap of
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
// Mercury and Venus have no moons: their stops look against the stars,
// followed, from high over the planet's north, so the planet is seen to
// spin as it goes round the Sun (about the Sun the eye would turn with it,
// and Mercury's 176-day solar day would hardly move). They run at four days
// a second, at which Earth would spin four times a second and strobe; the
// poses keep it out of view (registry.test.ts).

const HIGH = { frame: 'stars', azimuth: 0, elevation: 60 } as const

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
      overlays: { showPlanets: true, systemAids: { orbits: true, labels: true } },
      aids: { moonSystems: true },
      caption: {
        title: 'Mercury: no moons',
        body: 'Closest to the Sun, no moons. It spins three times every two trips round the Sun.',
      },
    },
    {
      date: '2027-05-28T00:00:00Z',
      until: '2027-09-05T00:00:00Z',
      timeScale: 345_600,
      camera: VENUS,
      caption: {
        title: 'Venus spins backwards',
        body: 'No moons. Venus turns the opposite way to most planets, taking 243 days to turn once, longer than its 225-day year.',
      },
    },
    {
      date: '2027-09-05T00:00:00Z',
      until: '2027-09-08T00:00:00Z',
      timeScale: 10_800,
      camera: MARS,
      caption: {
        title: 'Mars’s two tiny moons',
        body: 'Phobos circles Mars in under 8 hours, faster than Mars spins. Deimos takes 30 hours.',
      },
    },
    {
      date: '2027-09-08T00:00:00Z',
      until: '2027-09-16T12:00:00Z',
      timeScale: 28_800,
      camera: JUPITER,
      caption: {
        title: 'Jupiter’s big four',
        body: 'In the time Ganymede circles Jupiter once, Europa goes round twice and Io four times.',
      },
    },
    {
      date: '2027-09-16T12:00:00Z',
      until: '2027-10-05T12:00:00Z',
      timeScale: 57_600,
      camera: SATURN,
      caption: {
        title: 'Saturn’s rings and Titan',
        body: 'The rings are ice and rock. Titan, the big orange moon, has thick hazy air and takes 16 days round.',
      },
    },
    {
      date: '2027-10-05T12:00:00Z',
      until: '2027-10-21T12:00:00Z',
      timeScale: 57_600,
      camera: URANUS,
      caption: {
        title: 'Uranus on its side',
        body: 'Uranus is tipped on its side, and its moons circle its tipped middle, so their paths stand on end.',
      },
    },
    {
      date: '2027-10-21T12:00:00Z',
      until: '2027-11-04T12:00:00Z',
      timeScale: 43_200,
      camera: NEPTUNE,
      caption: {
        title: 'Triton goes backwards',
        body: 'Neptune’s big moon Triton orbits the opposite way to Neptune’s spin, the only big moon that does.',
      },
    },
  ],
}
