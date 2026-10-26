// The ground haze on the streamed tiles (tides-zmw.9.7): the globe's own
// surface variant (../groundHaze.ts surfacePatch), on the haze's uniforms,
// which EarthRenderer fills for each camera before anything draws. It
// carries its own ray and eye (from the same frame uniforms the base reads),
// so its text is what tides-zmw.9.7 laid on the tiles.
import type { TileAdapter } from './tile-material'

export const tileHaze: TileAdapter = (link) => ({ patch: link.haze.surfacePatch })
