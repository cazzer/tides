// Planet surfaces (tides-kzj.2.4). The scene's directional sunlight is aimed
// at the Earth, so planets ignore scene lights and take the Sun's direction
// in their own frame (uSunDir). Shaded like the Moon's Phong material reads:
// albedo / π · (sunlight · cos i + ambient), then tone-mapped.
//
// Limb darkening is Minnaert's: cos(i)^k · cos(e)^(k−1). k = 1 is Lambert;
// k > 1 darkens the limb (thick atmospheres), k < 1 flattens the disc.

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

  float cosI = max(dot(normalize(vNormalLocal), uSunDir), 0.0);
  vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  // Floored so k < 1 doesn't blow up at the limb.
  float cosE = max(dot(normalize(vNormalView), viewDir), 0.05);
  float direct = pow(cosI, uMinnaert) * pow(cosE, uMinnaert - 1.0);

  vec3 irradiance = vec3(uSunIntensity * direct) + uAmbient;
  gl_FragColor = vec4(albedo * RECIPROCAL_PI * irradiance, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
