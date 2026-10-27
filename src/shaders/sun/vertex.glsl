uniform float time;
varying vec3 vNormal;
varying vec3 vViewPosition;
// The Sun's own frame (ephemeris.ts sunOrientation turns the mesh), so the
// baked detail rotates with the Sun and is the same on every date scrub.
varying vec3 vSolar;
// The plasma's two reading frames, each turning slowly on its own axis,
// so their sum churns instead of sliding.
varying vec3 vLayer0;
varying vec3 vLayer1;

mat2 rotate(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

void main() {
  vSolar = normal;
  float t = time * 0.015;
  vLayer0 = normal;
  vLayer0.yz = rotate(t) * vLayer0.yz;
  vLayer1 = normal;
  vLayer1.xz = rotate(0.6 - 0.8 * t) * vLayer1.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
