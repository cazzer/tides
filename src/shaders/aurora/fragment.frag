// Aurora shell (tides-qe5): ray-marches the layer between uInner and uOuter
// (Earth-local frame) and adds up emission from the auroral ovals, whose
// boundaries per MLT hour come from src/aurora.ts in uOval.
//
// Height profile, bottom to top of the shell (~100 km to ~300+ km):
//  - 557.7 nm green (O, ~100-200 km): sharp lower border, fading upward
//  - 630.0 nm red (O, >~200 km): the upper fringe; strong only in storms,
//    when it also dominates the low-latitude diffuse glow
//  - 427.8 nm N2+ blue-violet: a thin lower fringe in intense displays

uniform float uInner;
uniform float uOuter;
uniform vec3 uPole;
uniform vec3 uSun;
uniform vec4 uOval[24];
uniform float uKp;
uniform float uTime;
uniform float uGain;

varying vec3 vPos;
varying vec3 vRayOrigin;

#include ./noise3.glsl

const float TAU = 6.28318530718;
const vec3 GREEN = vec3(0.10, 1.0, 0.36);
const vec3 RED = vec3(1.0, 0.05, 0.22);
const vec3 VIOLET = vec3(0.45, 0.12, 1.0);

// Per-pixel jitter hides the march's banding (white noise: interleaved
// gradient noise leaves a visible hatching here).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 ovalAt(float mlt) {
  float f = mod(mlt, 24.0);
  int i0 = int(floor(f));
  int i1 = i0 == 23 ? 0 : i0 + 1;
  return mix(uOval[i0], uOval[i1], fract(f));
}

void main() {
  vec3 ro = vRayOrigin;
  vec3 rd = normalize(vPos - vRayOrigin);

  // Entry and exit of the outer sphere; stop early at the inner one.
  float b = dot(ro, rd);
  float c = dot(ro, ro) - uOuter * uOuter;
  float h = b * b - c;
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0);
  float t1 = -b + h;
  float hi = b * b - (dot(ro, ro) - uInner * uInner);
  if (hi > 0.0) {
    float tIn = -b - sqrt(hi);
    if (tIn > t0) t1 = min(t1, tIn);
  }
  float span = t1 - t0;
  if (span <= 0.0) discard;

  float thickness = uOuter - uInner;
  float dt = span / float(STEPS);
  float jitter = hash12(gl_FragCoord.xy);

  // Magnetic frame: MLT 0 on the anti-sunward meridian, 6 toward dawn.
  vec3 midnight = normalize(dot(uSun, uPole) * uPole - uSun);
  vec3 dawn = cross(uPole, midnight);

  float redAmount = 0.12 + 0.88 * smoothstep(4.0, 8.0, uKp);
  float storm = smoothstep(5.5, 9.0, uKp);
  float t = uTime;

  vec3 col = vec3(0.0);
  for (int s = 0; s < STEPS; s++) {
    vec3 p = ro + rd * (t0 + (float(s) + jitter) * dt);
    float r = length(p);
    vec3 n = p / r;

    // Seen against a dark sky only: fade through twilight.
    float dark = smoothstep(0.1, -0.16, dot(n, uSun));
    if (dark <= 0.0) continue;

    float m = dot(n, uPole);
    float mlat = degrees(asin(min(abs(m), 1.0)));
    if (mlat < 40.0) continue;

    vec3 q = n - m * uPole;
    float ang = atan(dot(q, dawn), dot(q, midnight));
    vec4 oval = ovalAt(ang / TAU * 24.0 + 24.0);
    float diffuseLat = oval.x;
    float eqLat = oval.y;
    float polLat = oval.z;
    float intensity = oval.w;

    float band = smoothstep(diffuseLat - 1.0, diffuseLat + 2.5, mlat)
      * (1.0 - smoothstep(polLat - 1.0, polLat + 1.0, mlat));
    if (band <= 0.0) continue;
    float discrete = smoothstep(eqLat - 1.5, eqLat + 0.5, mlat)
      * (1.0 - smoothstep(polLat - 2.0, polLat + 0.5, mlat));

    // Seamless around the pole: noise over (cos, sin) of MLT angle, with
    // latitude (degrees) as the fast axis, so contours run along the oval.
    vec2 around = vec2(cos(ang), sin(ang));
    // Southern ovals get their own pattern.
    float hemi = m > 0.0 ? 0.0 : 37.0;
    // Slow meanders shared by every arc, so they fold together.
    float warp = snoise3(vec3(around * 2.2 + vec2(t * 0.03, -t * 0.025), mlat * 0.05 + hemi)) * 1.6;
    float lat = mlat + warp;
    // A few long arcs: zero crossings of noise that is slow along the oval
    // and ~3-4° apart across it.
    float fold = snoise3(vec3(around * 1.8 + hemi, lat * 0.32 + t * 0.02));
    float arcs = pow(max(1.0 - abs(fold), 0.0), 14.0);
    // The brightest arc usually leads on the equatorward edge.
    float lead = (lat - eqLat - 1.2) / 0.6;
    arcs = max(arcs, exp(-lead * lead));
    // Arcs come and go along the oval rather than circling it unbroken.
    float patchy = smoothstep(-0.35, 0.55, snoise3(vec3(around * 4.5 - hemi, t * 0.015 + lat * 0.04)));
    // Rays: fine striations along each arc, the same at every height so they
    // stand vertical, slowly flickering.
    float ray = snoise3(vec3(around * 40.0, t * 0.4 + hemi));
    ray = 0.55 + 0.45 * ray;
    float sheet = arcs * (0.25 + 0.75 * patchy) * ray;

    float hgt = clamp((r - uInner) / thickness, 0.0, 1.0);
    // The curtains' lower border undulates a little.
    float base = 0.03 + 0.05 * (0.5 + 0.5 * fold);
    float green = smoothstep(base - 0.03, base + 0.02, hgt) * exp(-(hgt - base) * 5.0);
    float redH = smoothstep(0.18, 0.45, hgt) * (1.0 - smoothstep(0.5, 0.85, hgt));
    float violet = smoothstep(base - 0.03, base, hgt) * (1.0 - smoothstep(base, base + 0.05, hgt));

    float curtain = discrete * sheet;
    float glow = band * (0.025 + 0.015 * fold);

    vec3 e = GREEN * green * (curtain + glow * (1.0 - 0.7 * storm))
      + RED * redH * redAmount * ((0.12 + 0.15 * storm) * curtain + glow * (0.2 + 0.8 * storm))
      + VIOLET * violet * storm * curtain * 0.6;
    col += e * intensity * dark;
  }

  // Path length in units of the shell's thickness, so looking straight down
  // through it gives ~1 and the limb brightens naturally.
  col *= uGain * dt / thickness;
  // Soft shoulder on the brightest channel, so bright folds keep their hue
  // (per channel, overlapping green and red would fade toward white).
  col /= 1.0 + max(col.r, max(col.g, col.b));
  // Emission only: added to whatever is behind (additive blending). The
  // night side is dark enough (../../lighting.ts) for it to hold its hue.
  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
