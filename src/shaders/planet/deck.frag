// The gas giants' cloud-deck fog (tides-ufyr.8.3, PlanetRenderer.tsx
// PlanetDeck): a shell at R·top, drawn from inside, that lays one analytic
// exponential fog over the view (./deck-column.glsl, no march). Its
// opacity is 1 − e^−τ along the ray to space, scaled by uDeckFade, which
// eases in from the shell's top to the cloud top, where the globe culls
// itself and the fog covers the view alone. Its colour is the band map and
// detail at the point one optical depth ahead (clamped to the shell's
// exit), lit as the globe is (fragment.frag: Minnaert, with the ambient
// fill) but with the sunlight dimmed over uSunDepth under R. Inside the
// deck that direct term blends, by uDeckInside (cloud-deck.ts deckInside, 0
// at and over R), to uDeckLight, the fog's daylight by the Sun's elevation
// at the eye (deckDayLight), so a daytime dive stays lit. The footprint
// comes from uPixelAngle, not derivatives, so the map's seam and the
// detail's octave weights stay smooth. Saturn's and Uranus's rings shadow
// it as they do the globe (fragment.frag's USE_RING_SHADOW, here gated by
// uRingOpacity so every giant shares one program).

#define RECIPROCAL_PI 0.3183098861837907

// R·top, the shell's radius (shell/vertex.glsl reads it too).
uniform float uOuter;
uniform float uRadius;
uniform float uScaleHeight;
uniform float uVisibility;
uniform float uSunDepth;
// 0 discards (out of reach, or over the shell's top).
uniform float uDeckFade;
// The fog's daylight at the eye, and how far the direct term blends to it.
uniform float uDeckLight;
uniform float uDeckInside;
// A pixel's angle at the view's centre, radians.
uniform float uPixelAngle;
uniform vec3 uSunDir;
uniform float uAlbedo;
uniform float uSunIntensity;
uniform vec3 uAmbient;
uniform float uMinnaert;
uniform sampler2D uMap;
// Planet radii; uRingOpacity 0 for no rings.
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;

varying vec3 vPos;
varying vec3 vRayOrigin;

#include ../shell/face.glsl
#include ./detail.glsl
#include ./deck-column.glsl
#include ../ring/profile.glsl

// SphereGeometry's texture coordinates of a local direction.
vec2 deckUv(vec3 dir) {
  float u = atan(dir.z, -dir.x) / 6.283185307179586;
  return vec2(fract(u), 0.5 + asin(clamp(dir.y, -1.0, 1.0)) / 3.141592653589793);
}

void main() {
  if (uDeckFade <= 0.0) discard;
  vec3 ro = vRayOrigin;
  #ifdef DOUBLE_SIDED
  vec3 rd = normalize(vRayDir);
  bool back = shellBackFace(ro, rd, uOuter);
  if (gl_FrontFacing == back) discard;
  #else
  vec3 rd = normalize(vPos - vRayOrigin);
  #endif

  float R = uRadius;
  float H = uScaleHeight;
  float r = length(ro);
  float mu = dot(ro, rd) / r;
  float T = exp(-deckColumn(r, mu, R, H) / uVisibility);

  // The point the colour comes from, inside the shell.
  float b = r * mu;
  float exitAt = -b + sqrt(max(b * b - (r * r - uOuter * uOuter), 0.0));
  float s = min(deckAhead(r, mu, R, H, uVisibility), exitAt);
  vec3 at = ro + rd * s;
  vec3 n = normalize(at);

  vec2 uv = deckUv(n);
  float texel = 3.141592653589793 / float(textureSize(uMap, 0).y);
  // n's footprint per pixel, radians on the unit sphere.
  float fp = uPixelAngle * max(s, 1e-6 * R) / R;
  float lod = max(0.0, log2(fp / texel));
  vec3 albedo = textureLod(uMap, uv, lod).rgb * uAlbedo;
  if (uDetailStyle != 0) {
    float d;
    vec3 dh;
    planetDetail(n, fp, texel, d, dh);
    albedo *= max(0.0, 1.0 + uDetailStrength * d);
  }

  float cosI = max(dot(n, uSunDir), 0.0);
  float cosE = max(abs(dot(n, rd)), 0.05);
  float direct = pow(cosI, uMinnaert) * pow(cosE, uMinnaert - 1.0);
  direct *= exp(-max(R - length(at), 0.0) / uSunDepth);
  direct = mix(direct, uDeckLight, uDeckInside);

  // The rings' shadow, as on the globe: sunlight toward n crosses the ring
  // plane only from the side away from the Sun.
  if (uRingOpacity > 0.0 && n.y * uSunDir.y < 0.0) {
    vec2 hit = n.xz - (n.y / uSunDir.y) * uSunDir.xz;
    float rr = length(hit);
    if (rr >= uRingInner && rr <= uRingOuter) {
      direct *= 1.0 - uRingOpacity * ringAlpha((rr - uRingInner) / (uRingOuter - uRingInner));
    }
  }

  vec3 irradiance = vec3(uSunIntensity * direct) + uAmbient;
  gl_FragColor = vec4(albedo * RECIPROCAL_PI * irradiance, uDeckFade * (1.0 - T));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
