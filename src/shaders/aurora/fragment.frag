// Aurora shell (tides-qe5, tides-9jn.4): ray-marches the layer between
// uInner and uOuter (Earth-local frame) and adds up emission from the
// auroral ovals, whose boundaries per MLT hour come from src/aurora.ts in
// uOval.
//
// What it aims for is the aurora as seen from orbit (ISS photographs, DMSP
// and VIIRS night imagery), not a filled band:
//  - one bright, folded arc just poleward of the discrete oval's
//    equatorward edge, a weaker one or two behind it, broken along their
//    length and striated by fine vertical rays;
//  - a dim, patchy diffuse glow over the rest of the oval and down to the
//    diffuse edge;
//  - brightest before magnetic midnight (the intensity in uOval).
//
// Height profile, bottom to top of the shell (~100 km to ~390 km):
//  - 557.7 nm green (O, ~100-200 km): sharp lower border, fading upward;
//    bright rays reach higher
//  - 630.0 nm red (O, >~200 km): the curtains' tops, faint unless the
//    storm is big; in severe storms also a weak, smooth subauroral (SAR)
//    arc a few degrees equatorward of the oval, high up
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
const vec3 GREEN = vec3(0.2, 1.0, 0.3);
const vec3 RED = vec3(1.0, 0.05, 0.16);
const vec3 VIOLET = vec3(0.45, 0.12, 1.0);

// Arcs poleward of the discrete equatorward edge (degrees), their relative
// brightness and core half-width (degrees; ~15-40 km).
const vec3 ARC_AT = vec3(0.9, 2.5, 4.4);
const vec3 ARC_GAIN = vec3(1.0, 0.42, 0.22);
const vec3 ARC_WIDTH = vec3(0.22, 0.28, 0.36);
// The subauroral red arc's offset equatorward of the diffuse edge.
const float SAR_OFFSET = 3.0;
// MLT of the substorm-ish brightening and its extra folding (radians).
const float SURGE_ANGLE = 23.0 / 24.0 * TAU;

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

// A thin arc's cross-section, x degrees from its centre, widened to at least
// the sampling blur (keeping its integral) so it doesn't sparkle when the
// march or the pixels are coarser than the arc.
float arcProfile(float x, float width, float blur) {
  float w = sqrt(width * width + blur * blur);
  return exp(-(x * x) / (w * w)) * (width / w);
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
  // A pixel's footprint on the shell, in degrees of arc.
  float pixelDeg = degrees(length(fwidth(vPos)) / uOuter);

  // Magnetic frame: MLT 0 on the anti-sunward meridian, 6 toward dawn.
  vec3 midnight = normalize(dot(uSun, uPole) * uPole - uSun);
  vec3 dawn = cross(uPole, midnight);

  float storm = smoothstep(5.5, 9.0, uKp);
  float redAmount = 0.05 + 0.95 * smoothstep(4.5, 8.5, uKp);
  // Fine rays fade out where a pixel spans several of them.
  float rayContrast = 1.0 - smoothstep(0.05, 0.25, pixelDeg);
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
    if (mlat < 35.0) continue;

    vec3 q = n - m * uPole;
    float ang = atan(dot(q, dawn), dot(q, midnight));
    vec4 oval = ovalAt(ang / TAU * 24.0 + 24.0);
    float diffuseLat = oval.x;
    float eqLat = oval.y;
    float polLat = oval.z;
    float intensity = oval.w;
    float sarLat = diffuseLat - SAR_OFFSET;
    if (mlat < sarLat - 4.0 || mlat > polLat + 1.5) continue;

    float hgt = clamp((r - uInner) / thickness, 0.0, 1.0);
    // This step's horizontal reach, in degrees: arcs narrower than that are
    // widened rather than missed.
    float stepDeg = degrees(dt * sqrt(max(1.0 - dot(rd, n) * dot(rd, n), 0.0)) / r);
    float blur = length(vec2(0.9 * stepDeg, pixelDeg));

    // Seamless around the pole: noise over (cos, sin) of the MLT angle.
    vec2 around = vec2(cos(ang), sin(ang));
    // Southern ovals get their own pattern.
    float hemi = m > 0.0 ? 0.0 : 37.0;
    // Near magnetic midnight the arcs fold harder.
    float surge = 0.5 + 0.5 * cos(ang - SURGE_ANGLE);

    // Slow meanders shared by all the arcs, so they bend together...
    float meander = snoise3(vec3(around * 1.7 + hemi, t * 0.012));
    // ...and smaller folds that also depend on latitude, so an arc can
    // double back on itself (an S or a curl seen from above).
    float fold = snoise3(vec3(around * 4.5 + vec2(t * 0.02, -hemi), mlat * 0.4 - t * 0.015));
    float foldAmp = 0.15 + 0.35 * surge + 0.5 * storm;
    // Degrees poleward of the discrete oval's equatorward edge, warped.
    float d = mlat - eqLat - (1.2 + 0.8 * storm) * meander - foldAmp * fold;

    // Dim, patchy glow: diffuse aurora from the diffuse edge to the arcs,
    // and the weaker poleward part of the oval behind them.
    float band = smoothstep(diffuseLat - 1.0, diffuseLat + 2.0, mlat)
      * (1.0 - smoothstep(polLat - 1.5, polLat + 1.0, mlat));
    // Faintest equatorward of the arcs, where it is mostly the diffuse
    // aurora (subvisual to the eye).
    float glow = band * (0.011 + 0.007 * meander)
      * (0.5 + 0.5 * smoothstep(-2.0, 0.5, d)) * (1.0 - 0.6 * smoothstep(2.0, 6.0, d));

    // Height profiles. The curtains' lower border undulates a little.
    float base = 0.04 + 0.025 * fold;
    float glowH = smoothstep(0.0, 0.08, hgt) * exp(-hgt / 0.2);
    float redH = smoothstep(0.2, 0.45, hgt) * (1.0 - smoothstep(0.55, 0.95, hgt));
    float sarH = smoothstep(0.4, 0.65, hgt) * (1.0 - smoothstep(0.75, 1.0, hgt));

    float sar = (mlat - sarLat) / 1.6;
    float red = sarH * storm * 0.005 * exp(-sar * sar);
    vec3 e = GREEN * glowH * glow;

    // In storms the arcs spread over a wider band. Each wanders a little on
    // its own.
    vec3 offset = ARC_AT * (0.8 + 0.6 * storm) + vec3(0.0, 0.5, 0.9) * fold;
    if (d > -2.5 && d < offset.z + 3.0) {
      // Arcs come and go along the oval rather than circling it unbroken.
      float breaks = snoise3(vec3(around * 3.4 - hemi, t * 0.01 + 5.0));
      float breaks2 = snoise3(vec3(around * 5.2 + hemi, d * 0.15 + t * 0.012 + 11.0));
      // Storms keep more of each arc and light the ones behind it more.
      float gaps = 0.25 * storm;
      vec3 present = vec3(
        smoothstep(-0.55 - gaps, 0.15 - gaps, breaks),
        smoothstep(-0.2 - gaps, 0.45 - gaps, breaks2),
        smoothstep(0.05 - gaps, 0.55 - gaps, -breaks2)
      ) * (ARC_GAIN + storm * vec3(0.0, 0.25, 0.25));
      float arcs = 0.0;
      float skirt = 0.0;
      for (int k = 0; k < 3; k++) {
        float x = d - offset[k];
        arcs += present[k] * arcProfile(x, ARC_WIDTH[k], blur);
        // A softer halo around each arc, where the red tops spread.
        skirt += present[k] * exp(-(x * x) / 1.2);
      }

      // Rays: fine striations along the arcs, the same at every height so
      // they stand vertical, slowly flickering. The coordinate runs along
      // the oval in degrees of arc.
      float along = ang * degrees(cos(radians(mlat)));
      float rayN = snoise3(vec3(along * 2.6, d * 0.4, t * 0.35 + hemi));
      float ray = 1.0 + rayContrast * 0.7 * rayN;
      float curtain = arcs * ray;

      // Green from a sharp lower border; bright rays reach higher.
      float lift = 0.1 + 0.08 * max(rayN, 0.0) + 0.06 * storm;
      float green = smoothstep(base - 0.025, base + 0.012, hgt) * exp(-max(hgt - base, 0.0) / lift);
      float violet = smoothstep(base - 0.025, base, hgt) * (1.0 - smoothstep(base, base + 0.04, hgt));
      // Red: the curtains' tops (patchier than the green), and a faint
      // patchy wash near them in big storms.
      float redPatch = smoothstep(-0.3, 0.6, breaks2);
      red += redH * redAmount * redPatch * (0.045 * skirt * ray + 0.004 * storm * band);
      e += GREEN * green * curtain + VIOLET * violet * storm * curtain * 0.5;
    }
    e += RED * red;
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
