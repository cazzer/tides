/**
 * How far apart the bodies sit (tides-2hv). The system view keeps its
 * compressed sceneDistance spacing; ship mode's 'flight' spreads the planets
 * out so there is room to fly between them (tides-2hv.6). Threaded from Scene
 * down to everything placed by distance from the Sun.
 */
export type DistanceScale = 'system' | 'flight'
