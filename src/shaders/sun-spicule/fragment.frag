// A spicule blade, premultiplied as the prominences are: off the limb it
// glows; against the disc it is a faint dark streak of cooler plasma.
varying vec3 vView;
varying vec3 vCentre;
varying float vRadius;
varying vec2 vUv;
varying float vFade;
varying float vDisc;
uniform float uFringe; // SUN_FRINGE

// [TUNE] How much a blade dims the disc behind it: thousands overlap there.
const float ON_DISC_COVER = 0.12;

void main() {
  // Where the Sun lies along this pixel's ray: as for the prominences, the
  // depth test alone can tie at the ship's ranges (view space, the eye at
  // the origin).
  vec3 ray = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(vView);
  vec3 rel = vView - vCentre;
  float b = dot(rel, ray);
  float miss = sqrt(max(dot(rel, rel) - b * b, 0.0)) / vRadius;
  // b > 0: the Sun is between the eye and the blade.
  if (b > 0.0 && miss < 0.999) discard;
  // The limb's traced fringe (SUN_FRINGE) counts as disc: a blade in
  // front of it shows dark, not as a glow piled on its gold.
  float onDisc = b < 0.0 ? 1.0 - smoothstep(0.999, 1.0 + uFringe, miss) : 0.0;

  float core = 1.0 - abs(vUv.x);
  float density = core * core * (1.0 - vUv.y * 0.6) * vFade;
  density *= mix(1.0, vDisc, onDisc);
  vec3 emission = vec3(1.0, 0.55, 0.2) * 0.35 * density * (1.0 - onDisc);
  float cover = density * mix(0.15, ON_DISC_COVER, onDisc);
  emission += vec3(0.5, 0.16, 0.02) * 0.4 * cover * onDisc;
  if (cover + dot(emission, vec3(1.0)) < 0.002) discard;
  gl_FragColor = vec4(emission, cover);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
