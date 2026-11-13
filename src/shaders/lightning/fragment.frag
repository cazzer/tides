// A flash's light through the cloud (tides-ufyr.13, .13.1): an irregular
// patch of lit cloud, three noise-warped lobes with a ragged edge and
// cell-like mottling inside, blue-white at its edge and whiter in its core,
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
varying vec4 vLobes;
varying vec4 vLobe3;
varying vec3 vLobeK;

// [TUNE] The core's gain over the body's.
#define CORE_GAIN 0.6
// [TUNE] The edge noise's cells across the quad's half-width, and the
// finer octave's (the mottling's) over it.
#define NOISE_FREQ 4.5
#define FINE_FREQ 2.3
// Where the window toward the quad's edge starts (r²): past every lobe
// (LOBE_REACH in the vertex shader), so it only trims the noise's reach.
#define LOBE_WINDOW 0.72
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

  vec2 p = vUv * NOISE_FREQ + vNoiseOffset;
  // The finer octave turned off the lattice, so its cells don't line up in a grid.
  float fine = valueNoise(mat2(0.8, -0.6, 0.6, 0.8) * p * FINE_FREQ + 17.0);
  float n = 0.6 * valueNoise(p) + 0.4 * fine;
  // Each lobe's falloff warped by the noise (a ragged edge), the sum
  // thresholded so the outline is sharp enough to show the lobes.
  float warp = mix(0.25, 2.0, n);
  vec2 d0 = vUv - vLobes.xy;
  vec2 d1 = vUv - vLobes.zw;
  vec2 d2 = vUv - vLobe3.xy;
  float q0 = dot(d0, d0) * vLobeK.x;
  float field = exp(-2.5 * warp * q0)
    + vLobe3.z * exp(-2.5 * warp * dot(d1, d1) * vLobeK.y)
    + vLobe3.w * exp(-2.5 * warp * dot(d2, d2) * vLobeK.z);
  float edge = smoothstep(0.08, 0.3, field) * (1.0 - smoothstep(LOBE_WINDOW, 1.0, r2));
  // Cloud tops lit from below: cells, brighter and darker.
  float mottle = mix(0.5, 1.2, smoothstep(0.1, 0.9, fine));
  float body = field * edge * mottle;
  // The core, in the main (brightest) lobe.
  float core = exp(-7.0 * q0 * mix(0.6, 1.4, n)) * edge;

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
