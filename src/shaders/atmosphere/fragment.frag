// Atmosphere limb glow (tides-qe5): a thin scattering haze, brightest where
// the line of sight grazes the sunlit limb, warming toward the terminator.
// The column of an exponential atmosphere is estimated analytically (no
// march, so no banding): a ray that misses the surface at closest radius p
// crosses sqrt(2πpH)·exp(−(p−R)/H) of it. Over the disc it is faded out
// just inside the limb rather than drawn as H/cos(z): the day side is
// already bright, and a full haze washes it out. Lit where it is thickest.
// Shared by the Earth (AtmosphereRenderer) and the planets (PlanetAtmosphere),
// which pass their own sky and dusk colours (linear RGB).

uniform float uSurface;
uniform float uOuter;
uniform float uScaleHeight;
uniform vec3 uSun;
uniform float uGain;
uniform vec3 uSky;
uniform vec3 uDusk;

varying vec3 vPos;
varying vec3 vRayOrigin;

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
