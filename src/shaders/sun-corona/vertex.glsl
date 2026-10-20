// A camera-facing quad around the Sun, sized from its silhouette so the glow
// hugs the limb in the ortho main view and the perspective panels alike.
uniform float uRadius;
varying vec2 vPlane;
varying float vOuter;

void main() {
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 w = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-c);
  // Screen up, unless the Sun sits straight above or below the eye.
  vec3 up = abs(w.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 u = normalize(cross(up, w));
  vec3 v = cross(w, u);

  // Apparent radius: in perspective the silhouette is the tangent circle,
  // a little wider than the radius at the centre's depth.
  float limb = isOrthographic
    ? uRadius
    : uRadius * inversesqrt(max(1.0 - uRadius * uRadius / dot(c, c), 1e-4));
  // Perspective panels show the Sun ~43x real size; a 3R corona would fill
  // the sky.
  float outer = isOrthographic ? 3.0 : 1.6;

  vPlane = position.xy * outer;
  vOuter = outer;
  gl_Position = projectionMatrix * vec4(c + (u * vPlane.x + v * vPlane.y) * limb, 1.0);
}
