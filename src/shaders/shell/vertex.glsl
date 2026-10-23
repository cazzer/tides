// Ray-marched shells around the Earth (aurora, atmosphere; tides-qe5) and the
// planets (PlanetAtmosphere; tides-kzj.2.4). Done in the body's local frame so
// the fragment shaders can march through the shell in geographic terms.
varying vec3 vPos;
// Perspective: the camera position. Orthographic (the main view): a point
// well behind the fragment along the view direction.
varying vec3 vRayOrigin;
#ifdef DOUBLE_SIDED
// Both faces drawn (Earth's shells in ship mode, earth-shells.ts): the
// fragment's depth in front of the camera and the near plane's, so face.glsl
// can tell where the near plane clips the front faces, and the ray from the
// eye through it.
varying vec3 vRayDir;
varying float vViewDepth;
varying float vNear;
#endif

uniform float uOuter;

void main() {
  vPos = position;
  mat4 toLocal = inverse(modelMatrix);
  bool ortho = projectionMatrix[3][3] == 1.0;
  if (ortho) {
    // World-space camera forward is −Z of the camera's world matrix.
    vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec3 dir = normalize((toLocal * vec4(forward, 0.0)).xyz);
    vRayOrigin = position - dir * (4.0 * uOuter);
  } else {
    vRayOrigin = (toLocal * vec4(cameraPosition, 1.0)).xyz;
  }
  #ifdef DOUBLE_SIDED
  // Here the camera can sit a hair off the shell, and world positions,
  // thousands of units out at the flight scale, would bury that gap in
  // rounding (tides-01v.8.11). View space (modelViewMatrix, formed by three
  // in double) keeps it, so the eye and the ray come from there, as the
  // cloud layer's do; the transpose inverts it as the Earth group is
  // unscaled. The eye is the same at every vertex, and the ray is the
  // pixel's own view ray (gl_Position comes from the same view, so rounding
  // moves the facet, not the ray), so both faces judge a ray alike in
  // face.glsl.
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  mat3 viewToLocal = transpose(mat3(modelViewMatrix));
  if (!ortho) vRayOrigin = -(viewToLocal * modelViewMatrix[3].xyz);
  vRayDir = ortho ? position - vRayOrigin : viewToLocal * view.xyz;
  vViewDepth = -view.z;
  vNear = ortho ? 0.0 : projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  gl_Position = projectionMatrix * view;
  #else
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
