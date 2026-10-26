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
    float threads = snoise3(vec3(side * 2.4 + seed, t * 9.0, seed - time * 0.015));
    float knots = snoise3(vec3(t * (kind < 0.5 ? 3.5 : 1.6) - time * 0.03, seed * 1.7, side * 0.6));
    density = soft * smoothstep(-0.2, 0.9, 0.6 * threads + 0.6 * knots);
    // Feet sink into the chromosphere; hedgerow tips thin out.
    float ends = kind < 0.5
      ? smoothstep(0.0, 0.06, t) * smoothstep(0.0, 0.06, 1.0 - t)
      : smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.55, 1.0, t));
    density *= ends * gain;
    // Strands overlap and add, so each is dim: a dense knot reaches pink-white.
    glow = vec3(1.0, 0.26, 0.22) * 0.3;
  } else {
    // Coronal loops: fine, faint, smooth arcs with a little beading.
    float core = exp(-2.5 * side * side) * (1.0 - smoothstep(0.7, 1.0, abs(side)));
    float beads = 0.75 + 0.25 * snoise3(vec3(t * 7.0 - time * 0.05, seed, 0.0));
    density = core * beads * gain * smoothstep(0.0, 0.1, t) * smoothstep(0.0, 0.1, 1.0 - t);
    glow = vec3(1.0, 0.84, 0.64) * 0.045;
  }
  density *= vFade * (0.25 + 0.75 * vSlant);

  // In white light both vanish against the disc, but for the faintest
  // shadow of a filament (strands overlap, so this adds up several times).
  float filament = kind < 1.5 ? 0.012 : 0.0;
  vec3 emission = glow * density * (1.0 - onDisc);
  float cover = density * filament * onDisc;
  if (cover + dot(emission, vec3(1.0)) < 0.002) discard;
  gl_FragColor = vec4(emission, cover);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
