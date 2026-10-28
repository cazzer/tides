// Neptune: deep blue with the texture's banding and Voyager's Great Dark
// Spot, under a faint blue limb.
//
// Texture: Solar System Scope, CC BY 4.0 (credited in Credits.tsx),
// https://www.solarsystemscope.com/textures/download/2k_neptune.jpg
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import neptuneTexture from '../../assets/neptune-2k.jpg'
import type { PlanetRendererProps } from './index'
import { NEPTUNE_HAZE_OUTER } from './haze-shells'

// Below the map's resolution at a close pass: banded filaments.
const DETAIL: PlanetDetail = { style: 'bands', strength: 0.18 }

export function Neptune({ planet }: PlanetRendererProps) {
  return (
    <>
      <PlanetSurface
        planet={planet}
        texture={neptuneTexture}
        limbDarkening={1.1}
        detail={DETAIL}
      />
      <PlanetAtmosphere
        planet={planet}
        outer={NEPTUNE_HAZE_OUTER}
        scaleHeight={0.008}
        sky="#5a82ff"
        dusk="#3a50c8"
        gain={0.45}
      />
    </>
  )
}
