// The outer edges of the planets' limb hazes (PlanetAtmosphere), as fractions
// of their radii: shared by their renderers and by ship mode, whose near
// plane keeps clear of them (ship-session.ts bodiesShellGap). Each haze is
// drawn from inside too while its planet is the limb body (pickShellFaces,
// tides-ufyr.4), so the ship's stop sits under it (ship-bodies.ts
// planetCollisionRadius), never on it.

export const VENUS_HAZE_OUTER = 1.05
export const MARS_HAZE_OUTER = 1.04
export const JUPITER_HAZE_OUTER = 1.02
export const URANUS_HAZE_OUTER = 1.04
export const NEPTUNE_HAZE_OUTER = 1.04
