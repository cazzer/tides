// Filled by tides-2hv.8: the major moons of Mars and the outer planets.
// SolarSystem mounts this beside PlanetBodies, in the orbital views only;
// Earth's Moon stays in solar-system.tsx.
import type { FC } from 'react'
import type { DistanceScale } from '../distance-scale'

export interface MoonBodiesProps {
  /** Which planet positions the moons follow. */
  distanceScale: DistanceScale
  /** The main panel's moons can register for camera focus, as PlanetBodies does. */
  interactive: boolean
}

export const MoonBodies: FC<MoonBodiesProps> = () => null
