// The atmosphere's haze (tides-qe5): shared by its shader (fragment.frag)
// and the cloud layer's (renderers/cloudShaders.ts), which from within a
// cloud's reach lays the haze in front of a cloud over it (tides-01v.8.6).
// The caller declares uSurface, uScaleHeight, uGain, uSky, uDusk and
// uSeaLevel (read only by columnAheadOverSea(), but every includer
// compiles it).

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

// The haze's colour for a column (grazing: the limb's), lit where it is
// thickest, at, by the Sun along sun.
vec3 hazeGlow(float column, float grazing, vec3 at, vec3 sun) {
  float mu = dot(normalize(at), sun);
  float lit = smoothstep(-0.18, 0.12, mu);
  // Low sun reddens the light reaching this part of the haze.
  float dusk = 1.0 - smoothstep(0.0, 0.35, mu);
  float glow = (column / grazing) * lit * uGain;
  // Compress the brightness, not each channel, so the limb stays blue.
  return mix(uSky, uDusk, dusk * 0.6) * (glow / (1.0 + glow));
}
