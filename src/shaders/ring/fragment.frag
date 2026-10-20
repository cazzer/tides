// Planetary rings (tides-kzj.2.4). u runs from the inner edge (0) to the
// outer (1). The particle layer is lit by the Sun's height above the ring
// plane (|uSunDir.y|, so rings dim toward equinox), is dark where the
// planet blocks the Sun, and is dimmer (uUnlitFace) seen from the side the
// Sun isn't on, where only light scattered through the layer reaches us.

#define RECIPROCAL_PI 0.3183098861837907

#include ./profile.glsl

uniform vec3 uSunDir;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uPlanetRadius;
uniform float uUnlitFace;

varying vec2 vUv;
varying vec3 vPos;

void main() {
  #ifdef USE_RING_MAP
  vec3 albedo = texture2D(uRingMap, vec2(vUv.x, 0.5)).rgb;
  #else
  vec3 albedo = uColor;
  #endif
  float alpha = ringAlpha(vUv.x);

  // In the planet's shadow: behind it from the Sun, within its radius of
  // the Sun line.
  float along = dot(vPos, uSunDir);
  float offAxis = length(vPos - along * uSunDir);
  float lit = along < 0.0
    ? smoothstep(uPlanetRadius * 0.98, uPlanetRadius * 1.02, offAxis)
    : 1.0;
  // The front face looks toward +Y (planetFrame.ts ringGeometry).
  float face = gl_FrontFacing == (uSunDir.y > 0.0) ? 1.0 : uUnlitFace;

  vec3 irradiance = vec3(uSunIntensity * abs(uSunDir.y) * lit * face) + uAmbient;
  gl_FragColor = vec4(albedo * RECIPROCAL_PI * irradiance, alpha * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
