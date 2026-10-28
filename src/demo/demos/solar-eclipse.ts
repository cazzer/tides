import type { Demo } from '../demo-script'

// The total solar eclipse of 8 April 2024, seen from Torreón, Mexico (25.54 N,
// 103.41 W). Its contacts are astronomy-engine's (SearchLocalSolarEclipse),
// UTC: partial from 17:00:03, totality 18:17:01-18:21:13 (4 min 12 s),
// greatest 18:19:07 with the Sun 70.1° up at azimuth 152.8, partial ends
// 19:41:32. Globally (NASA): the umbra meets Earth at 16:38:48, greatest
// eclipse 18:17:16, the umbra leaves 19:55:27. registry.test.ts checks these.
//
// Torreón rather than Dallas: ~30 km from greatest eclipse, totality 4 min
// 12 s against Dallas' 3 min 58 s, and the Sun 70° up (64.6° in Dallas, due
// south), so it stands clear of the hills. Dallas is in step 4's caption.
//
// From step 1 on the View from Earth draws the Moon at the Sun's scale with a
// daylit sky (aids.solarEclipseSky, eclipse-sky.ts); step 5 adds the Moon's
// tilted orbit and node line (aids.moonNodes).
export const solarEclipse: Demo = {
  id: 'solar-eclipse',
  title: 'Total solar eclipse',
  blurb: 'Follow the Moon’s shadow across North America and stand in totality, 8 April 2024.',
  steps: [
    {
      date: '2024-04-08T17:55:00Z',
      until: '2024-04-08T18:17:16Z',
      timeScale: 60,
      layout: 'single',
      mainPanel: 'main',
      // The shadow falls ~16° west of the subsolar meridian: the eye turns
      // that way, off the Sun line, so the Moon doesn't hide it.
      camera: { focus: 'earth', azimuth: -25, elevation: 18, distance: 20 },
      aids: { solarEclipseSky: true },
      caption: {
        title: 'The Moon’s shadow reaches Earth',
        body: 'New moon, 8 April 2024. The Moon passes between the Sun and Earth and its shadow falls on the Pacific: a wide, pale penumbra and, at its heart, the dark umbra, about 200 km across.',
      },
    },
    {
      date: '2024-04-08T17:50:00Z',
      until: '2024-04-08T18:17:01Z',
      timeScale: 60,
      mainPanel: 'top',
      location: { lat: 25.54, lon: -103.41 },
      skyLook: { azimuth: 140, altitude: 40 },
      skyFov: null,
      caption: {
        title: 'Partial eclipse from Torreón',
        body: 'Over Torreón, Mexico, the Moon covers more of the Sun each minute and the sky dims. Both are drawn larger than life, at their true size ratio. Totality starts at 18:17 UTC.',
      },
    },
    {
      date: '2024-04-08T18:17:30Z',
      until: '2024-04-08T18:21:10Z',
      timeScale: 2,
      skyLook: { azimuth: 152.5, altitude: 70 },
      skyFov: 70,
      caption: {
        title: 'Totality',
        body: 'For over 4 minutes the Moon, just larger than the Sun, hides it completely. The sky goes dark, stars come out and the corona, the Sun’s faint outer atmosphere, appears.',
      },
    },
    {
      date: '2024-04-08T18:40:00Z',
      until: '2024-04-08T19:55:27Z',
      timeScale: 120,
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 10, elevation: 30, distance: 8 },
      caption: {
        title: 'The shadow races north-east',
        body: 'The umbra sweeps over Texas around 18:40 UTC, then Arkansas, Ohio, New York and Maine, and leaves Earth off Newfoundland near 19:55 UTC.',
      },
    },
    {
      date: '2024-04-08T18:17:16Z',
      until: '2024-05-08T03:22:29Z',
      timeScale: 43200,
      camera: { focus: 'earth', azimuth: 60, elevation: 4, distance: 70 },
      aids: { moonNodes: true },
      caption: {
        title: 'Why eclipses are rare',
        body: 'The Moon’s orbit is tilted about 5° to Earth’s. Most months the new Moon passes above or below the Sun. Only a new moon near a node, where the orbits cross (the gold line), puts its shadow on Earth.',
      },
    },
  ],
}
