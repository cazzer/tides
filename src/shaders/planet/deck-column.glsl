// The gas giants' cloud-deck fog (tides-ufyr.8.3), mirroring cloud-deck.ts
// (deckColumn, deckAhead, deckLayerHit), its tested spec; keep them in
// step. Takes the eye's radius r, the ray's cos(zenith) mu, the planet's
// radius R and the fog's scale height H as arguments: unlike the hazes'
// columnAhead, the eye is never clamped to the surface, as the fog runs on
// below R.

#define DECK_MAX_EXPONENT 60.0

float deckDensity(float r, float R, float H) {
  return exp(min((R - r) / H, DECK_MAX_EXPONENT));
}

// Chapman's column from r out along a ray climbing at mu >= 0.
float deckAbove(float r, float mu, float R, float H) {
  float x = r / H;
  float z = mu * sqrt(0.5 * x);
  return deckDensity(r, R, H) * H * sqrt(2.0 * x) / (z + sqrt(z * z + 1.2732395));
}

// The column to space along the ray: a falling ray crosses the full line
// through its closest approach (floored at H) less the part behind the eye.
float deckColumn(float r, float mu, float R, float H) {
  if (mu >= 0.0) return deckAbove(r, mu, R, H);
  float p = max(r * sqrt(max(0.0, 1.0 - mu * mu)), H);
  return max(deckDensity(p, R, H) * sqrt(6.2831853 * p * H) - deckAbove(r, -mu, R, H), 0.0);
}

// How far along the ray the optical depth reaches 1, plane-parallel
// (visibility: 1/σ₀ at R); 1e30 for a climbing ray that never does.
float deckAhead(float r, float mu, float R, float H, float visibility) {
  float seen = visibility / deckDensity(r, R, H);
  float k = mu * seen / H;
  if (abs(k) < 1e-6) return seen;
  if (k >= 1.0) return 1e30;
  return (-H / mu) * log(1.0 - k);
}

// The in-deck view's brightness by the ray's cos(zenith) (tides-ufyr.4.1,
// deckViewShade): down darker, the horizon brighter, up as it was; mix()
// keeps it exactly 1 at inside 0.
#define DECK_BELOW_DIM 0.8
#define DECK_HORIZON_GAIN 1.06
#define DECK_BELOW_MU (-0.6)
#define DECK_HORIZON_MU 0.02
#define DECK_ABOVE_MU 0.4
float deckViewShade(float mu, float inside) {
  float shape = mu < 0.0
    ? mix(DECK_BELOW_DIM, DECK_HORIZON_GAIN, smoothstep(DECK_BELOW_MU, -DECK_HORIZON_MU, mu))
    : mix(DECK_HORIZON_GAIN, 1.0, smoothstep(DECK_HORIZON_MU, DECK_ABOVE_MU, mu));
  return mix(1.0, shape, inside);
}

// The detail's contrast on the layer under the fog (DECK_LAYER_DETAIL).
#define DECK_LAYER_DETAIL 2.5

// How far along the ray it falls to radius level (tides-ufyr.4.1,
// deckLayerHit): -1.0 for none (climbing, level, or passing over it), 0.0
// at or under it; c/(-b + sqrt(b*b - c)) keeps its precision at the nadir.
float deckLayerHit(float r, float mu, float level) {
  if (r <= level) return 0.0;
  if (mu >= 0.0) return -1.0;
  float b = r * mu;
  float c = (r - level) * (r + level);
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  return c / (-b + sqrt(h));
}
