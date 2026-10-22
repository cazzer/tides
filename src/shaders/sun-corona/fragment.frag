uniform float time;
varying vec2 vPlane;
varying float vOuter;
// Fades the perspective corona out near the camera plane (vertex.glsl).
varying float vFade;

#include ../aurora/noise3.glsl

void main() {
  // r is in solar radii from the centre; x is the height above the limb.
  float r = length(vPlane);
  float x = max(r - 1.0, 0.0);
  vec2 d = vPlane / max(r, 1e-4);
  float t = time * 0.02;

  // Streamers: noise around the limb, stretched outward, drifting slowly.
  float s = 0.6 * snoise3(vec3(d * 1.8, t + 0.25 * r))
          + 0.4 * snoise3(vec3(d * 4.5, 1.7 * t + 10.0));

  // At the limb the glow matches the darkened, reddened edge of the disk, so
  // the two meet without a bright ring; then it falls away steeply...
  float inner = 0.2 * exp(-x / 0.04) + 0.17 * exp(-x / 0.15);
  // ...into a faint, wide haze that carries the streamers.
  float haze = 0.08 * exp(-x / 0.5) * (1.0 + 0.5 * s * smoothstep(1.0, 1.3, r));
  float fade = 1.0 - smoothstep(1.0 + 0.4 * (vOuter - 1.0), vOuter, r);
  float I = (inner + haze) * fade * vFade;

  vec3 col = mix(vec3(1.0, 0.3, 0.05), vec3(1.0, 0.62, 0.35), smoothstep(1.0, 1.6, r));
  gl_FragColor = vec4(col * I, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
