// The procedural detail finer than a globe's map (tides-01v.3), shared by
// the planets' and moons' surface shader (./fragment.frag) and Earth's
// Moon's Phong patch (renderers/moonDetail.ts, tides-ufyr.3). It reads
// three's isOrthographic; the includer may set PLANET_DETAIL_OCTAVES first.
#include ../aurora/noise3.glsl

#ifndef PLANET_DETAIL_OCTAVES
#define PLANET_DETAIL_OCTAVES 5
#endif
#define DETAIL_BANDS 1
#define DETAIL_ROCK 2
#define DETAIL_STREAKS 3

uniform int uDetailStyle;
uniform float uDetailStrength;
uniform float uDetailBump;

// fp is n's footprint per pixel and texel the map's, both in radians. d is
// albedo detail in about [-1, 1], dh the gradient (in n) of a matching
// height in radii, for the bump. Rock's height is ridged, −s², with crests
// where s crosses 0; its slope −2s·∇s stays rounded across them.
// Each octave fades out before its wavelength shrinks to 2 px, so nothing
// sparkles, and the sum is normalised by the full amplitudes, so a fading
// octave lowers the contrast instead of boosting the rest.
void planetDetail(vec3 n, float fp, float texel, out float d, out vec3 dh) {
  d = 0.0;
  dh = vec3(0.0);
  // 0 until a texel spans 2 px, 1 from 8 px.
  float gate = smoothstep(1.0, 3.0, log2(texel / fp));
  if (gate == 0.0) return;

  bool rock = uDetailStyle == DETAIL_ROCK;
  bool streaks = uDetailStyle == DETAIL_STREAKS;
  // Gas giants and Venus: noise squashed along the axis, so near the
  // equator it stretches along the bands and toward the poles turns
  // isotropic (it can't pinch), then warped once so the bands flow.
  float squash = rock ? 1.0 : (streaks ? 6.0 : 3.0);
  float warp = rock ? 0.0 : (streaks ? 0.3 : 0.8);
  float gain = streaks ? 0.4 : 0.5;

  float wavelength = 2.0 * texel;
  vec3 p = vec3(n.x, n.y * squash, n.z) / wavelength;
  // ∇ of the warp in p, for the chain rule below.
  vec3 warpGrad = vec3(0.0);
  if (warp > 0.0) {
    p.y += warp * snoise3(p * 0.35 + 17.0, warpGrad);
    warpGrad *= warp * 0.35;
  }

  float amp = 1.0;
  float total = 0.0;
  // The height's gradient in p, over the first wavelength.
  vec3 slope = vec3(0.0);
  for (int i = 0; i < PLANET_DETAIL_OCTAVES; i++) {
    total += amp;
    float w = gate * smoothstep(2.0, 4.0, wavelength / fp);
    if (w > 0.0) {
      vec3 g;
      float s = snoise3(p + float(i) * 7.31, g);
      d += w * amp * s;
      // Height scales with wavelength, so every octave is as steep and,
      // in p, the slope needs no per-octave factor. It fades out about an
      // octave before the albedo: rock's ridges come at half the
      // wavelength, and a low Sun exaggerates their aliasing.
      float wb = gate * smoothstep(5.0, 10.0, wavelength / fp);
      slope += wb * amp * (rock ? -2.0 * s : 1.0) * g;
    }
    amp *= gain;
    wavelength /= 2.5;
    p *= 2.5;
  }
  d /= total;
  // Back to n: through the warp, then the squash and the first wavelength,
  // which cancels the one in slope.
  dh = vec3(1.0, squash, 1.0) * (slope + warpGrad * slope.y) / total;
}

// n's footprint per pixel: a pixel's width where its ray meets the surface,
// over the radius, foreshortened. Taken from values smooth across the mesh's
// facets (dFdx(n) jumps at each edge, and would step the octave weights
// there). viewPosition points from the surface to the eye, view space.
// Takes derivatives: call it only from uniform control flow.
float planetDetailFootprint(vec3 viewPosition, vec3 normalView, float radiusView) {
  vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(viewPosition);
  float pixel = isOrthographic
    ? max(length(dFdx(viewPosition.xy)), length(dFdy(viewPosition.xy)))
    : max(length(dFdx(viewDir)), length(dFdy(viewDir))) * length(viewPosition);
  // Not a floored cos(e): the floor would shrink fp at the limb, where the
  // foreshortening must fade the fine octaves out.
  float cosF = max(dot(normalize(normalView), viewDir), 1e-3);
  return pixel / (radiusView * cosF);
}
