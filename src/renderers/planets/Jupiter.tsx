import { PLANETS } from '../../planets'
import { PlanetSurface } from '../PlanetRenderer'

/** Placeholder: the catalog colour until Jupiter gets its texture. */
export function Jupiter() {
  return <PlanetSurface planet={PLANETS.jupiter} />
}
