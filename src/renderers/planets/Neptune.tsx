// Neptune: deep blue with the texture's banding and Voyager's Great Dark
// Spot, under a faint blue limb.
//
// Texture: Solar System Scope, CC BY 4.0 (credited in Credits.tsx),
// https://www.solarsystemscope.com/textures/download/2k_neptune.jpg
import { PlanetAtmosphere, PlanetSurface } from '../PlanetRenderer'
import type { PlanetDetail } from '../planetMaterials'
import neptuneTexture from '../../assets/neptune-2k.jpg'
import neptuneCompressed from '../../assets/bodies/neptune-2k.ktx2?url'
import type { PlanetRendererProps } from './index'
import { DECK_PROFILES } from '../../cloud-deck'
import { NEPTUNE_HAZE_OUTER } from './haze-shells'

// Below the map's resolution at a close pass: banded filaments.
const DETAIL: PlanetDetail = { style: 'bands', strength: 0.18 }

export function Neptune({ planet }: PlanetRendererProps) {
  return (
    <>
      <PlanetSurface
        planet={planet}
        texture={neptuneTexture}
        compressedTexture={neptuneCompressed}
        limbDarkening={1.1}
        detail={DETAIL}
        deck={DECK_PROFILES.neptune}
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
