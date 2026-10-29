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
// south), so it stands clear of the hills.
//
// In steps 2 and 3 the View from Earth draws the Moon at the Sun's scale with
// a daylit sky (aids.solarEclipseSky, eclipse-sky.ts); step 5 adds the Moon's
// tilted orbit and node line (aids.moonNodes). In steps 1 and 4 the main view
// darkens and rings the shadow on Earth (aids.moonShadow, MoonShadowGlobe.tsx),
// which at true scale is a faint smudge, and leaves the path of totality
// behind it (aids.totalityPath, totality-path.ts); step 5 turns both off.
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
      // From the Sun's side and a little below the ecliptic, so the sunward
      // Moon stands just over Earth's top limb, above its own shadow, on a
      // phone as well as on desktop. It is seen full: the side facing us is lit.
      camera: { focus: 'earth', azimuth: -10, elevation: -22, distance: 40 },
      aids: { moonShadow: true, totalityPath: true },
      caption: {
        title: 'Shadow reaches Mexico',
        body: 'Seen from the Sun’s side, past the Moon: total eclipse in the dark dot, partial inside the ring.',
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
        body: 'The Moon slides over the Sun; the sky dims. Both drawn larger, true to each other.',
      },
    },
    {
      date: '2024-04-08T18:17:30Z',
      until: '2024-04-08T18:21:30Z',
      timeScale: 2,
      skyLook: { azimuth: 152.5, altitude: 70 },
      skyFov: 70,
      caption: {
        title: 'Totality',
        body: 'For 4 minutes the Moon just covers the Sun. Stars come out; the corona appears.',
      },
    },
    {
      date: '2024-04-08T18:40:00Z',
      until: '2024-04-08T19:55:27Z',
      timeScale: 120,
      mainPanel: 'main',
      // As step 1, turned east with the shadow.
      camera: { focus: 'earth', azimuth: 5, elevation: -22, distance: 40 },
      // Off again: the enlarged sky Moon sits inside the ground's bowl, so it
      // shows only while the Torreón steps hold it high.
      aids: { solarEclipseSky: false },
      caption: {
        title: 'The shadow sweeps north-east',
        body: 'The Moon carries its shadow east, faster than Earth turns. The dark band behind it is the path of totality.',
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
      aids: { moonNodes: true, moonShadow: false, totalityPath: false },
      caption: {
        title: 'Why not every month?',
        body: 'The Moon’s orbit (lilac) tilts 5°, so most new moons miss the Sun. Eclipses need a node (gold).',
      },
    },
  ],
}
