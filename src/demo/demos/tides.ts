import type { Demo, DemoPose } from '../demo-script'

// What raises the tides: the Moon's and the Sun's tidal pull on Earth at
// three real moments of 2026, astronomy-engine's (UTC):
// - New Moon, 10 October 15:50:36, the Moon 387,631 km away: its pull 0.975×
//   its mean-distance value, the Sun's 0.461×, lined up for 1.434×.
// - First quarter, 18 October 16:13:19, 402,738 km: Moon 0.870×, Sun 0.464×,
//   square to each other, so only 0.405× is left.
// - Full Moon, 24 December 01:28:45, 356,729 km, 2026's nearest Full Moon
//   (perigee 356,641 km at 08:32): Moon 1.251×, Sun 0.483×, 1.731× together.
// SearchMoonQuarter and SearchLunarApsis give these to within seconds;
// registry.test.ts checks them.
//
// aids.tides draws the arrows and the sea's equilibrium shape (TidesField.tsx,
// heights ×TIDE_EXAGGERATION), the marked spot (TidesSpot.tsx) and the readout
// (TidesReadout.tsx); the sums are tides.ts. The first step shows the Moon's
// pull alone; aids.tidesSun adds the Sun's from the second, so the two pulls
// add on screen. Held steps stop the clock
// (timeScale 0); their `until`, a quarter of a lunar day on, only caps the
// clock if the user starts it. The daily step plays one lunar
// day, 24 h 50 min, at 3000×, about 30 s. At the spot under the Moon on the
// equator the equilibrium tide starts at +49 cm, falls to −25 cm at ~6 h 15,
// is back to +47 cm at ~12 h 25 and low again at ~18 h 25.
//
// No step sets a location, so the user's pin, when there is one, is the spot.

const MINUTE = 60_000
const HELD = 6 * 60 * MINUTE + 12 * MINUTE

// From above the Moon's orbit plane, on the side away from the Moon, so the
// real Moon sits above Earth on screen, clear of the caption below; low
// enough that on a phone it also clears the readout at the top. Azimuth is
// Sun-relative, so the Moon's own azimuth (0 at New Moon, 90 at first
// quarter, 180 at Full Moon) plus 180.
function camera(moonAzimuth: number): DemoPose {
  return { focus: 'earth', azimuth: (moonAzimuth + 180) % 360, elevation: 60, distance: 45 }
}

function held(date: string) {
  return { date, until: new Date(Date.parse(date) + HELD).toISOString(), timeScale: 0 }
}

export const tides: Demo = {
  id: 'tides',
  title: 'The tides',
  blurb: 'See how the Moon and the Sun stretch Earth’s seas into two bulges, and why spring, neap and king tides differ.',
  steps: [
    {
      ...held('2026-10-10T15:50:36Z'),
      camera: camera(0),
      layout: 'single',
      mainPanel: 'main',
      aids: { tides: true },
      caption: {
        title: 'Why two bulges',
        body: 'The Moon (top) pulls the near side hardest and the far side least. The arrows sweep the sea into two bulges.',
      },
    },
    {
      ...held('2026-10-10T15:50:36Z'),
      aids: { tidesSun: true },
      caption: {
        title: 'Spring tide',
        body: 'New Moon: Sun and Moon in line, so their stretches add: big ‘spring’ tides (nothing to do with springtime).',
      },
    },
    {
      date: '2026-10-10T15:50:36Z',
      until: '2026-10-11T16:40:36Z',
      timeScale: 3000,
      caption: {
        title: 'A day of tides',
        body: 'Earth turns the red dot under both bulges: two highs and two lows every 24 h 50 min.',
      },
    },
    {
      ...held('2026-10-18T16:13:19Z'),
      camera: camera(90),
      caption: {
        title: 'Neap tide',
        body: 'Quarter Moon: the Sun pulls across the Moon’s line, so the stretches partly cancel. Range under a third of spring’s.',
      },
    },
    {
      ...held('2026-12-24T01:28:45Z'),
      camera: camera(180),
      caption: {
        title: 'King tide',
        body: 'Full Moon at its closest, lined up with the Sun: tidal pull 25% up. A perigean spring, or ‘king’, tide.',
      },
    },
  ],
}
