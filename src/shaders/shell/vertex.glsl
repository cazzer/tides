// Ray-marched shells around the Earth (aurora, atmosphere; tides-qe5). Done in
// the Earth's local frame so the fragment shaders can march through the shell
// in geographic terms.
varying vec3 vPos;
// Perspective: the camera position. Orthographic (the main view): a point
// well behind the fragment along the view direction.
varying vec3 vRayOrigin;

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
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
