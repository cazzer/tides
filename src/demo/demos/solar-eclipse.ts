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
// In steps 2 and 3 the View from Earth draws the Moon at the Sun's scale with
// a daylit sky (aids.solarEclipseSky, eclipse-sky.ts); step 5 adds the Moon's
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
      // From high over the shadow's side of the Sun line: the lit Moon, in
      // the ecliptic and sunward, drops out of the bottom of the frame while
      // the shadow (~16° west of the subsolar meridian) stays near centre.
      camera: { focus: 'earth', azimuth: -20, elevation: 40, distance: 20 },
      caption: {
        title: 'The Moon’s shadow reaches Earth',
        body: 'New moon, 8 April 2024: the Moon is between the Sun and Earth. Its shadow, drawn to scale, is the grey smudge on the Pacific west of Mexico: a faint penumbra around a dark umbra about 200 km wide.',
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
      aids: { solarEclipseSky: true },
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
        body: 'For over 4 minutes the Moon, just larger than the Sun, hides it completely. The sky goes dark, the brightest stars and planets come out and the corona, the Sun’s faint outer atmosphere, appears.',
      },
    },
    {
      date: '2024-04-08T18:40:00Z',
      until: '2024-04-08T19:55:27Z',
      timeScale: 120,
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 15, elevation: 18, distance: 12 },
      // Off again: the enlarged sky Moon sits inside the ground's bowl, so it
      // shows only while the Torreón steps hold it high.
      aids: { solarEclipseSky: false },
      caption: {
        title: 'The shadow races north-east',
        body: 'The umbra (the grey smudge; the orange pin marks Torreón) crosses Dallas at 18:40 UTC, then Arkansas, Ohio, New York and Maine, and leaves Earth off Newfoundland near 19:55 UTC.',
      },
    },
    {
      date: '2024-04-08T18:17:16Z',
      until: '2024-05-08T03:22:29Z',
      timeScale: 43200,
      // Edge on to the ecliptic, looking near the node line: the ecliptic
      // circle, Earth's orbit and the month labels collapse to one line, and
      // the Moon's orbit crosses it at its ~5° tilt.
      camera: { focus: 'earth', azimuth: -25, elevation: 0, distance: 55 },
      aids: { moonNodes: true },
      caption: {
        title: 'Why eclipses are rare',
        body: 'The Moon’s orbit (lilac ring) is tilted about 5° to Earth’s (faint white circle), so most new moons pass above or below the Sun. Only one near a node, where they cross (the gold line), casts a shadow on Earth.',
      },
    },
  ],
}
