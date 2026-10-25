// The scene's light levels, balanced against each other and against ACES
// tone mapping (tides-9jn.1). three.js's ACES divides by 0.6 before its
// curve, so a pre-tone-map value v displays at roughly: 0.03 → near black,
// 0.1 → dark grey, 0.3 → mid grey, 1 → light grey, 3 → near white.
//
// Sunlit Lambertian ground reflects SUNLIGHT_INTENSITY / π · albedo; ambient
// gives AMBIENT_INTENSITY / π · albedo. The day side should hold its colours
// (white cloud near, not past, the shoulder), the night side should be dark
// enough for city lights, aurora and the eclipsed Moon's glow to carry it.
//
// In flight, near the ground at night, the eye adapts (tides-tvr.2;
// ../night-flight.ts): a night fill and the real Moon's light lift the
// ground and the clouds' ambient, by an adaptation that is 0 by day, high
// up and in the system view, which keeps exactly these levels.

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
export const CLOUD_AMBIENT_SHARE = 0.7
export const CLOUD_AMBIENT = (CLOUD_AMBIENT_SHARE * AMBIENT_INTENSITY) / Math.PI

/** The adapted eye's fill at night in flight, in AMBIENT_COLOR and added
 * to the ambient, on an albedo mostly greyed (renderers/nightLights.ts
 * NIGHT_DESATURATION): land (~0.25 albedo) reaches ~0.019 before tone
 * mapping (from ~0.006), sea ~0.004 and cloud tops ~0.067, so coasts and
 * the deck read on a moonless night that still looks like night. At 0.7
 * the same night read as a dim day. */
export const NIGHT_FILL_INTENSITY = 0.3

/** The full Moon's light on the adapted eye's ground, cool and fainter than
 * a tenth of the day's: overhead it brings land to ~0.083 (toward dark
 * grey) and cloud tops to ~0.25; at 40 deg up ~0.060 and ~0.18, three times
 * the moonless night's. Scaled down with the phase (night-flight.ts). */
export const MOONLIGHT_INTENSITY = 1.2
export const MOONLIGHT_COLOR = '#c8d6ff'

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
