// The Sun's disc in extreme ultraviolet, from the baked face (loops, glow,
// holes and filaments, network) and plasma (churn) cubes of sun-surface.ts:
// three lookups and arithmetic, at every quality tier and distance. Styled
// on SDO's gold 171 Å Sun rather than white light: structure that reads at
// whole-disc scale, and a limb that brightens instead of darkening.
uniform samplerCube uSurface;
uniform samplerCube uPlasma;
uniform float time;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vSolar;
varying vec3 vLayer0;
varying vec3 vLayer1;

// A gold ramp by brightness: deep red-brown in the holes, saturated
// orange-gold across the quiet Sun, toward white in the brightest loops
// (where the tone mapping's shoulder takes over).
vec3 gold(float x) {
  x = clamp(x, 0.0, 2.0);
  return vec3(x, 0.4 * pow(x, 1.6), 0.02 * pow(x, 4.0)) * 2.5;
}

void main() {
  vec3 s = normalize(vSolar);
  // View space, so it holds in both the perspective main view and the
  // panels, wherever the camera sits.
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float mu = clamp(dot(normalize(vNormal), eye), 0.0, 1.0);
  float limbward = 1.0 - mu;

  vec4 face = textureCube(uSurface, s);
  // Two turning copies of the plasma, so it churns rather than slides.
  float p0 = textureCube(uPlasma, vLayer0).r;
  float p1 = textureCube(uPlasma, vLayer1).g;
  // The two trade places over ~18 s, out of step from place to place, so
  // the plasma brightens and fades where it stands as well as drifting.
  float phase = time * 0.35 + 7.0 * (s.x * 0.71 + s.y * 1.13 + s.z * 0.83);
  float w = 0.5 + 0.5 * sin(phase);
  float churn = mix(p0, p1, w);
  float flicker = mix(p1, p0, w);

  // The quiet Sun: churning, mottled with the network.
  float I = 0.42 + 0.22 * face.a + 0.4 * (churn - 0.5);
  // Active regions on top, their loops brightening and dimming as the
  // plasma under them turns over.
  I += face.r * (1.35 + 1.0 * (flicker - 0.5)) + 0.35 * face.g;
  I *= face.b;

  // Optically thin: toward the limb the eye looks through more corona, so
  // the edge brightens into the glow beyond it (sun-corona/fragment.frag).
  I *= 0.88 + 0.75 * pow(limbward, 3.0);
  gl_FragColor = vec4(gold(I), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
