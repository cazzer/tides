// Hand-written depth for a perspective projection P (tides-zmw.9.3), in
// either depth mode three can draw with. Under reversed-Z (three's
// reversedDepthBuffer, via EXT_clip_control) clip z runs 0..w, window depth
// is NDC z itself and runs 1 at the near plane to 0 at the far one; on the
// standard buffer it is 0.5 + 0.5 · NDC z, 0 near to 1 far. With P[2][2] = c
// and P[3][2] = d, NDC z at view depth z (in front of the eye, > 0) is
// (d − c·z) / z either way, so the two differ only in c, d and the window
// mapping. Orthographic callers keep their own (vNear = 0).

#ifdef USE_REVERSED_DEPTH_BUFFER
// Window depth of the nearest surface: what the fog, at the eye, draws at.
#define FRAG_DEPTH_NEAREST 1.0

// The near plane's view depth: c = n / (f − n), d = f·n / (f − n).
float viewDepthNear(mat4 P) {
  return P[3][2] / (P[2][2] + 1.0);
}

// The gl_FragDepth of view depth z.
float viewDepthToFragDepth(mat4 P, float z) {
  return (P[3][2] - P[2][2] * z) / z;
}
#else
#define FRAG_DEPTH_NEAREST 0.0

// c = −(f + n) / (f − n), d = −2·f·n / (f − n).
float viewDepthNear(mat4 P) {
  return P[3][2] / (P[2][2] - 1.0);
}

float viewDepthToFragDepth(mat4 P, float z) {
  return 0.5 + 0.5 * (P[3][2] - P[2][2] * z) / z;
}
#endif
