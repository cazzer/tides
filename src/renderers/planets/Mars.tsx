import { PLANETS } from '../../planets'
import { PlanetSurface } from '../PlanetRenderer'
// Solar System Scope, CC BY 4.0 (credited by PlanetAttribution).
import marsTexture from '../../assets/mars-2k.jpg'

export function Mars() {
  return <PlanetSurface planet={PLANETS.mars} texture={marsTexture} />
}
