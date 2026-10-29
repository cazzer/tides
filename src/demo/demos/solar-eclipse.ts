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
// The clock runs on from step to step, landfall to the 8 May new moon, but
// for step 5, which plays step 4's crossing again from a camera turning with
// Earth: the ground holds still and the shadow still runs east, so it is the
// Moon's motion that carries it, Earth's spin only slowing it on the ground.
//
// In steps 2 and 3 the View from Earth draws the Moon at the Sun's scale with
// a daylit sky (aids.solarEclipseSky, eclipse-sky.ts); step 6 adds the Moon's
// tilted orbit, node line, true shadow axis near new moon and an arrow to the
// Sun (aids.moonNodes). In steps 1, 4 and 5 the main view darkens and rings
// the shadow on Earth (aids.moonShadow, MoonShadowGlobe.tsx), which at true
// scale is a faint smudge, and leaves the path of totality behind it
// (aids.totalityPath, totality-path.ts); step 6 turns both off.

// From the Sun's side and a little below the ecliptic, so the sunward Moon
// stands just over Earth's top limb, above its own shadow; it is seen full,
// the side facing us lit. Its 10 units are mostly up the screen, so only
// Earth needs the width: a phone backs off to keep it (and a margin) in view.
// `keep` backs off too wherever the caption leaves the Moon too little room.
const SUN_SIDE = { focus: 'earth', elevation: -22, distance: 30, fit: 4.2, keep: ['moon'] } as const
export const solarEclipse: Demo = {
  id: 'solar-eclipse',
  title: 'Total solar eclipse',
  blurb: 'Follow the Moon’s shadow across North America and stand in totality, 8 April 2024.',
  steps: [
    {
      // The umbra's axis meets Earth at sunrise on the Pacific limb at 16:40.
      date: '2024-04-08T16:40:00Z',
      until: '2024-04-08T17:50:00Z',
      timeScale: 180,
      layout: 'single',
      mainPanel: 'main',
      camera: { ...SUN_SIDE, azimuth: -10 },
      aids: { moonShadow: true, totalityPath: true },
      caption: {
        title: 'The Moon’s shadow lands',
        body: 'Seen from the Sun’s side: the Moon (above) casts this shadow. Total in the dark dot, partial inside the ring.',
      },
    },
    {
      date: '2024-04-08T17:50:00Z',
      until: '2024-04-08T18:16:40Z',
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
      // On from the partial phase, so second contact plays live a few
      // seconds in, then third and the light coming back.
      date: '2024-04-08T18:16:40Z',
      until: '2024-04-08T18:21:30Z',
      timeScale: 4,
      skyLook: { azimuth: 152.5, altitude: 70 },
      skyFov: 70,
      caption: {
        title: 'Totality',
        body: 'For 4 minutes the Moon just covers the Sun. Stars come out; the corona appears.',
      },
    },
    {
      date: '2024-04-08T18:21:30Z',
      until: '2024-04-08T19:55:27Z',
      timeScale: 120,
      // The crossing three times over, ~47 s a pass, back to its start after
      // a 1 s rest, forward only; the trail and marks follow the clock.
      loop: { from: '2024-04-08T18:21:30Z', to: '2024-04-08T19:55:27Z', times: 3, holdMs: 1000 },
      mainPanel: 'main',
      // As step 1, turned east with the shadow.
      camera: { ...SUN_SIDE, azimuth: 5 },
      // Off again: the enlarged sky Moon sits inside the ground's bowl, so it
      // shows only while the Torreón steps hold it high.
      aids: { solarEclipseSky: false },
      caption: {
        title: 'The shadow sweeps north-east',
        body: 'The Moon drags its shadow east, outrunning Earth’s spin. The dark band shows where totality fell.',
      },
    },
    {
      // The same crossing again, cut back to its start, from high over Canada
      // and turning with Earth, so North America holds still under the eye
      // and the Moon stays low in the frame, off it on a phone.
      date: '2024-04-08T18:21:30Z',
      until: '2024-04-08T19:55:27Z',
      timeScale: 120,
      camera: { focus: 'earth', frame: 'earth', azimuth: -88, elevation: 55, distance: 30, fit: 4.2 },
      caption: {
        title: 'Turning with Earth',
        body: 'Now we turn with Earth: the ground holds still, yet the shadow still runs east. The Moon carries it.',
      },
    },
    {
      date: '2024-04-08T19:55:27Z',
      until: '2024-05-08T03:22:29Z',
      timeScale: 43200,
      // Edge on to the ecliptic: the ecliptic circle, Earth's orbit and the
      // month labels collapse to one line, the Moon's orbit tilted across it.
      // The pose is set once, against the Sun at the step's start; the Sun
      // turns ~29° by the 8 May stop, which this frames: the eye ~57° round
      // from the Sun (to the right) and ~23° off the node line, so the new
      // Moon is mostly lit, well clear of the node dots, the orbit's tilt
      // shows, and the shadow axis passing above Earth runs across the view.
      // A phone backs off until the whole orbit fits its width.
      camera: { focus: 'earth', azimuth: -28, elevation: 0, distance: 55, fit: 10.8 },
      aids: { moonNodes: true, moonShadow: false, totalityPath: false },
      caption: {
        title: 'Why not every month?',
        body: 'The Moon’s orbit (lilac) tilts 5°. May’s new moon shadow (grey) passes above Earth. Eclipses need a node (gold).',
      },
    },
  ],
}
