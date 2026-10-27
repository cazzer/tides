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
// Read only from inside (columnAheadOverSea()), so only the Earth's sets it.
uniform float uSeaLevel;
// The sky-view table (renderers/skyView.ts): only the Earth's, from inside.
uniform sampler2D uSkyView;
uniform vec2 uSkyViewSize;
uniform float uSkyViewOn;

varying vec3 vPos;
varying vec3 vRayOrigin;

#include ../shell/face.glsl

#include haze.glsl

void main() {
  vec3 ro = vRayOrigin;
  #ifdef DOUBLE_SIDED
  vec3 rd = normalize(vRayDir);
  #else
  vec3 rd = normalize(vPos - vRayOrigin);
  #endif
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
    column = columnAheadOverSea(ro, rd, grazing, at);
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

  gl_FragColor = vec4(hazeGlow(column, grazing, at, uSun, rd, ro), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
