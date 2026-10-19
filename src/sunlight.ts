import * as THREE from 'three'
import { earthPosition } from './ephemeris'
import { SUNLIGHT_INTENSITY } from './lighting'

export { SUNLIGHT_INTENSITY }

// Sunlight arrives in parallel rays. A point light at this compressed-scale
// Sun would light less than a hemisphere of the Earth (sunsets ~30 min early)
// and too much of the Moon, which sits 10 units off a 50-unit orbit.
export function createSunlight(): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight('white', SUNLIGHT_INTENSITY)
  light.position.set(0, 0, 0)
  return light
}

// Shine from the Sun (scene origin) along the Sun->Earth line. The Moon gets
// the same direction; the real one differs by under 0.15°.
export function aimSunlight(light: THREE.DirectionalLight, t: number) {
  light.target.position.set(...earthPosition(t))
}
