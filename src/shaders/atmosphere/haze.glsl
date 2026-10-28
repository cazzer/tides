// The atmosphere's haze (tides-qe5): shared by its shader (fragment.frag)
// and the cloud layer's (renderers/cloudShaders.ts), which from within a
// cloud's reach lays the haze in front of a cloud over it (tides-01v.8.6).
// The caller declares uSurface, uScaleHeight, uGain, uSky, uDusk and
// uSeaLevel (read only by columnAheadOverSea(), but every includer
// compiles it), and the sky-view table's uSkyView, uSkyViewSize and
// uSkyViewOn (renderers/skyView.ts SKY_VIEW_GLSL), but for the table's own
// build (SKY_VIEW_BUILD).

// The column from radius r out to space along a ray climbing at cos(zenith)
// mu ≥ 0: Chapman's grazing-incidence column, n(r)·H·sqrt(πx/2)·erfcx(z)
// with x = r/H, z = mu·sqrt(x/2), and erfcx(z) ≈ 2/(√π(z + sqrt(z² + 4/π)))
// (within a few %). H/mu overhead, half the full line at the horizon.
float hazeAbove(float r, float mu) {
  float H = uScaleHeight;
  float x = r / H;
  float z = mu * sqrt(0.5 * x);
  return exp(-(r - uSurface) / H) * H * sqrt(2.0 * x) / (z + sqrt(z * z + 1.2732395));
}

// The haze ahead of an eye inside the shell, on the same scale as the
// outside view's: the column the outside view gives the ray's line (faded
// over the disc where it meets the ground), less the part behind the eye.
// So the two agree where the eye crosses the shell, and nothing jumps at the
// horizon. Light falls where the column is thickest: the closest approach
// or the ground if ahead, else the eye. Below the haze's base (a few km),
// the eye counts as at it.
float columnAhead(vec3 ro, vec3 rd, float grazing, out vec3 at) {
  float H = uScaleHeight;
  float r = max(length(ro), uSurface);
  vec3 eye = normalize(ro) * r;
  float b = dot(eye, rd);
  float mu = b / r;
  if (mu >= 0.0) {
    at = eye;
    return hazeAbove(r, mu);
  }
  float c2 = r * r - b * b;
  float p = sqrt(max(c2, 0.0));
  float hs = uSurface * uSurface - c2;
  float line;
  if (hs > 0.0) {
    at = eye + rd * (-b - sqrt(hs));
    line = grazing * exp(-(uSurface - p) / (1.5 * H));
  } else {
    at = eye - rd * b;
    line = grazing * sqrt(p / uSurface) * exp(-(p - uSurface) / H);
  }
  return max(line - hazeAbove(r, -mu), 0.0);
}

// The haze the atmosphere draws over a ray from inside (tides-01v.8.20):
// columnAhead(), but from below the base a ray that meets the sea is
// mostly aimed from the base (where the eye counts as being) at the same
// point of the sea. Kept on its own line, a ray just under the horizon
// would graze the base far off, and the sea's last few degrees took the
// limb's glow from near the ground. Toward the sea's horizon it eases back
// to its own line, so the sea meets the sky (and land standing past that
// horizon) with no step: over HAZE_SEA_RAMP of 1 - (dip / depression)^2,
// depressions within ~5% of the dip, a few pixels at the floor (wider
// shows as a cyan rim along the horizon). The cloud layer keeps
// columnAhead(): its share of the haze is a ratio of two of them along one
// ray, which the aim, differing from each end, would skew.
#define HAZE_SEA_RAMP 0.1
float columnAheadOverSea(vec3 ro, vec3 rd, float grazing, out vec3 at) {
  float column = columnAhead(ro, rd, grazing, at);
  float bSea = dot(ro, rd);
  float hSea = bSea * bSea - (dot(ro, ro) - uSeaLevel * uSeaLevel);
  // An eye inside the sea (no ship stop, but a camera could) has none ahead.
  if (length(ro) < uSurface && length(ro) > uSeaLevel && bSea < 0.0 && hSea > 0.0) {
    vec3 eye = normalize(ro) * uSurface;
    vec3 sea = ro + rd * (-bSea - sqrt(hSea));
    float own = 1.0 - smoothstep(0.0, HAZE_SEA_RAMP, hSea / (bSea * bSea));
    vec3 atSea;
    column = mix(columnAhead(eye, normalize(sea - eye), grazing, atSea), column, own);
    at = mix(atSea, at, own);
  }
  return column;
}

// The limb's glow for a column (grazing: the limb's), lit where it is
// thickest, at, by the Sun along sun: the look from outside (tides-qe5).
vec3 hazeLimb(float column, float grazing, vec3 at, vec3 sun) {
  float mu = dot(normalize(at), sun);
  float lit = smoothstep(-0.18, 0.12, mu);
  // Low sun reddens the light reaching this part of the haze.
  float dusk = 1.0 - smoothstep(0.0, 0.35, mu);
  float glow = (column / grazing) * lit * uGain;
  // Compress the brightness, not each channel, so the limb stays blue.
  return mix(uSky, uDusk, dusk * 0.6) * (glow / (1.0 + glow));
}

// The sky from inside (tides-34q): single scattering of the sunlight that
// reaches at, along rd, over a column measured in vertical columns from the
// base (one overhead). Rayleigh (blue, 1 + cos^2) and a forward Mie lobe;
// each channel saturates with its own depth, so the zenith is blue and the
// horizon pales, and the light at is reddened by the air mass toward the
// Sun, so the low Sun's side of the sky glows warm.
// Per vertical column from the base: Rayleigh's depth (red, green, blue),
// the haze's (Mie, grey) and its forward lobe's asymmetry, and ozone's
// absorption (the Chappuis band), which on the twilight's long sunbeams
// takes the green and orange out, so the sky away from the Sun stays blue
// to purple rather than olive. SKY_SUN scales the sunlight to the scene's
// (lighting.ts: the zenith at noon a mid blue under ACES), SKY_MULTI the
// light scattered more than once, and SKY_AIRMASS the sunbeam's air mass.
#define SKY_RAYLEIGH vec3(0.058, 0.135, 0.331)
#define SKY_MIE 0.008
#define SKY_MIE_G 0.85
#define SKY_OZONE vec3(0.03, 0.07, 0.003)
#define SKY_SUN 7.0
#define SKY_MULTI 0.3
#define SKY_AIRMASS 1.2

// The sunlight's depth (per channel) on its way to radius r with the Sun at
// mu: the column toward it over the vertical one there.
vec3 hazeSunDepth(float mu, float r) {
  float m = hazeAbove(max(r, uSurface), max(mu, 0.0)) / (uScaleHeight * exp(-max(r - uSurface, 0.0) / uScaleHeight));
  return (SKY_RAYLEIGH + SKY_MIE + SKY_OZONE) * m * SKY_AIRMASS;
}
vec3 hazeSky(float column, vec3 at, vec3 sun, vec3 rd, vec3 eye) {
  vec3 up = normalize(at);
  float mu = dot(up, sun);
  float lit = smoothstep(-0.12, 0.04, mu);
  // The light reaching the air the ray crosses: a ray along the sea's
  // horizon stays in the densest air, where it is reddened most; a steeper
  // one climbs through air that the Sun reaches through less of it, over
  // which the light's transmittance, e^-k at the base, averages
  // (1 - e^-k) / k. Its climb is measured from the eye's sea horizon, not
  // its level, which lies a little above it: there the ray's light point
  // (columnAhead()) jumps, and a weight on it drew a hard band.
  vec3 k = hazeSunDepth(mu, length(at));
  vec3 climbing = (1.0 - exp(-k)) / max(k, vec3(1e-4));
  float rE = length(eye);
  float dip = sqrt(max(1.0 - uSeaLevel * uSeaLevel / (rE * rE), 0.0));
  float climb = clamp((dot(rd, eye / rE) + dip) / (1.0 + dip), 0.0, 1.0);
  vec3 sunT = mix(exp(-k), climbing, pow(climb, 0.4));
  float c = dot(rd, sun);
  float g = SKY_MIE_G;
  float pR = 0.0596831 * (1.0 + c * c);
  float pM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  vec3 ext = SKY_RAYLEIGH + SKY_MIE * 1.1;
  vec3 depth = 1.0 - exp(-ext * (column / uScaleHeight));
  vec3 single = sunT * (SKY_RAYLEIGH * pR + SKY_MIE * pM) / ext;
  // Light scattered more than once: bluer, and less reddened.
  vec3 multi = SKY_MULTI * climbing * SKY_RAYLEIGH / ext * 0.0795775;
  return SKY_SUN * lit * (single + multi) * depth;
}

// The sky-view table's directions (tides-34q.2, sky-view.frag): u, the
// azimuth from the Sun's over pi; v, the elevation over the eye's level,
// squeezed toward the horizon, where the sky changes fastest. Both in 0..1
// over the texel centres.
#define SKY_VIEW_HALF_PI 1.5707963
vec3 skyViewDir(vec2 uv) {
  float phi = uv.x * 3.14159265;
  float s = 2.0 * uv.y - 1.0;
  float e = sign(s) * s * s * SKY_VIEW_HALF_PI;
  return vec3(cos(e) * cos(phi), sin(e), cos(e) * sin(phi));
}

#ifndef SKY_VIEW_BUILD
// The table's texel along rd from eye with the Sun along sun (the includer
// declares uSkyView and uSkyViewSize): rgb, the radiance; a, the path's
// transmittance.
vec4 skyViewTexel(vec3 rd, vec3 eye, vec3 sun) {
  vec3 up = normalize(eye);
  float y = clamp(dot(rd, up), -1.0, 1.0);
  vec3 across = rd - up * y;
  vec3 sunAcross = sun - up * dot(sun, up);
  float a2 = dot(across, across) * dot(sunAcross, sunAcross);
  float phi = a2 > 1e-14 ? acos(clamp(dot(across, sunAcross) * inversesqrt(a2), -1.0, 1.0)) : 0.0;
  float e = asin(y);
  vec2 uv = vec2(phi / 3.14159265, 0.5 + 0.5 * sign(e) * sqrt(abs(e) / SKY_VIEW_HALF_PI));
  return texture(uSkyView, (0.5 + uv * (uSkyViewSize - 1.0)) / uSkyViewSize);
}
vec3 skyViewGlow(vec3 rd, vec3 eye, vec3 sun) {
  return skyViewTexel(rd, eye, sun).rgb;
}
#endif

// The haze's colour for a column (grazing: the limb's), lit where it is
// thickest, at, by the Sun along sun, seen along rd from eye: the limb's
// glow from outside, the sky's from inside (Earth only: uSeaLevel > 0),
// eased between over a few scale heights over the base.
vec3 hazeGlow(float column, float grazing, vec3 at, vec3 sun, vec3 rd, vec3 eye) {
  vec3 limb = hazeLimb(column, grazing, at, sun);
  if (uSeaLevel <= 0.0) return limb;
  float inside = 1.0 - smoothstep(uSurface + uScaleHeight, uSurface + 4.0 * uScaleHeight, length(eye));
  if (inside <= 0.0) return limb;
#ifndef SKY_VIEW_BUILD
  // The high tier's table (tides-34q.2), else the analytic sky.
  if (uSkyViewOn > 0.5) return mix(limb, skyViewGlow(rd, eye, sun), inside);
#endif
  return mix(limb, hazeSky(column, at, sun, rd, eye), inside);
}

// How much of the ground a ray from inside meets the haze hides (tides-
// d9f.3): one less the path's transmittance, the table's on the high tier
// (marched to the sea with its glow), else the column's, grey (the green's
// extinction, with which hazeSky()'s glow saturates). Eased in over the base
// as hazeGlow() eases to the sky, so from outside (and on the planets,
// uSeaLevel 0) the haze only adds, as ever; from inside, ground seen
// through a thick haze takes its colour instead of whitening under it.
float hazeCover(float column, vec3 rd, vec3 eye, vec3 sun) {
  if (uSeaLevel <= 0.0) return 0.0;
  float inside = 1.0 - smoothstep(uSurface + uScaleHeight, uSurface + 4.0 * uScaleHeight, length(eye));
  if (inside <= 0.0) return 0.0;
  float through = exp(-(SKY_RAYLEIGH.g + SKY_MIE * 1.1) * column / uScaleHeight);
#ifndef SKY_VIEW_BUILD
  if (uSkyViewOn > 0.5) through = skyViewTexel(rd, eye, sun).a;
#endif
  return inside * (1.0 - through);
}
