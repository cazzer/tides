// The curtains' slow noise (tides-0oi.5): everything in the aurora march that
// varies only with the MLT angle, the hemisphere, one latitude-like coordinate
// and the clock. The march either calls these (no float colour buffer) or reads
// them from a texture baked once a frame by ./curtainBake.frag, which samples
// them over CURTAIN_WIDTH angles and CURTAIN_ROWS rows per hemisphere.
//
// Needs snoise3 (./noise3.glsl) and TAU from the includer, and the defines
// CURTAIN_WIDTH and CURTAIN_ROWS where the texture is used.

// The rows' ranges: fold by magnetic latitude, from the march's 35° cut to the
// pole; breaks2 by d, which the arcs block only reads in (-2.5, offset.z + 3)
// and offset.z + 3 <= ARC_AT.z * 1.4 + 0.9 + 3 = 10.06.
const float CURTAIN_MLAT_MIN = 35.0;
const float CURTAIN_MLAT_MAX = 90.0;
const float CURTAIN_D_MIN = -3.0;
const float CURTAIN_D_MAX = 11.0;

// Slow meanders shared by all the arcs, so they bend together...
float curtainMeander(vec2 around, float hemi, float t) {
  return snoise3(vec3(around * 1.7 + hemi, t * 0.012));
}

// ...and smaller folds that also depend on latitude, so an arc can double
// back on itself (an S or a curl seen from above).
float curtainFold(vec2 around, float hemi, float mlat, float t) {
  return snoise3(vec3(around * 4.5 + vec2(t * 0.02, -hemi), mlat * 0.4 - t * 0.015));
}

// Arcs come and go along the oval rather than circling it unbroken.
float curtainBreaks(vec2 around, float hemi, float t) {
  return snoise3(vec3(around * 3.4 - hemi, t * 0.01 + 5.0));
}

float curtainBreaks2(vec2 around, float hemi, float d, float t) {
  return snoise3(vec3(around * 5.2 + hemi, d * 0.15 + t * 0.012 + 11.0));
}

#ifdef CURTAIN_ROWS
// Where the bake keeps (ang, x) for x in [x0, x1]: rows 0..ROWS-1 are the
// north's, ROWS..2 ROWS-1 the south's (hemiRow 0 or ROWS). The ends land on
// texel centres, so a hemisphere never blends into the other.
vec2 curtainUv(float ang, float x, float x0, float x1, float hemiRow) {
  float rows = float(CURTAIN_ROWS);
  float row = clamp((x - x0) / (x1 - x0), 0.0, 1.0) * (rows - 1.0) + 0.5 + hemiRow;
  return vec2(ang / TAU + 0.5, row / (2.0 * rows));
}
#endif
