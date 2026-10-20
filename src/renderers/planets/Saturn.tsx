import { PLANETS } from '../../planets'
import {
  PlanetRings,
  PlanetSurface,
  type RingProfile,
} from '../PlanetRenderer'

const SATURN = PLANETS.saturn

// Placeholder bands until Saturn gets its ring texture, in Saturn radii
// (60 268 km): the faint C ring, the dense B ring, the Cassini Division,
// and the A ring split by the Encke Gap.
const RINGS: RingProfile = {
  ...SATURN.rings!,
  bands: [
    { inner: 1.239, outer: 1.527, opacity: 0.25 },
    { inner: 1.527, outer: 1.75, opacity: 0.8 },
    { inner: 1.75, outer: 1.951, opacity: 0.95 },
    { inner: 1.951, outer: 2.027, opacity: 0.08 },
    { inner: 2.027, outer: 2.214, opacity: 0.6 },
    { inner: 2.22, outer: 2.27, opacity: 0.55 },
  ],
}

/** Placeholder: the catalog colour and banded rings until Saturn gets its textures. */
export function Saturn() {
  return (
    <>
      <PlanetSurface
        planet={SATURN}
        ringShadow={RINGS}
      />
      <PlanetRings
        planet={SATURN}
        {...RINGS}
      />
    </>
  )
}
