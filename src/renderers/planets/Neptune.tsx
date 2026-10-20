// Neptune: deep blue with the texture's banding and Voyager's Great Dark
// Spot, under a faint blue limb.
//
// Texture: Solar System Scope, CC BY 4.0 (credited by PlanetAttribution),
// https://www.solarsystemscope.com/textures/download/2k_neptune.jpg
import { PLANETS } from '../../planets'
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import neptuneTexture from '../../assets/neptune-2k.jpg'

const NEPTUNE = PLANETS.neptune

export function Neptune() {
  return (
    <>
      <PlanetSurface
        planet={NEPTUNE}
        texture={neptuneTexture}
        limbDarkening={1.1}
      />
      <PlanetAtmosphere
        planet={NEPTUNE}
        outer={1.04}
        scaleHeight={0.008}
        sky="#5a82ff"
        dusk="#3a50c8"
        gain={0.45}
      />
    </>
  )
}
