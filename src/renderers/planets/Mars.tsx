// Mars's surface map: Solar System Scope, CC BY 4.0 (credited in
// Credits.tsx), from
// https://www.solarsystemscope.com/textures/download/2k_mars.jpg
// (flight tier: 8k_mars.jpg, scripts/build-flight-textures.sh)
import * as THREE from 'three'
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import marsTexture from '../../assets/mars-2k.jpg'
import type { PlanetRendererProps } from './index'
import { MARS_HAZE_OUTER } from './haze-shells'

// Mars reflects more light than the Moon. Lifted, the deserts climb tone
// mapping's curve far enough to soften toward butterscotch, the map's own
// red-orange balance; at 1 or below they sink into a dark brick red.
const MARS_ALBEDO = 1.3

// Below the map's resolution at a close pass: ridged rock, softer than
// Mercury's under the dust.
const DETAIL: PlanetDetail = { style: 'rock', strength: 0.25, bump: 0.08 }

// A thin dusty haze, in Mars radii: subtler than the Earth's (lower gain,
// thinner shell). Linear RGB: dusty pink in full sun; toward the terminator
// it cools, as Martian sunsets are blue.
const HAZE_SCALE_HEIGHT = 0.007
const HAZE_SKY = new THREE.Color(0.85, 0.5, 0.4)
const HAZE_DUSK = new THREE.Color(0.45, 0.5, 0.7)
const HAZE_GAIN = 0.45

export function Mars({ planet }: PlanetRendererProps) {
  return (
    <>
      <PlanetSurface
        planet={planet}
        texture={marsTexture}
        flightTexture="mars"
        albedo={MARS_ALBEDO}
        detail={DETAIL}
      />
      <PlanetAtmosphere
        planet={planet}
        outer={MARS_HAZE_OUTER}
        scaleHeight={HAZE_SCALE_HEIGHT}
        sky={HAZE_SKY}
        dusk={HAZE_DUSK}
        gain={HAZE_GAIN}
      />
    </>
  )
}
