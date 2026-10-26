// The globe's city lights and night fill on the streamed tiles (tides-
// zmw.9.13). A stub until then: the slot stands in tile-features.ts so the
// beads each edit only their own module. See tile-material.ts for the
// adapter's contract and the base it reads.
import type { TileAdapter } from './tile-material'

export const tileNight: TileAdapter = () => null
