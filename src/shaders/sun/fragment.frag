uniform samplerCube uPerlin;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;

float supersun() {
  float sum = 0.0;
  sum += textureCube(uPerlin, vLayer0).r;
  sum += textureCube(uPerlin, vLayer1).r;
  sum += textureCube(uPerlin, vLayer2).r;
  return sum * .33;
}

void main() {
  // View space, so it holds in both the ortho main view and the perspective
  // panels, wherever the camera sits.
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
  float mu = clamp(dot(normalize(vNormal), eye), 0.0, 1.0);

  // Limb darkening: at the edge we see cooler, higher gas, so it's dimmer...
  float I = 1.0 - 0.75 * (1.0 - mu);
  float b = min((supersun() * 3. + 1.7) * .25, 1.0);
  // ...and redder: a cooler blackbody loses green and blue faster than red.
  b *= mix(0.45, 1.0, mu);

  // Bright enough that the centre sits in ACES's shoulder, white-yellow.
  gl_FragColor = vec4(vec3(b, b * b, b * b * b * b) * 4.0 * I, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
