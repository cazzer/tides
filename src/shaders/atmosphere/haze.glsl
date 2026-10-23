// The atmosphere's haze (tides-qe5): shared by its shader (fragment.frag)
// and the cloud layer's (renderers/cloudShaders.ts), which from within a
// cloud's reach lays the haze in front of a cloud over it (tides-01v.8.6).
// The caller declares uSurface, uScaleHeight, uGain, uSky and uDusk.

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
