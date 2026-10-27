// The Sun's sphere scaled out to its shell (sunShellScale), so the spicule
// fringe above the limb has pixels; the fragment shader finds the true
// sphere along each ray.
uniform float uShell;
// In the Sun's own frame (ephemeris.ts sunOrientation turns the mesh), so
// the baked detail rotates with the Sun and is the same on every date
// scrub, and the ray trace holds under any parent scale or squash.
varying vec3 vObject;

void main() {
  vObject = position * uShell;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vObject, 1.0);
}
