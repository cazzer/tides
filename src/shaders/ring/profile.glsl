// A ring's opacity across its width, u from the inner edge (0) to the outer
// (1): the ring texture's alpha, or soft-edged bands (centre, half-width,
// opacity in u) that stack like layers of particles. Shared by the rings
// and the shadow they cast on the globe. MAX_RING_BANDS is defined by the
// material (planetFrame.ts).

#ifdef USE_RING_MAP
uniform sampler2D uRingMap;
#else
uniform vec3 uBands[MAX_RING_BANDS];
uniform int uBandCount;
#endif

float ringAlpha(float u) {
  #ifdef USE_RING_MAP
  return texture2D(uRingMap, vec2(u, 0.5)).a;
  #else
  float clear = 1.0;
  for (int i = 0; i < MAX_RING_BANDS; i++) {
    if (i >= uBandCount) break;
    vec3 band = uBands[i];
    float soft = 0.3 * band.y;
    float inside = 1.0 - smoothstep(band.y - soft, band.y + soft, abs(u - band.x));
    clear *= 1.0 - band.z * inside;
  }
  return 1.0 - clear;
  #endif
}
