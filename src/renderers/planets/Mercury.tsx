import { PLANETS } from '../../planets'
import { PlanetSurface } from '../PlanetRenderer'

/** Placeholder: the catalog colour until Mercury gets its texture. */
export function Mercury() {
  return <PlanetSurface planet={PLANETS.mercury} />
}
