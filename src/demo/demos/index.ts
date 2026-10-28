import type { Demo } from '../demo-script'
import { lunarEclipse } from './lunar-eclipse'

/** Every demo, in the order the menu lists them. */
export const DEMOS: readonly Demo[] = [lunarEclipse]

export function findDemo(id: string): Demo | undefined {
  return DEMOS.find((demo) => demo.id === id)
}
