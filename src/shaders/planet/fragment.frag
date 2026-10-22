// Planet surfaces (tides-kzj.2.4). The scene's directional sunlight is aimed
// at the Earth, so planets ignore scene lights and take the Sun's direction
// in their own frame (uSunDir). Shaded like the Moon's Phong material reads:
// albedo / π · (sunlight · direct + ambient), then tone-mapped.
//
// Limb darkening is Minnaert's: direct = cos(i)^k · cos(e)^(k−1). k = 1 is
// Lambert; k > 1 darkens the limb (thick atmospheres). The material keeps
// k ≥ 0.5: below that the cos(e)^(k−1) limb brightening runs away.
//
// With USE_RING_SHADOW, sunlight that crosses the ring plane (y = 0) on its
// way here is dimmed by the rings' opacity where it crosses.

#define RECIPROCAL_PI 0.3183098861837907

uniform vec3 uSunDir;
uniform vec3 uColor;
uniform float uAlbedo;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uMinnaert;
#ifdef USE_PLANET_MAP
uniform sampler2D uMap;

// Detail finer than the map (tides-01v.3), for close fly-bys: the ship
// stops at 1.02 R, where a 2k map's texel spans ~200 px. Keyed to the point
// on the unit sphere, so it has no dateline seam or polar pinch, and faded
// in by how many pixels a texel covers, so it's absent wherever the map
// isn't magnified. uDetailStyle picks the look (planetMaterials.ts).
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
      // in p, the slope needs no per-octave factor. It fades out an
      // octave before the albedo: a low Sun exaggerates its aliasing.
      float wb = gate * smoothstep(4.0, 8.0, wavelength / fp);
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
#endif
#ifdef USE_RING_SHADOW
#include ../ring/profile.glsl
// Planet radii.
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
#endif

varying vec2 vUv;
varying vec3 vNormalLocal;
varying vec3 vNormalView;
varying vec3 vViewPosition;
// The radius in view units.
varying float vRadiusView;

void main() {
  // On a sphere the unit normal is the position in planet radii.
  vec3 n = normalize(vNormalLocal);
  // Lit normal: n, or bumped by the detail.
  vec3 nLit = n;
  vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  // Floored so the cos(e)^(k−1) term stays finite at the limb.
  float cosE = max(dot(normalize(vNormalView), viewDir), 0.05);

  #ifdef USE_PLANET_MAP
  vec3 albedo = texture2D(uMap, vUv).rgb * uAlbedo;
  if (uDetailStyle != 0) {
    // n's footprint per pixel: a pixel's width where its ray meets the
    // surface, over the radius, foreshortened. Taken from values smooth
    // across the mesh's facets (dFdx(n) jumps at each edge, and would step
    // the octave weights there).
    float pixel = isOrthographic
      ? max(length(dFdx(vViewPosition.xy)), length(dFdy(vViewPosition.xy)))
      : max(length(dFdx(viewDir)), length(dFdy(viewDir))) * length(vViewPosition);
    float fp = pixel / (vRadiusView * cosE);
    float texel = 3.141592653589793 / float(textureSize(uMap, 0).y);
    float d;
    vec3 dh;
    planetDetail(n, fp, texel, d, dh);
    albedo *= max(0.0, 1.0 + uDetailStrength * d);
    // Tilted by the height's slope along the surface.
    if (uDetailBump > 0.0) nLit = normalize(n - uDetailBump * (dh - dot(dh, n) * n));
  }
  #else
  vec3 albedo = uColor * uAlbedo;
  #endif

  // Capped by the sphere's own, or bumps tilted sunward would speckle the
  // night side; unbumped (nLit = n), the cap never binds.
  float cosI = min(max(dot(nLit, uSunDir), 0.0), 4.0 * max(dot(n, uSunDir), 0.0));
  float direct = pow(cosI, uMinnaert) * pow(cosE, uMinnaert - 1.0);

  #ifdef USE_RING_SHADOW
  // The ray toward the Sun meets the ring plane only if it starts on the
  // other side of it from the Sun.
  if (n.y * uSunDir.y < 0.0) {
    vec2 hit = n.xz - (n.y / uSunDir.y) * uSunDir.xz;
    float r = length(hit);
    if (r >= uRingInner && r <= uRingOuter) {
      float u = (r - uRingInner) / (uRingOuter - uRingInner);
      direct *= 1.0 - uRingOpacity * ringAlpha(u);
    }
  }
  #endif

  vec3 irradiance = vec3(uSunIntensity * direct) + uAmbient;
  gl_FragColor = vec4(albedo * RECIPROCAL_PI * irradiance, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
