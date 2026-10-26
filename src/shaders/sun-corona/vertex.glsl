// A quad around the Sun in the image plane, sized and centred on its
// silhouette so the glow hugs the limb in the main view and the panels alike.
uniform float uRadius;
// Outer edge in limb radii: CORONA_OUTER_MAIN or CORONA_OUTER_PERSPECTIVE.
uniform float uOuter;
// CORONA_MAX_ANGLE (src/renderers/corona-geometry.ts).
uniform float uMaxAngle;
varying vec2 vPlane;
varying float vOuter;
// The limb's outward normal in the Sun's frame, split so it interpolates
// linearly: normalize(vSolarPlane / r + vSolarLimb), r = length(vPlane).
varying vec3 vSolarPlane;
varying vec3 vSolarLimb;

// View space to the Sun's frame: the transpose undoes the rotation (and,
// near enough, View from Earth's squash), so the corona's streamers stay
// put on the Sun as the eye moves round it.
vec3 toSolar(vec3 view) {
  return vec3(
    dot(view, modelViewMatrix[0].xyz),
    dot(view, modelViewMatrix[1].xyz),
    dot(view, modelViewMatrix[2].xyz)
  );
}

void main() {
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 centre = c.xy;
  float limb = uRadius;
  float push = 1.0;
  // The eye ray to a limb point leans off the view axis; the limb normal
  // there is perpendicular to it: (u, dot(u, centre) / depth + limb / depth)
  // for the limb's direction u in the image plane. 0 in the ortho view.
  vec3 slope = vec3(0.0);
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
      vSolarPlane = vec3(0.0);
      vSolarLimb = vec3(0.0, 1.0, 0.0);
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
    slope = vec3(centre, limb) / depth;
    // Parallel to the screen through the centre, the quad would cut in front
    // of the limb nearest the centre of view; slid back along the eye's rays
    // behind the whole Sun, it projects the same and stays hidden there.
    push = (depth + uRadius) / depth;
  }
  vPlane = position.xy * uOuter;
  vOuter = uOuter;
  vSolarPlane = toSolar(vec3(vPlane, dot(vPlane, slope.xy)));
  vSolarLimb = toSolar(vec3(0.0, 0.0, slope.z));
  gl_Position = projectionMatrix * vec4(vec3(centre + vPlane * limb, c.z) * push, 1.0);
}
