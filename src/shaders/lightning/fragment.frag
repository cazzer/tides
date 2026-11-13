// A flash's glow through the cloud (tides-ufyr.13): a soft blue-white disc,
// added to what is behind it.
uniform float uGain;

varying vec2 vUv;
varying float vI;

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0 || vI <= 0.0) discard;
  gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * (exp(-4.0 * r2) * vI * uGain), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
