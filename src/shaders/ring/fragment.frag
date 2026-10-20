// Planetary rings (tides-kzj.2.4). u runs from the inner edge (0) to the
// outer (1). The particle layer is lit from either face by the Sun's height
// above the ring plane (|uSunDir.y|, so rings dim toward equinox), and is
// dark where the planet blocks the Sun.

#define RECIPROCAL_PI 0.3183098861837907

uniform vec3 uSunDir;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uPlanetRadius;
#ifdef USE_RING_MAP
uniform sampler2D uMap;
#endif

varying vec2 vUv;
varying vec3 vPos;

// Placeholder banding until a ring texture is given: a few ringlets and a
// gap about two thirds of the way out.
float bands(float u) {
  float ringlets = 0.75 + 0.25 * sin(u * 61.0) * sin(u * 17.0);
  float gap = smoothstep(0.0, 0.03, abs(u - 0.66));
  float edges = smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.96, u);
  return ringlets * gap * edges;
}

void main() {
  #ifdef USE_RING_MAP
  vec4 texel = texture2D(uMap, vec2(vUv.x, 0.5));
  vec3 albedo = texel.rgb;
  float alpha = texel.a;
  #else
  vec3 albedo = uColor;
  float alpha = bands(vUv.x);
  #endif

  // In the planet's shadow: behind it from the Sun, within its radius of
  // the Sun line.
  float along = dot(vPos, uSunDir);
  float offAxis = length(vPos - along * uSunDir);
  float lit = along < 0.0
    ? smoothstep(uPlanetRadius * 0.98, uPlanetRadius * 1.02, offAxis)
    : 1.0;

  vec3 irradiance = vec3(uSunIntensity * abs(uSunDir.y) * lit) + uAmbient;
  gl_FragColor = vec4(albedo * RECIPROCAL_PI * irradiance, alpha * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
