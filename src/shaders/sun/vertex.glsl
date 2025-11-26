uniform float time;
varying vec2 vUv;
varying vec3 vPosition;
uniform vec2 pixels;
varying vec3 vNormal;
varying vec3 vLayer0;
varying vec3 vLayer1;
varying vec3 vLayer2;
varying vec3 vEyeVector;
varying vec3 vWorldPosition;
float PI = 3.1415926535897932384626433832795;

mat2 rotate( float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

void main() {
  // Calculate world position
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  
  // Calculate eye vector in world space
  vEyeVector = normalize(cameraPosition - vWorldPosition);
  
  // Transform normal to world space
  vNormal = normalize(normalMatrix * normal);

  float t = time * .005;

  vec3 p0 = position;
  mat2 rot1 = rotate(t);
  p0.yz = rot1*p0.yz;
  vLayer0 = p0;

  vec3 p1 = position;
  mat2 rot2 = rotate(t + .6);
  p1.xz = rot2*p1.xz;
  vLayer1 = p1;

  vec3 p2 = position;
  mat2 rot3 = rotate(t + 1.2);
  p2.xy = rot3*p2.xy;
  vLayer2 = p2;

  vUv = uv;
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
