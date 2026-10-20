import { PLANETS } from '../../planets'
import { PlanetSurface } from '../PlanetRenderer'

/** Placeholder: the catalog colour until Venus gets its texture. */
export function Venus() {
  return <PlanetSurface planet={PLANETS.venus} />
}
