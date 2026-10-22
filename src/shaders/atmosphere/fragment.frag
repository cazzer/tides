// Atmosphere limb glow (tides-qe5): a thin scattering haze, brightest where
// the line of sight grazes the sunlit limb, warming toward the terminator.
// The column of an exponential atmosphere is estimated analytically (no
// march, so no banding): a ray that misses the surface at closest radius p
// crosses sqrt(2πpH)·exp(−(p−R)/H) of it. Over the disc it is faded out
// just inside the limb rather than drawn as H/cos(z): the day side is
// already bright, and a full haze washes it out. Lit where it is thickest.
// Shared by the Earth (AtmosphereRenderer) and the planets (PlanetAtmosphere),
// which pass their own sky and dusk colours (linear RGB). Only the Earth's is
// ever double-sided (ship mode), and so drawn from inside (tides-01v.8.2).

uniform float uSurface;
uniform float uOuter;
uniform float uScaleHeight;
uniform vec3 uSun;
uniform float uGain;
uniform vec3 uSky;
uniform vec3 uDusk;

varying vec3 vPos;
varying vec3 vRayOrigin;

#include ../shell/face.glsl

#ifdef DOUBLE_SIDED
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
#endif

void main() {
  vec3 ro = vRayOrigin;
  vec3 rd = normalize(vPos - vRayOrigin);
  float H = uScaleHeight;

  float b = dot(ro, rd);
  float c2 = dot(ro, ro) - b * b; // squared closest-approach radius
  float grazing = sqrt(6.2831853 * uSurface * H);
  float p = sqrt(c2);
  vec3 at;
  float column;
  float hs = uSurface * uSurface - c2;
  #ifdef DOUBLE_SIDED
  bool back = shellBackFace(ro, rd, uOuter);
  if (gl_FrontFacing == back) discard;
  if (back) {
    column = columnAhead(ro, rd, grazing, at);
  } else
  #endif
  if (hs > 0.0) {
    // In front of the disc: fade out within a few scale heights of the limb
    // so the day side keeps its colours.
    at = ro + rd * (-b - sqrt(hs));
    column = grazing * exp(-(uSurface - p) / (1.5 * H));
  } else {
    at = ro - rd * b;
    column = grazing * sqrt(p / uSurface) * exp(-(p - uSurface) / H);
  }

  float mu = dot(normalize(at), uSun);
  float lit = smoothstep(-0.18, 0.12, mu);
  // Low sun reddens the light reaching this part of the haze.
  float dusk = 1.0 - smoothstep(0.0, 0.35, mu);
  float glow = (column / grazing) * lit * uGain;
  // Compress the brightness, not each channel, so the limb stays blue.
  vec3 col = mix(uSky, uDusk, dusk * 0.6) * (glow / (1.0 + glow));
  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
