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
// at the eye (deckDayLight), so a daytime dive stays lit. Under R, the band
// map shows through the fog from a layer at uLayerLevel (R·base, nothing
// solid: tides-ufyr.4.1), by uLayerShow (deckLayerShow, 0 at and over R)
// times e^(−s/uLayerSeen) at its distance s (deckLayerWeight), so the
// nadir is textured and the view fogs to the horizon; the fog's own colour
// point, a few km ahead every way, gives up its detail to it. The layer is
// lit by uLayerLight, the fog's daylight at its depth (deckDayLight at
// R·base), so the nadir reads darker than the fog. Inside, too, the
// albedo takes the giant's tint (uDeckTint, cloud-deck.ts insideTint) by
// uDeckInside: Jupiter's fog warms toward its haze. The footprint
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
// The layer under the fog: how much shows, its radius, the distance it
// fades over and its daylight. uLayerShow 0 draws none.
uniform float uLayerShow;
uniform float uLayerLevel;
uniform float uLayerSeen;
uniform float uLayerLight;
// The albedo's tint inside the deck, by uDeckInside; 1 for none.
uniform vec3 uDeckTint;
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

// The fog's colour at `at`, s along the ray rd: the band map and detail
// there, lit as the globe is but with the sunlight dimmed under R and, by
// uDeckInside, blended to `deckLight`. `foreshorten` widens the footprint
// of a surface seen obliquely (1.0 for the fog's own colour point), and
// `detailWeight` scales the detail's contrast, 0 skipping it.
vec3 deckRadiance(vec3 at, float s, vec3 rd, float foreshorten, float detailWeight, float deckLight) {
  float R = uRadius;
  vec3 n = normalize(at);

  vec2 uv = deckUv(n);
  float texel = 3.141592653589793 / float(textureSize(uMap, 0).y);
  // n's footprint per pixel, radians on the unit sphere.
  float fp = uPixelAngle * max(s, 1e-6 * R) / R / foreshorten;
  float lod = max(0.0, log2(fp / texel));
  vec3 albedo = textureLod(uMap, uv, lod).rgb * uAlbedo;
  albedo *= mix(vec3(1.0), uDeckTint, uDeckInside);
  if (uDetailStyle != 0 && detailWeight > 0.0) {
    float d;
    vec3 dh;
    planetDetail(n, fp, texel, d, dh);
    albedo *= max(0.0, 1.0 + uDetailStrength * detailWeight * d);
  }

  float cosI = max(dot(n, uSunDir), 0.0);
  float cosE = max(abs(dot(n, rd)), 0.05);
  float direct = pow(cosI, uMinnaert) * pow(cosE, uMinnaert - 1.0);
  direct *= exp(-max(R - length(at), 0.0) / uSunDepth);
  direct = mix(direct, deckLight, uDeckInside);

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
  return albedo * RECIPROCAL_PI * irradiance;
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
  vec3 colour = deckRadiance(ro + rd * s, s, rd, 1.0, 1.0 - uLayerShow, uDeckLight);

  // The layer under the fog, where the ray falls to it and it shows.
  if (uLayerShow > 0.0 && uLayerSeen > 0.0) {
    float sL = deckLayerHit(r, mu, uLayerLevel);
    if (sL >= 0.0) {
      float wL = uLayerShow * exp(-sL / uLayerSeen);
      if (wL > 1.0 / 512.0) {
        vec3 atL = ro + rd * sL;
        float foreshorten = max(abs(dot(normalize(atL), rd)), 0.05);
        colour = mix(colour, deckRadiance(atL, sL, rd, foreshorten, 1.0, uLayerLight), wL);
      }
    }
  }

  gl_FragColor = vec4(colour, uDeckFade * (1.0 - T));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
