// Lays out the Sun's spicule blades (./sun-spicules.ts spiculeArrays, ~40–57
// ms) off the main thread (tides-9yw), and hands the arrays back transferred.
// SunSpicules.tsx falls back to an idle period where a worker can't start.
import { spiculeArrays } from './sun-spicules'

self.onmessage = () => {
  const arrays = spiculeArrays()
  self.postMessage(arrays, { transfer: [arrays.spicule.buffer, arrays.lean.buffer, arrays.size.buffer] })
}
