uniform float time;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;

mat2 rotate(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

void main() {
  // Three copies of the noise cube, each turning on its own axis, so the
  // surface churns instead of sliding.
  float t = time * .005;

  vec3 p0 = position;
  p0.yz = rotate(t) * p0.yz;
  vLayer0 = p0;

  vec3 p1 = position;
  p1.xz = rotate(t + .6) * p1.xz;
  vLayer1 = p1;

  vec3 p2 = position;
  p2.xy = rotate(t + 1.2) * p2.xy;
  vLayer2 = p2;

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
