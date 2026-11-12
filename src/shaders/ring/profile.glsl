// A ring's opacity across its width, u from the inner edge (0) to the outer
// (1): the ring texture's alpha, or soft-edged bands (centre, half-width,
// opacity in u) that stack like layers of particles. Shared by the rings
// and the shadow they cast on the globe. MAX_RING_BANDS is defined by the
// material (planetFrame.ts). Under RING_PROFILE_EITHER (the gas giants'
// cloud deck, one program for every giant: tides-ufyr.8.3) both are
// compiled and uRingHasMap picks one.

#if defined(USE_RING_MAP) || defined(RING_PROFILE_EITHER)
uniform sampler2D uRingMap;
#endif
#if !defined(USE_RING_MAP) || defined(RING_PROFILE_EITHER)
uniform vec3 uBands[MAX_RING_BANDS];
uniform int uBandCount;

float ringBandsAlpha(float u) {
  float clear = 1.0;
  for (int i = 0; i < MAX_RING_BANDS; i++) {
    if (i >= uBandCount) break;
    vec3 band = uBands[i];
    float soft = 0.3 * band.y;
    float inside = 1.0 - smoothstep(band.y - soft, band.y + soft, abs(u - band.x));
    clear *= 1.0 - band.z * inside;
  }
  return 1.0 - clear;
}
#endif
#ifdef RING_PROFILE_EITHER
uniform bool uRingHasMap;
#endif

float ringAlpha(float u) {
  #if defined(RING_PROFILE_EITHER)
  // Level 0: the deck calls it from non-uniform flow, without derivatives.
  return uRingHasMap ? textureLod(uRingMap, vec2(u, 0.5), 0.0).a : ringBandsAlpha(u);
  #elif defined(USE_RING_MAP)
  return texture2D(uRingMap, vec2(u, 0.5)).a;
  #else
  return ringBandsAlpha(u);
  #endif
}
