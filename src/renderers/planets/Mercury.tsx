// Mercury's surface map: Solar System Scope, CC BY 4.0 (credited in
// Credits.tsx), from
// https://www.solarsystemscope.com/textures/download/2k_mercury.jpg
// (flight tier: 8k_mercury.jpg, scripts/build-flight-textures.sh)
import { PLANETS } from '../../planets'
import { PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import mercuryTexture from '../../assets/mercury-2k.jpg'

// Mercury's real albedo is close to the Moon's, so it is lifted until its
// sunlit disc reads as bright as the Moon's (MOON_ALBEDO) does on screen:
// the map is darker (~0.24 linear mean against ~0.32) but flatter, and a
// larger lift would push its highlands into tone mapping's shoulder and
// flatten it further. Airless, it keeps the Moon's plain Lambert shading.
const MERCURY_ALBEDO = 1.5

// Below the map's resolution at a close pass: ridged rock, with relief
// that catches a low Sun.
const DETAIL: PlanetDetail = { style: 'rock', strength: 0.3, bump: 0.12 }

export function Mercury() {
  return (
    <PlanetSurface
      planet={PLANETS.mercury}
      texture={mercuryTexture}
      flightTexture="mercury"
      albedo={MERCURY_ALBEDO}
      detail={DETAIL}
    />
  )
}
