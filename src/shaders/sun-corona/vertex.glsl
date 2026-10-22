// A quad around the Sun in the image plane, sized and centred on its
// silhouette so the glow hugs the limb in the ortho main view and the
// perspective panels alike.
uniform float uRadius;
// CORONA_MAX_ANGLE (src/renderers/corona-geometry.ts).
uniform float uMaxAngle;
varying vec2 vPlane;
varying float vOuter;

void main() {
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 centre = c.xy;
  float limb = uRadius;
  float push = 1.0;
  if (!isOrthographic) {
    // Mirrored by perspectiveCoronaQuad in src/renderers/corona-geometry.ts,
    // whose tests cover this branch: change one, change the other.
    //
    // Off axis by theta (past pi/2 behind the camera), View from Earth
    // squashes the Sun by cos(theta) to keep its disc round (RoundSkyDiscs);
    // elsewhere the Sun sits near the axis, where the squash is ~1. The
    // silhouette then spans tan(theta -+ beta) out from the centre of view,
    // with tan(beta) = cos(theta) tan(alpha) and alpha the Sun's angular
    // radius.
    float lateral = length(c.xy);
    float theta = atan(lateral, -c.z);
    float tanAlpha = uRadius * inversesqrt(max(dot(c, c) - uRadius * uRadius, 1e-8));
    float beta = atan(cos(theta) * tanAlpha);
    // tan() runs off to infinity as a limb nears the camera plane, so the far
    // limb is clamped at uMaxAngle, and the quad, shrinking to nothing as the
    // near limb comes up to it, is collapsed past it. Behind the camera
    // nearAngle > theta > pi/2. Unclamped, the near limb overtook the far one
    // near the plane, turning the quad inside out and ~1e5 screens wide
    // (tides-2hv.1).
    float nearAngle = theta - beta;
    // Compares the raw angle, so NaN collapses too.
    if (!(abs(nearAngle) < uMaxAngle)) {
      // Zero area and outside the clip volume: nothing is drawn.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vPlane = vec2(0.0);
      vOuter = 1.0;
      return;
    }
    // From here theta < pi/2, so beta >= 0 and the Sun is in front of the
    // camera: both tangents are finite, with near <= far.
    float depth = -c.z;
    float far = tan(min(theta + beta, uMaxAngle));
    float near = tan(nearAngle);
    vec2 outward = lateral > 1e-6 * depth ? c.xy / lateral : vec2(1.0, 0.0);
    centre = outward * 0.5 * (far + near) * depth;
    limb = 0.5 * (far - near) * depth;
    // Parallel to the screen through the centre, the quad would cut in front
    // of the limb nearest the centre of view; slid back along the eye's rays
    // behind the whole Sun, it projects the same and stays hidden there.
    push = (depth + uRadius) / depth;
  }
  // Perspective panels show the Sun ~43x real size; a 3R corona would fill
  // the sky.
  float outer = isOrthographic ? 3.0 : 1.6;

  vPlane = position.xy * outer;
  vOuter = outer;
  gl_Position = projectionMatrix * vec4(vec3(centre + vPlane * limb, c.z) * push, 1.0);
}
