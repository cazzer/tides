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
#include ./detail.glsl
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
    float fp = planetDetailFootprint(vViewPosition, vNormalView, vRadiusView);
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
