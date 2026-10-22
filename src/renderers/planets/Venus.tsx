// Venus's cloud tops (its surface never shows through them): Solar System
// Scope, CC BY 4.0 (credited by PlanetAttribution), from
// https://www.solarsystemscope.com/textures/download/2k_venus_atmosphere.jpg
import * as THREE from 'three'
import { PLANETS } from '../../planets'
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import venusTexture from '../../assets/venus-2k.jpg'

const VENUS = PLANETS.venus

// The brightest planet: the cloud deck is drawn at its full map colour, and
// the deck's haze darkens it gently toward the limb (Minnaert k > 1).
const VENUS_ALBEDO = 1
const VENUS_LIMB_DARKENING = 1.2
// Below the map's resolution at a close pass: faint streaks along the
// cloud deck's flow.
const DETAIL: PlanetDetail = { style: 'streaks', strength: 0.1 }

// A thin haze above the cloud tops, in Venus radii, exaggerated as the
// Earth's is to read at this scale. Linear RGB: pale yellow in full sun,
// warming to cream toward the terminator.
const HAZE_OUTER = 1.05
const HAZE_SCALE_HEIGHT = 0.008
const HAZE_SKY = new THREE.Color(1, 0.8, 0.42)
const HAZE_DUSK = new THREE.Color(1, 0.62, 0.3)
const HAZE_GAIN = 0.55

export function Venus() {
  return (
    <>
      <PlanetSurface
        planet={VENUS}
        texture={venusTexture}
        albedo={VENUS_ALBEDO}
        limbDarkening={VENUS_LIMB_DARKENING}
        detail={DETAIL}
      />
      <PlanetAtmosphere
        planet={VENUS}
        outer={HAZE_OUTER}
        scaleHeight={HAZE_SCALE_HEIGHT}
        sky={HAZE_SKY}
        dusk={HAZE_DUSK}
        gain={HAZE_GAIN}
      />
    </>
  )
}
