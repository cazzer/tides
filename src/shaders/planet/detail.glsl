// The procedural detail finer than a globe's map (tides-01v.3), shared by
// the planets' and moons' surface shader (./fragment.frag) and Earth's
// Moon's Phong patch (renderers/moonDetail.ts, tides-ufyr.3). It reads
// three's isOrthographic; the includer may set PLANET_DETAIL_OCTAVES and
// PLANET_BAND_OCTAVES (the bands' own, by default the same) first, and
// PLANET_DETAIL_FLOW with its DETAIL_FLOW_* constants (planetMaterials.ts).
#include ../aurora/noise3.glsl

#ifndef PLANET_DETAIL_OCTAVES
#define PLANET_DETAIL_OCTAVES 5
#endif
#ifndef PLANET_BAND_OCTAVES
#define PLANET_BAND_OCTAVES PLANET_DETAIL_OCTAVES
#endif
#if PLANET_BAND_OCTAVES > PLANET_DETAIL_OCTAVES
#define PLANET_DETAIL_LOOP PLANET_BAND_OCTAVES
#else
#define PLANET_DETAIL_LOOP PLANET_DETAIL_OCTAVES
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
void planetDetailNoise(vec3 n, float fp, float texel, out float d, out vec3 dh) {
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

  // The bands take more octaves, for the ship's dive to their cloud tops
  // (tides-ufyr.8.2).
  int octaves = (rock || streaks) ? PLANET_DETAIL_OCTAVES : PLANET_BAND_OCTAVES;
  // Every octave's full amplitude, faded or not; for the bands' extra
  // octaves, only the first PLANET_DETAIL_OCTAVES', so their contrast from
  // range is as it was and the extras add a touch close in.
  float total = (1.0 - pow(gain, float(min(octaves, PLANET_DETAIL_OCTAVES)))) / (1.0 - gain);
  float amp = 1.0;
  // The height's gradient in p, over the first wavelength.
  vec3 slope = vec3(0.0);
  for (int i = 0; i < PLANET_DETAIL_LOOP; i++) {
    if (i == octaves) break;
    float w = gate * smoothstep(2.0, 4.0, wavelength / fp);
    // The wavelengths only shrink, so once an octave has faded out so have
    // the rest (and the bump's, which fades first). Not w == 0.0: a NaN
    // footprint skips them too.
    if (!(w > 0.0)) break;
    vec3 g;
    float s = snoise3(p + float(i) * 7.31, g);
    d += w * amp * s;
    // Height scales with wavelength, so every octave is as steep and,
    // in p, the slope needs no per-octave factor. It fades out about an
    // octave before the albedo: rock's ridges come at half the
    // wavelength, and a low Sun exaggerates their aliasing.
    float wb = gate * smoothstep(5.0, 10.0, wavelength / fp);
    slope += wb * amp * (rock ? -2.0 * s : 1.0) * g;
    amp *= gain;
    wavelength /= 2.5;
    p *= 2.5;
  }
  d /= total;
  // Back to n: through the warp, then the squash and the first wavelength,
  // which cancels the one in slope.
  dh = vec3(1.0, squash, 1.0) * (slope + warpGrad * slope.y) / total;
}

#ifdef PLANET_DETAIL_FLOW
// The bands' detail carried by the zonal winds (tides-ufyr.8.2), mirrored in
// planetMaterials.ts (bandFlowRate, bandFlowPhases). Seconds, wrapped to
// DETAIL_FLOW_CYCLES periods (detailFlowTime).
uniform float uDetailTime;

// n turned about the pole (+Y) by t seconds of its latitude's wind: as on
// Jupiter and Saturn, a prograde jet on the equator, reversing at ±15° and
// alternating poleward every 30°, mirrored across the equator and still at
// the poles. cs is the turn's cos and sin, to turn the gradient back.
vec3 detailFlowTurn(vec3 n, float t, out vec2 cs) {
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float a = t * DETAIL_FLOW_RATE * cos(lat) * cos(6.0 * lat);
  cs = vec2(cos(a), sin(a));
  return vec3(n.x * cs.x - n.z * cs.y, n.y, n.z * cs.x + n.x * cs.y);
}

// One of two phases half a period apart. Its noise is carried for up to a
// period, so the shear stays bounded, then restarts from a fresh offset (a
// hash of its cycle, so the pattern doesn't repeat each period) where its
// triangle weight is 0, so the restart doesn't show. The key is even for
// one phase and odd for the other, which would otherwise share a cycle for
// half of every period, and so an offset.
void detailFlowPhase(vec3 n, float fp, float texel, float shift,
                     out float w, out float d, out vec3 dh) {
  float cycles = uDetailTime / DETAIL_FLOW_PERIOD + shift;
  float f = fract(cycles);
  w = 1.0 - abs(2.0 * f - 1.0);
  float key = 2.0 * mod(floor(cycles), DETAIL_FLOW_CYCLES) + 2.0 * shift;
  vec3 offset = DETAIL_FLOW_OFFSET
    * (fract(key * vec3(0.7548777, 0.5698403, 0.4142136)) - 0.5);
  vec2 cs;
  vec3 m = detailFlowTurn(n, f * DETAIL_FLOW_PERIOD, cs);
  vec3 g;
  planetDetailNoise(m + offset, fp, texel, d, g);
  // Back through the turn (the shear's own term is negligible).
  dh = vec3(g.x * cs.x + g.z * cs.y, g.y, g.z * cs.x - g.x * cs.y);
}
#endif

void planetDetail(vec3 n, float fp, float texel, out float d, out vec3 dh) {
#ifdef PLANET_DETAIL_FLOW
  if (uDetailStyle == DETAIL_BANDS) {
    float w1, d1, w2, d2;
    vec3 dh1, dh2;
    detailFlowPhase(n, fp, texel, 0.0, w1, d1, dh1);
    detailFlowPhase(n, fp, texel, 0.5, w2, d2, dh2);
    // The weights sum to 1. Over their root sum of squares, as the phases'
    // noise is uncorrelated, so the contrast holds through the fade.
    float norm = inversesqrt(w1 * w1 + w2 * w2);
    d = (w1 * d1 + w2 * d2) * norm;
    dh = (w1 * dh1 + w2 * dh2) * norm;
    return;
  }
#endif
  planetDetailNoise(n, fp, texel, d, dh);
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
