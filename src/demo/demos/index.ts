import type { Demo } from '../demo-script'
import { lunarEclipse } from './lunar-eclipse'
import { planets } from './planets'
import { seasons } from './seasons'
import { solarEclipse } from './solar-eclipse'
import { tides } from './tides'

/** Every demo, in the order the menu lists them. */
export const DEMOS: readonly Demo[] = [lunarEclipse, solarEclipse, seasons, tides, planets]

export function findDemo(id: string): Demo | undefined {
  return DEMOS.find((demo) => demo.id === id)
}
