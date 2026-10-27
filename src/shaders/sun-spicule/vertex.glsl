// Stands each spicule blade (sun-spicules.ts) up from its foot along its
// leaning axis and widens it into a ribbon facing the eye, in view space as
// the prominences are (sun-prominence/vertex.glsl).
uniform float time;
uniform float uViewHeight; // the view's height, CSS px
uniform vec2 uFadePx;      // SPICULE_FADE_PX
attribute vec4 aSpicule;   // foot (xyz, its length the foot's radius), seed
attribute vec3 aLean;      // tangent lean at the foot, in the Sun's frame
attribute vec2 aSize;      // height, width (solar radii)
varying vec3 vView;
varying vec3 vCentre;
varying float vRadius;
varying vec2 vUv;
varying float vFade;
// How much of the blade shows against the disc (sun-spicule/fragment.frag).
varying float vDisc;

// Zero area and outside the clip volume: nothing is drawn.
void collapse() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vView = vec3(0.0);
  vCentre = vec3(0.0);
  vRadius = 1.0;
  vUv = vec2(0.0);
  vFade = 0.0;
  vDisc = 0.0;
}

void main() {
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float radius = length(modelViewMatrix[1].xyz);
  vec3 foot = (modelViewMatrix * vec4(aSpicule.xyz, 1.0)).xyz;
  // The blade's width in CSS px at its own foot, not the Sun's centre: close
  // in the near blades are many times wider than the limb's. Under ~1 px it
  // would only shimmer.
  float px = aSize.y * radius * projectionMatrix[1][1] * 0.5 * uViewHeight;
  if (!isOrthographic) px /= max(-foot.z, 1e-6);
  float fade = smoothstep(uFadePx.x, uFadePx.y, px);

  // Past the far limb by more than its height, a blade can't peek over it.
  vec3 up = normalize(foot - centre);
  vec3 toEye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-centre);
  float limb = isOrthographic ? 0.0 : min(radius / length(centre), 1.0);
  float past = acos(clamp(dot(up, toEye), -1.0, 1.0)) - acos(limb);
  if (fade <= 0.0 || past > acos(1.0 / (1.0 + aSize.x)) + aSize.x) {
    collapse();
    return;
  }

  // Each blade rises and falls on its own, over ~16 s.
  float life = 0.5 + 0.5 * sin(time * 0.4 + aSpicule.w * 6.283);
  float h = aSize.x * (0.6 + 0.4 * life);
  vec3 axis = normalize(mat3(modelViewMatrix) * normalize(normalize(aSpicule.xyz) + aLean));
  vec3 p = foot + axis * radius * h * position.y;
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-p);
  vec3 side = cross(axis, eye);
  float sideLength = length(side);
  // Seen end-on, a blade piles its length onto a speck that only
  // flickers: fade it as it turns to the eye.
  fade *= smoothstep(0.05, 0.6, sideLength);
  // Against the disc, only blades seen side-on and wide, close in, where
  // they stand in parallax: looked down on, or from further out, the tufts
  // would pepper the disc like dirt.
  vDisc = smoothstep(0.55, 0.9, sideLength) * smoothstep(2.0, 5.0, px);
  side = sideLength > 1e-4 ? side / sideLength : normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
  // Tapering to the tip.
  p += side * position.x * aSize.y * radius * (1.0 - 0.7 * position.y);

  vView = p;
  vCentre = centre;
  vRadius = radius;
  vUv = position.xy;
  vFade = fade;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
