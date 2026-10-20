import { PLANETS } from '../../planets'
import { PlanetRings, PlanetSurface } from '../PlanetRenderer'

/** Placeholder: the catalog colour and banded rings until Saturn gets its textures. */
export function Saturn() {
  return (
    <>
      <PlanetSurface planet={PLANETS.saturn} />
      <PlanetRings planet={PLANETS.saturn} opacity={0.8} />
    </>
  )
}
