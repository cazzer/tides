// The outer edges of Earth's drawn shells, as fractions of its radius: shared
// by their renderers and by ship mode, whose collision sphere must stay
// outside them (tides-3bl.7). The shells are front-face only, so from inside
// one it vanishes.

/** The atmosphere's limb-glow shell (AtmosphereRenderer). */
export const ATMOSPHERE_OUTER = 1.06

/** The aurora's shell (AuroraRenderer). */
export const AURORA_SHELL_OUTER = 1.07
