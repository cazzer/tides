// Planetary rings (tides-kzj.2.4), in the body's equatorial (XZ) plane.
varying vec2 vUv;
varying vec3 vPos;
#ifdef USE_LOMMEL_SEELIGER
// |cos| of the angle between the line of sight and the ring normal.
varying float vViewCos;
#endif

void main() {
  vUv = uv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #ifdef USE_LOMMEL_SEELIGER
  vec3 normalView = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
  vec3 viewDir = isOrthographic
    ? vec3(0.0, 0.0, 1.0)
    : normalize(-(modelViewMatrix * vec4(position, 1.0)).xyz);
  vViewCos = abs(dot(normalView, viewDir));
  #endif
}
