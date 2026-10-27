// Bakes the photosphere's mid-scale churn once (sun-surface.ts): the
// plasma that gives a whole-disc view its depth, between the granules (too
// fine to see there) and the disc itself.
//   r, g: two soft, billowy fields; the surface shader reads them through
//         slowly turning frames and cross-fades them, so they churn rather
//         than slide. Smooth noise, not |noise|: the creases of the latter
//         read as squiggly lines on the disc.
// Directions are in the Sun's frame (+Y the pole).
varying vec3 vDirection;

#include ../aurora/noise3.glsl

// Smooth fractal noise: billows at every scale, centred on zero.
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise3(p);
    p = p * 2.03 + 7.1;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  vec3 n = normalize(vDirection);

  // Warped first, so the billows swirl.
  vec3 warp = vec3(snoise3(n * 2.2), snoise3(n * 2.2 + 19.0), snoise3(n * 2.2 + 37.0));
  float a = fbm(n * 2.4 + 0.6 * warp);
  float b = fbm(n * 2.4 + 0.6 * warp.zxy + 23.0);
  gl_FragColor = vec4(clamp(0.5 + vec2(a, b) * 0.9, 0.0, 1.0), 0.5, 1.0);
}
