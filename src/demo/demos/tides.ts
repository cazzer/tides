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
// (TidesReadout.tsx); the sums are tides.ts. Held steps stop the clock
// (timeScale 0); their `until`, a quarter of a lunar day on, only caps the
// clock if the user starts it. The daily step plays one lunar
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
        body: 'Violet arrows: the Moon’s pull less its pull on Earth’s centre; gold: the Sun’s; white: both together. The side toward the Moon (far below) is pulled out, the far side left behind, the sides pressed in.',
      },
    },
    {
      ...held('2026-10-10T15:50:36Z'),
      caption: {
        title: 'Spring tide',
        body: 'New Moon: Sun and Moon line up below the screen, so their pulls add. Blue caps: the sea heaped toward and away from them, ×1,000,000, on an ideal all-ocean Earth. Real coasts lag hours behind.',
      },
    },
    {
      date: '2026-10-10T15:50:36Z',
      until: '2026-10-11T16:40:36Z',
      timeScale: 3000,
      caption: {
        title: 'A day of tides',
        body: 'Follow the red dot (your pin, or a spot that starts under the Moon, at the bottom): Earth turns it under each blue cap (high) and past the sides (low), twice in 24 h 50 min. The land itself rises ~30 cm.',
      },
    },
    {
      ...held('2026-10-18T16:13:19Z'),
      camera: camera(90),
      caption: {
        title: 'Neap tide',
        body: 'First quarter: the Sun (gold disc, left) is square to the Moon (below). Its gold arrows press in where the Moon’s pull out, so the range falls to 0.41× and the blue caps all but vanish: neap tides.',
      },
    },
    {
      ...held('2026-12-24T01:28:45Z'),
      camera: camera(180),
      caption: {
        title: 'King tide',
        body: 'Christmas Eve’s Full Moon is 2026’s closest; the Sun (gold disc, top) lines up beyond Earth. The Moon pulls 25% harder: range 1.73×, against 1.43× in October. A king tide, metres on some coasts.',
      },
    },
  ],
}
