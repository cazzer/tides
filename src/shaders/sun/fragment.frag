// The photosphere, from the baked surface (granules, spots, faculae) and
// plasma (churn) cubes of sun-surface.ts: three lookups and arithmetic, at
// every quality tier and distance. White-light features, with the churn
// between granule and disc scale that a whole-disc view needs, and
// brightness read as temperature, so the disc has depth and colour.
uniform samplerCube uSurface;
uniform samplerCube uPlasma;
uniform float time;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vSolar;
varying vec3 vLayer0;
varying vec3 vLayer1;

// A gas's colour by its brightness: hotter is brighter and whiter, cooler
// dimmer and redder, so every change in brightness also shifts the hue.
vec3 heat(float x) {
  x = clamp(x, 0.0, 1.25);
  float x2 = x * x;
  return vec3(x, x2, x2 * x2) * 4.0;
}

void main() {
  vec3 s = normalize(vSolar);
  // View space, so it holds in both the ortho main view and the perspective
  // panels, wherever the camera sits.
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float mu = clamp(dot(normalize(vNormal), eye), 0.0, 1.0);
  float limbward = 1.0 - mu;

  vec4 surface = textureCube(uSurface, s);
  // Two turning copies of the plasma, so it churns rather than slides.
  float churn = 0.5 * (textureCube(uPlasma, vLayer0).r + textureCube(uPlasma, vLayer1).g);

  // Granules boil: the two baked patterns trade places over ~40 s, out of
  // step from place to place, so cells fade and form rather than slide.
  float phase = time * 0.16 + 9.0 * (s.x * 0.71 + s.y * 1.13 + s.z * 0.83);
  float w = 0.5 + 0.5 * sin(phase);
  float granules = mix(surface.r, surface.g, w * w * (3.0 - 2.0 * w)) - 0.6;

  // Granulation shows at disc centre and washes out toward the limb, where
  // the faculae (bright plage, invisible face-on) take over.
  float I = 1.0 + 0.5 * granules * (0.3 + 0.7 * mu);
  I *= 0.95 + 0.7 * (churn - 0.5);
  I += surface.a * (0.04 + 0.7 * limbward * limbward);
  I *= surface.b;

  // Limb darkening, steeper than the Sun's for a rounder disc; the heat ramp
  // turns it, and the spots, redder as well as dimmer.
  float x = 0.5 * I * (0.32 + 0.68 * pow(mu, 0.45));
  gl_FragColor = vec4(heat(x), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
