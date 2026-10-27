// Widens each strand's spine (sun-prominences.ts) into a ribbon facing the
// eye, in view space so it holds in the ortho main view and the perspective
// panels and ship alike.
uniform float time;
uniform float uViewHeight; // the view's height, CSS px
uniform vec2 uFadePx;      // PROMINENCE_FADE_PX
uniform vec2 uLoopFadePx;  // PROMINENCE_LOOP_FADE_PX
attribute vec3 aTangent;
attribute vec4 aStrand;    // t along, side -1/+1, width (solar radii), seed
attribute vec2 aKind;      // kind (PROMINENCE_KIND), gain
varying vec3 vView;
varying vec3 vCentre;
varying float vRadius;
varying vec4 vStrand;
varying vec2 vKind;
varying float vFade;
varying float vSlant;

void main() {
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float radius = length(modelViewMatrix[1].xyz);
  // The Sun's radius on screen, CSS px: under PROMINENCE_FADE_PX the
  // strands are thinner than a pixel and only flicker, so they go.
  float px = radius * projectionMatrix[1][1] * 0.5 * uViewHeight;
  if (!isOrthographic) px /= max(-centre.z, 1e-6);
  // Loops are finer still, and only for a close Sun.
  vFade = aKind.x > 1.5 ? smoothstep(uLoopFadePx.x, uLoopFadePx.y, px) : smoothstep(uFadePx.x, uFadePx.y, px);
  if (vFade <= 0.0) {
    // Zero area and outside the clip volume: nothing is drawn.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vec3 tangent = normalize(mat3(modelViewMatrix) * aTangent);
  vec3 eye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-view.xyz);
  vec3 side = cross(tangent, eye);
  // A strand pointing straight at the eye still gets a width.
  float sideLength = length(side);
  // Seen end-on, a strand piles its whole length onto a few pixels, and
  // an arch seen edge-on piles all its strands up: dim both, or they add
  // to a white blot.
  vSlant = smoothstep(0.05, 0.6, sideLength);
  // So does a bundle of loops seen edge-on, all its arcs laid on one line:
  // fade loops as their plane turns edge-on, arches only partly.
  vec3 up = normalize(view.xyz - centre);
  float facing = abs(dot(normalize(cross(tangent, up)), eye));
  vSlant *= aKind.x > 1.5 ? smoothstep(0.15, 0.55, facing) : 0.5 + 0.5 * smoothstep(0.1, 0.45, facing);
  side = sideLength > 1e-4 ? side / sideLength : normalize(cross(tangent, vec3(0.0, 1.0, 0.0)));
  // Strands taper to their ends; hedgerow threads only toward their tips.
  float t = aStrand.x;
  float taper = aKind.x > 0.5 && aKind.x < 1.5
    ? 1.0 - 0.5 * t
    : 0.55 + 0.45 * sqrt(sin(3.14159265 * t));
  view.xyz += side * aStrand.y * aStrand.z * radius * taper;
  // A slow sway along each strand, so the plasma seems to move in its field.
  view.xyz += side * radius * 0.004 * sin(time * 0.3 + aStrand.w + t * 5.0) * sin(3.14159265 * t);

  vView = view.xyz;
  vCentre = centre;
  vRadius = radius;
  vStrand = aStrand;
  vKind = aKind;
  gl_Position = projectionMatrix * view;
}
