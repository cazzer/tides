// The scene's light levels, balanced against each other and against ACES
// tone mapping (tides-9jn.1). three.js's ACES divides by 0.6 before its
// curve, so a pre-tone-map value v displays at roughly: 0.03 → near black,
// 0.1 → dark grey, 0.3 → mid grey, 1 → light grey, 3 → near white.
//
// Sunlit Lambertian ground reflects SUNLIGHT_INTENSITY / π · albedo; ambient
// gives AMBIENT_INTENSITY / π · albedo. The day side should hold its colours
// (white cloud near, not past, the shoulder), the night side should be dark
// enough for city lights, aurora and the eclipsed Moon's glow to carry it.

/** App.tsx's Canvas; everything tone-mapped (stars, Sun, labels) shares it. */
export const TONE_MAPPING_EXPOSURE = 1

/** The directional sunlight. Was 19 (the old point light's irradiance at
 * the Earth's orbit), which pushed sunlit land to ~10 before tone mapping
 * and bleached the day side. */
export const SUNLIGHT_INTENSITY = 5

/** A faint, cool fill standing in for skylight/starlight and earthshine:
 * enough to read coastlines on the night side, little enough that it looks
 * like night. Was 1 (white), which lit the night side at about full
 * texture brightness. */
export const AMBIENT_INTENSITY = 0.14
export const AMBIENT_COLOR = '#aebfff'

/** Sunlit cloud against a white Lambertian ground (1 = equal). */
export const CLOUD_EXPOSURE = 0.95

/** Cloud under the ambient light, relative to a white Lambertian ground:
 * the deck should just read on the night side, not grey it over. */
export const CLOUD_AMBIENT = (0.7 * AMBIENT_INTENSITY) / Math.PI

/** City lights (the Earth's emissive night map), faded out on the day side. */
export const CITY_LIGHTS_COLOR = '#ffd27a'
export const CITY_LIGHTS_INTENSITY = 0.7

/** The Moon's texture is a fairly dark grey; under the gentler sunlight it
 * read dull against the night sky, so its diffuse colour is lifted. */
export const MOON_ALBEDO = 1.35

/** Light the atmosphere bends into Earth's umbra onto the Moon, as a
 * fraction of sunlight: coppery, brightest near the umbra's edge (see
 * renderers/eclipseShadow.ts). Stylised: a real total lunar eclipse is
 * ~10⁻⁴ of the full Moon, which would read as black. */
export const LUNAR_ECLIPSE_GLOW: [number, number, number] = [0.26, 0.065, 0.019]

/** The aurora's emission scale (it is additive and not tone-mapped, so its
 * greens and reds keep their saturation over the dark night side). */
export const AURORA_GAIN = 2.6
