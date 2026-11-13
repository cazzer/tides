// A flash's light through the cloud (tides-ufyr.13, .13.1): an irregular
// soft patch of lit cloud, blue-white at its edge and whiter in its core,
// dimmed where the cloud map shows clear sky or the thickest cloud, added
// to what is behind it.
uniform float uGain;
uniform sampler2D uCloudMap;
// 1 where the map is one channel, its grey in R (cloudShaders.ts).
uniform float uCloudMapRed;
uniform float uCloudShift;
uniform float uClearFloor;
uniform float uThickFloor;

varying vec2 vUv;
varying float vI;
varying vec2 vCloudUv;
varying vec2 vNoiseOffset;

// [TUNE] The core's gain over the body's.
#define CORE_GAIN 0.6
#define EDGE_TINT vec3(0.55, 0.68, 1.0)
#define CORE_TINT vec3(0.92, 0.95, 1.0)

// Dave Hoskins' hash without sine.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), w.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), w.x),
    w.y);
}

void main() {
  // Taken while every pixel of the quad still runs.
  vec2 gx = dFdx(vCloudUv);
  vec2 gy = dFdy(vCloudUv);
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 || vI <= 0.0) discard;

  vec2 p = vUv * 2.5 + vNoiseOffset;
  float n = 0.65 * valueNoise(p) + 0.35 * valueNoise(p * 2.0 + 17.0);
  float rr = r2 * mix(0.55, 1.45, n);
  float body = exp(-3.0 * rr) * (1.0 - smoothstep(0.55, 1.0, r2)) * mix(0.7, 1.15, n);
  float core = exp(-18.0 * rr);

  // The cloud over the flash: little to light under clear sky, and the
  // thickest swallows some.
  vec4 c = textureGrad(uCloudMap, vec2(fract(vCloudUv.x - uCloudShift), clamp(vCloudUv.y, 0.0, 1.0)), gx, gy);
  float cover = uCloudMapRed > 0.5 ? c.r : c.g;
  float lit = mix(uClearFloor, 1.0, smoothstep(0.05, 0.6, cover));
  float tau = -log(1.0 - min(cover, 0.995));
  float thick = mix(1.0, uThickFloor, smoothstep(1.5, 4.0, tau));

  vec3 tint = mix(EDGE_TINT, CORE_TINT, core);
  gl_FragColor = vec4(tint * ((body + CORE_GAIN * core) * vI * uGain * lit * thick), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
