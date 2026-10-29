import type { Demo, DemoPose } from '../demo-script'

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
// The wide view, about the Moon so every step keeps one focus and each move
// between stops can carry the clock (DemoStep.travel) instead of cutting:
// from the Sun's side and above, the Sun, Earth and the Moon in Earth's
// shadow rings in frame, the Moon looking full; a narrow phone backs off to
// keep 40 units about the Moon in view, which brings in the whole Sun.
const WIDE: Omit<DemoPose, 'focus'> = { azimuth: 20, elevation: 25, distance: 170, fit: 40 }

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
      camera: { focus: 'moon', ...WIDE },
      aids: { earthShadow: true },
      caption: {
        title: 'Sun, Earth, Moon aligned',
        body: 'Full Moon, almost exactly behind Earth. Earth’s shadow points at it.',
      },
    },
    {
      date: '2026-03-03T09:40:00Z',
      until: '2026-03-03T11:04:04Z',
      timeScale: 300,
      // The clock runs on from the line-up while the view stays wide, then
      // pushes in past Earth's day side to the Moon entering the rings.
      travel: { seconds: 4, camera: WIDE },
      camera: { focus: 'moon', azimuth: 21, elevation: 6, distance: 23 },
      caption: {
        title: 'Into the shadow',
        body: 'The Moon’s orbit carries it into Earth’s shadow, faint then dark. Gold dots: entering and leaving the dark core.',
      },
    },
    {
      date: '2026-03-03T11:04:04Z',
      until: '2026-03-03T11:33:46Z',
      timeScale: 60,
      travel: { seconds: 3 },
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
      travel: { seconds: 2 },
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
      travel: { seconds: 3, camera: WIDE },
      camera: { focus: 'moon', ...WIDE },
      aids: { earthShadow: true, fullMoonGhosts: true },
      caption: {
        title: 'Out of the shadow',
        body: 'The Moon slides out the other side. Most full Moons miss it, like the two small circles.',
      },
    },
  ],
}
