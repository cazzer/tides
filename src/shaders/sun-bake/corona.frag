// Bakes the corona's pattern once (sun-surface.ts): every corona feature is
// a function of the outward direction alone, so it all fits in one cube
// and the corona costs a single lookup per pixel (sun-corona/fragment.frag).
//   r: streamer activity, broad: high over the active belts' streamers;
//   g: fine radial striation (the rays and the polar plumes);
//   b: the spicule fringe of the chromosphere.
// Signed values are stored as 0.5 + 0.5 * v.
varying vec3 vDirection;

#include ../aurora/noise3.glsl

void main() {
  vec3 n = normalize(vDirection);
  float activity = 0.65 * snoise3(n * 1.7 + 3.0) + 0.35 * snoise3(n * 3.6 + 11.0);
  float rays = 0.7 * snoise3(n * 26.0) + 0.3 * snoise3(n * 61.0);
  float spicules = snoise3(n * 95.0);
  gl_FragColor = vec4(0.5 + 0.5 * vec3(activity, rays, spicules), 1.0);
}
