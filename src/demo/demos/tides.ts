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
// heights ×1,000,000), the marked spot (TidesSpot.tsx) and the readout
// (TidesReadout.tsx); the sums are tides.ts. Held steps keep the clock still
// (timeScale 0) for a quarter of a lunar day; the daily step plays one lunar
// day, 24 h 50 min, at 3000×, about 30 s. At the spot under the Moon on the
// equator the equilibrium tide starts at +49 cm, falls to −25 cm at ~6 h 15,
// is back to +47 cm at ~12 h 25 and low again at ~18 h 25.
//
// No step sets a location, so the user's pin, when there is one, is the spot.

const MINUTE = 60_000
const HELD = 6 * 60 * MINUTE + 12 * MINUTE

// From nearly overhead (looking down on the Moon's orbit plane), on the
// Moon's side: azimuth is Sun-relative, so 0 is the New Moon's direction, 90
// first quarter's and 180 the Full Moon's. The Moon then lies beyond the
// bottom edge of the screen, its arrows pointing down to it and up away.
function camera(azimuth: number): DemoPose {
  return { focus: 'earth', azimuth, elevation: 80, distance: 31 }
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
        body: 'Violet arrows: the Moon’s pull minus its pull on Earth’s centre. The Moon is far below the screen (violet disc). The near side is pulled more, the far side less, so the sea heaps up both ways.',
      },
    },
    {
      ...held('2026-10-10T15:50:36Z'),
      caption: {
        title: 'Spring tide',
        body: 'New Moon: the Sun lines up with the Moon, both below the screen, so the gold arrows add to the violet. The bold white arrows are the sum; the blue shell is the sea’s shape, its height ×1,000,000.',
      },
    },
    {
      date: '2026-10-10T15:50:36Z',
      until: '2026-10-11T16:40:36Z',
      timeScale: 3000,
      caption: {
        title: 'A day of tides',
        body: 'Earth turns under the bulges. The red dot (your pin, or a spot on the equator) passes two highs and two lows in 24 h 50 min. Real coasts lag this by hours; even the land rises ~30 cm.',
      },
    },
    {
      ...held('2026-10-18T16:13:19Z'),
      camera: camera(90),
      caption: {
        title: 'Neap tide',
        body: 'First quarter: the Sun (gold disc) is off to the side, square to the Moon. Its gold arrows squeeze where the Moon’s stretch, so the white sum shrinks and the shell is barely oval: small, neap tides.',
      },
    },
    {
      ...held('2026-12-24T01:28:45Z'),
      camera: camera(180),
      caption: {
        title: 'King tide',
        body: 'Christmas Eve’s Full Moon is 2026’s closest, 356,729 km, with the Sun lined up beyond Earth. The Moon pulls 25% harder than average: together, the year’s biggest tides.',
      },
    },
  ],
}
