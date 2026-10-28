// The Sun's sphere scaled out to its shell (sunShellScale) toward the
// silhouette, so the spicule fringe above the limb has pixels; the fragment
// shader finds the true sphere along each ray. Facing the eye it keeps the
// sphere's own radius: no fringe stands there, and a shell pushed out under
// the ship at its stop would come within the near plane's reach.
uniform float uShell;
uniform vec3 uEyeObject;
uniform vec3 uDirObject;
// In the Sun's own frame (ephemeris.ts sunOrientation turns the mesh), so
// the baked detail rotates with the Sun and is the same on every date
// scrub, and the ray trace holds under any parent scale or squash.
varying vec3 vObject;

void main() {
  vec3 toEye = isOrthographic ? -uDirObject : normalize(uEyeObject - position);
  // A tangent ray through the fringe crosses the shell where this is ~0.03.
  float facing = dot(normalize(position), toEye);
  vObject = position * mix(uShell, 1.0, smoothstep(0.2, 0.5, facing));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vObject, 1.0);
}
