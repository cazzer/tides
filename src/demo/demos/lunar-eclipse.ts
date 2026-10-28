import type { Demo } from '../demo-script'

// The total lunar eclipse of 3 March 2026. Contact times are astronomy-engine's
// (SearchLunarEclipse): penumbra from 08:44 UT, umbra 09:50, totality
// 11:04-12:03, greatest 11:33:40, umbra left 13:17.
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
      timeScale: 0,
      layout: 'single',
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 90, elevation: 25, distance: 120 },
      caption: {
        title: 'Sun, Earth and Moon in a line',
        body: 'The full Moon is lining up behind Earth, exactly opposite the Sun. Earth’s shadow points straight at it.',
      },
    },
    {
      date: '2026-03-03T09:40:00Z',
      until: '2026-03-03T11:00:00Z',
      timeScale: 300,
      camera: { focus: 'moon', azimuth: 40, elevation: 15, distance: 6 },
      caption: {
        title: 'Into the shadow',
        body: 'First the Moon crosses the faint outer shadow, the penumbra. From 09:50 UT the dark inner shadow, the umbra, starts to cover it.',
      },
    },
    {
      date: '2026-03-03T11:20:00Z',
      until: '2026-03-03T11:50:00Z',
      timeScale: 60,
      camera: { focus: 'moon', azimuth: 30, elevation: 10, distance: 3.5 },
      caption: {
        title: 'Why the Moon turns copper',
        body: 'No sunlight reaches the Moon directly now. What does is bent and reddened through Earth’s atmosphere: every sunrise and sunset on Earth at once.',
      },
    },
    {
      date: '2026-03-03T11:33:46Z',
      timeScale: 0,
      mainPanel: 'top',
      location: { lat: 21.31, lon: -157.86 },
      skyLook: { azimuth: 221.5, altitude: 70.3 },
      caption: {
        title: 'Seen from Honolulu',
        body: 'Greatest eclipse, 01:33 local time. The red Moon stands high in the south-west sky over Hawaii.',
      },
    },
    {
      date: '2026-03-03T13:17:22Z',
      timeScale: 0,
      mainPanel: 'main',
      camera: { focus: 'earth', azimuth: 90, elevation: 25, distance: 120 },
      caption: {
        title: 'Out of the umbra',
        body: 'The Moon leaves the umbra. It stays faintly dimmed in the penumbra for another hour, then the eclipse is over.',
      },
    },
  ],
}
