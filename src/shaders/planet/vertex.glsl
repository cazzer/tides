// Planet surfaces (tides-kzj.2.4): lit in the body's own frame, where the
// sphere's normal is its position and the Sun direction is a uniform.
varying vec2 vUv;
varying vec3 vNormalLocal;
varying vec3 vNormalView;
varying vec3 vViewPosition;

void main() {
  vUv = uv;
  vNormalLocal = normal;
  vNormalView = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
