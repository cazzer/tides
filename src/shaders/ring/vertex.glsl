// Planetary rings (tides-kzj.2.4), in the body's equatorial (XZ) plane.
varying vec2 vUv;
varying vec3 vPos;

void main() {
  vUv = uv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
