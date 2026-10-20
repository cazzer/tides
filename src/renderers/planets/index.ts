// Each planet's look, one file per planet so they can be worked on
// independently. A file composes PlanetSurface, PlanetAtmosphere and
// PlanetRings (../PlanetRenderer) with its own textures and parameters.
import type { ComponentType } from 'react'
import type { PlanetKey } from '../../planets'
import { Mercury } from './Mercury'
import { Venus } from './Venus'
import { Mars } from './Mars'
import { Jupiter } from './Jupiter'
import { Saturn } from './Saturn'
import { Uranus } from './Uranus'
import { Neptune } from './Neptune'

export const PLANET_RENDERERS: Readonly<Record<PlanetKey, ComponentType>> = {
  mercury: Mercury,
  venus: Venus,
  mars: Mars,
  jupiter: Jupiter,
  saturn: Saturn,
  uranus: Uranus,
  neptune: Neptune,
}
