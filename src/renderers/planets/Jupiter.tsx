// Jupiter (tides-kzj.2.10). Texture: Solar System Scope, CC BY 4.0
// (credited by PlanetAttribution),
// https://www.solarsystemscope.com/textures/download/2k_jupiter.jpg
import { PLANETS } from '../../planets'
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import jupiterTexture from '../../assets/jupiter-2k.jpg'

const JUPITER = PLANETS.jupiter

// Jupiter's cloud tops darken only gently toward the limb in visible light.
const LIMB_DARKENING = 1.15

// Below the map's resolution at a close pass: turbulent filaments along
// the bands.
const DETAIL: PlanetDetail = { style: 'bands', strength: 0.3 }

export function Jupiter() {
  return (
    <>
      <PlanetSurface
        planet={JUPITER}
        texture={jupiterTexture}
        limbDarkening={LIMB_DARKENING}
        detail={DETAIL}
      />
      {/* A thin warm haze, seen only as a faint rim on the day side. */}
      <PlanetAtmosphere
        planet={JUPITER}
        outer={1.02}
        scaleHeight={0.004}
        sky="#f2d9b0"
        dusk="#c98a4b"
        gain={0.35}
      />
    </>
  )
}
