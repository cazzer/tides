import type { Demo } from '../demo-script'

// The total lunar eclipse of 3 March 2026. Contact times are astronomy-engine's
// (SearchLunarEclipse) under the app's ΔT (delta-t.ts), UTC: penumbra from
// 08:44:08, umbra 09:49:51, totality 11:04:04-12:03:29, greatest 11:33:46,
// umbra left 13:17:41, penumbra left 14:23:25 (each 6 s later than under
// astronomy-engine's default ΔT). Time only runs forward: each step starts at or after the
// last one's `until`, and `until` keeps Play within what its caption describes.
//
// Step 4's skyLook is the Moon's place in Honolulu's sky at greatest eclipse,
// from astronomy-engine's Horizon (refracted): altitude 70.3, azimuth 221.5.
// registry.test.ts checks it still is.
export const lunarEclipse: Demo = {
  id: 'lunar-eclipse',
  title: 'Total lunar eclipse',
  blurb: 'Watch the Moon pass through Earth’s shadow and turn copper, 3 March 2026.',
  steps: [
    {
      date: '2026-03-03T08:30:00Z',
      until: '2026-03-03T09:40:00Z',
      timeScale: 0,
      layout: 'single',
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 20, elevation: 25, distance: 170 },
      aids: { earthShadow: true },
      caption: {
        title: 'Sun, Earth, Moon in a line',
        body: 'Full Moon, almost exactly behind Earth. Earth’s shadow points at it.',
      },
    },
    {
      date: '2026-03-03T09:40:00Z',
      until: '2026-03-03T11:04:04Z',
      timeScale: 300,
      camera: { focus: 'moon', azimuth: 21, elevation: 6, distance: 23 },
      caption: {
        title: 'Into the shadow',
        body: 'The Moon’s own orbit carries it into Earth’s shadow: a faint outer part, then the dark core.',
      },
    },
    {
      date: '2026-03-03T11:04:04Z',
      until: '2026-03-03T11:33:46Z',
      timeScale: 60,
      camera: { focus: 'moon', azimuth: 10, elevation: 3, distance: 5 },
      aids: { earthShadow: false },
      caption: {
        title: 'Why copper?',
        body: 'No direct sunlight now. Only light bent through Earth’s air: every sunrise and sunset at once.',
      },
    },
    {
      date: '2026-03-03T11:33:46Z',
      until: '2026-03-03T12:03:29Z',
      timeScale: 0,
      mainPanel: 'top',
      location: { lat: 21.31, lon: -157.86 },
      skyLook: { azimuth: 221.5, altitude: 70.3 },
      // All the way in (SKY_FOV_MIN): the sky Moon is drawn 8× its true size
      // (eclipse-sky.ts' SKY_SCALE), ~4° across, so this is what lets the
      // copper Moon read on a phone.
      skyFov: 20,
      caption: {
        title: 'From Honolulu, 1:33 am',
        body: 'High in the south-west. All of Earth’s night side sees it now. (Moon enlarged)',
      },
    },
    {
      date: '2026-03-03T12:03:29Z',
      until: '2026-03-03T14:23:25Z',
      timeScale: 300,
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 20, elevation: 25, distance: 170 },
      aids: { earthShadow: true, fullMoonGhosts: true },
      caption: {
        title: 'Out of the shadow',
        body: 'The Moon slides out the other side. Most full Moons miss the shadow entirely (faint circles).',
      },
    },
  ],
}
