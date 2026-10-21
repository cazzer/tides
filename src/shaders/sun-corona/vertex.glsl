// A quad around the Sun in the image plane, sized and centred on its
// silhouette so the glow hugs the limb in the ortho main view and the
// perspective panels alike.
uniform float uRadius;
varying vec2 vPlane;
varying float vOuter;

void main() {
  vec3 c = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec2 centre = c.xy;
  float limb = uRadius;
  float push = 1.0;
  if (!isOrthographic) {
    // Off axis by theta, View from Earth squashes the Sun by cos(theta) to keep
    // its disc round (RoundSkyDiscs); elsewhere the Sun sits near the axis,
    // where the squash is ~1. The silhouette then spans tan(theta -+ beta) out
    // from the centre of view, with tan(beta) = cos(theta) tan(alpha) and alpha
    // the Sun's angular radius.
    float depth = max(-c.z, 1e-4);
    float off = length(c.xy) / depth;
    float theta = atan(off);
    float tanAlpha = uRadius * inversesqrt(max(dot(c, c) - uRadius * uRadius, 1e-8));
    float beta = atan(cos(theta) * tanAlpha);
    float far = tan(min(theta + beta, 1.55));
    float near = tan(theta - beta);
    vec2 outward = off > 1e-6 ? c.xy / (off * depth) : vec2(1.0, 0.0);
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
