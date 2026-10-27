// Prominences and coronal loops as fibrous plasma. Premultiplied output:
// off the limb a strand glows (emission, no cover); across the disc a
// prominence is a dark filament (cover, little emission), as in H-alpha.
uniform float time;
varying vec3 vView;
varying vec3 vCentre;
varying float vRadius;
varying vec4 vStrand;
varying vec2 vKind;
varying float vFade;
varying float vSlant;

#include ../aurora/noise3.glsl

void main() {
  float t = vStrand.x;
  float side = vStrand.y;
  float seed = vStrand.w;
  float kind = vKind.x;
  float gain = vKind.y;

  // Where the Sun lies along this pixel's ray. The depth test hides strands
  // behind the Sun, but at the ship's ranges both can share a depth value,
  // so test the sphere here too (view space, the eye at the origin).
  vec3 ray = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(vView);
  vec3 rel = vView - vCentre;
  float b = dot(rel, ray);
  float miss = sqrt(max(dot(rel, rel) - b * b, 0.0)) / vRadius;
  float edge = max(fwidth(miss), 1e-4);
  float across = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, miss);
  // b > 0: the Sun is between the eye and the strand.
  if (b > 0.0 && across > 0.99) discard;
  float onDisc = b < 0.0 ? across : 0.0;

  float density;
  vec3 glow;
  if (kind < 1.5) {
    // Threads along the strand, clumped into knots that drift slowly
    // along it, as prominence material drains and refills.
    float soft = exp(-2.2 * side * side) * (1.0 - smoothstep(0.75, 1.0, abs(side)));
    float threads = snoise3(vec3(side * 2.4 + seed, t * 9.0, seed - time * 0.04));
    float knots = snoise3(vec3(t * (kind < 0.5 ? 3.5 : 1.6) - time * 0.08, seed * 1.7, side * 0.6));
    density = soft * smoothstep(-0.2, 0.9, 0.6 * threads + 0.6 * knots);
    // Feet sink into the chromosphere; hedgerow tips thin out.
    float ends = kind < 0.5
      ? smoothstep(0.0, 0.06, t) * smoothstep(0.0, 0.06, 1.0 - t)
      : smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.55, 1.0, t));
    density *= ends * gain;
    // Strands overlap and add, so each is dim: a dense knot reaches pink-white.
    glow = vec3(1.0, 0.5, 0.18) * 0.32;
  } else {
    // Coronal loops: soft, threaded and uneven, brightest in their legs and
    // fading toward the top, each one brightening and dimming on its own
    // over ~25 s while plasma runs along it.
    float core = exp(-4.0 * side * side) * (1.0 - smoothstep(0.5, 1.0, abs(side)));
    float threads = 0.5 + 0.5 * snoise3(vec3(side * 2.0 + seed, t * 5.0 - time * 0.12, seed));
    float legs = 0.45 + 0.55 * (1.0 - sin(3.14159265 * t));
    float pulse = 0.35 + 0.65 * smoothstep(-0.6, 0.8, sin(time * 0.25 + seed * 3.7));
    density = core * threads * legs * pulse * gain * smoothstep(0.0, 0.1, t) * smoothstep(0.0, 0.1, 1.0 - t);
    glow = vec3(1.0, 0.62, 0.28) * 0.05;
  }
  density *= vFade * (0.25 + 0.75 * vSlant);

  // In white light both vanish against the disc, but for the faintest
  // shadow of a filament (strands overlap, so this adds up several times).
  float filament = kind < 1.5 ? 0.012 : 0.0;
  vec3 emission = glow * density * (1.0 - (kind < 1.5 ? 1.0 : 0.65) * onDisc);
  float cover = density * filament * onDisc;
  if (cover + dot(emission, vec3(1.0)) < 0.002) discard;
  gl_FragColor = vec4(emission, cover);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
