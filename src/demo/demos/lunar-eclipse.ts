import type { Demo } from '../demo-script'

// The total lunar eclipse of 3 March 2026. Contact times are astronomy-engine's
// (SearchLunarEclipse), UTC: penumbra from 08:44:02, umbra 09:49:45, totality
// 11:03:58-12:03:23, greatest 11:33:40, umbra left 13:17:35, penumbra left
// 14:23:19. Each step's `until` keeps Play within what its caption describes.
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
      until: '2026-03-03T09:49:45Z',
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
        body: 'First the Moon crosses the faint outer shadow, the penumbra. From 09:50 UTC the dark inner shadow, the umbra, starts to cover it.',
      },
    },
    {
      date: '2026-03-03T11:20:00Z',
      until: '2026-03-03T11:50:00Z',
      timeScale: 60,
      camera: { focus: 'moon', azimuth: 30, elevation: 10, distance: 3.5 },
      caption: {
        title: 'Why the Moon turns copper',
        body: 'No sunlight reaches the Moon directly now. The only light that reaches it is bent and reddened by Earth’s atmosphere: every sunrise and sunset on Earth at once.',
      },
    },
    {
      date: '2026-03-03T11:33:46Z',
      until: '2026-03-03T12:03:23Z',
      timeScale: 0,
      mainPanel: 'top',
      location: { lat: 21.31, lon: -157.86 },
      skyLook: { azimuth: 221.5, altitude: 70.3 },
      // All the way in (SKY_FOV_MIN): the sky Moon is drawn 8× its true size
      // (eclipse-sky.ts' SKY_SCALE), ~4° across, so this is what lets the
      // copper Moon read on a phone.
      skyFov: 20,
      caption: {
        title: 'Seen from Honolulu',
        body: 'Greatest eclipse, 01:33 local time. The red Moon stands high in the south-west sky over Hawaii.',
      },
    },
    {
      date: '2026-03-03T13:17:22Z',
      until: '2026-03-03T14:23:19Z',
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
