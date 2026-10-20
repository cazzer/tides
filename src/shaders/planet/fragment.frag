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

void main() {
  #ifdef USE_PLANET_MAP
  vec3 albedo = texture2D(uMap, vUv).rgb * uAlbedo;
  #else
  vec3 albedo = uColor * uAlbedo;
  #endif

  // On a sphere the unit normal is the position in planet radii.
  vec3 n = normalize(vNormalLocal);
  float cosI = max(dot(n, uSunDir), 0.0);
  vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  // Floored so the cos(e)^(k−1) term stays finite at the limb.
  float cosE = max(dot(normalize(vNormalView), viewDir), 0.05);
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
