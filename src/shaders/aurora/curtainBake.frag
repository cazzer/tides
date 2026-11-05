// Bakes ./curtain.glsl's noise for one uTime (tides-0oi.5): a CURTAIN_WIDTH x
// (2 x CURTAIN_ROWS) table, read by ./fragment.frag through curtainUv. Each
// texel comes from gl_FragCoord, so it is right at any viewport that covers it.
//
// meander and breaks depend only on the angle and the hemisphere: with
// CURTAIN_STRIP this bakes them once, into a CURTAIN_WIDTH x 2 strip (row 0
// the north's, row 1 the south's), and the table copies them from there, so
// it evaluates only fold and breaks2 per texel.

uniform float uTime;
#ifndef CURTAIN_STRIP
uniform sampler2D uStrip;
#endif

#include ./noise3.glsl

const float TAU = 6.28318530718;

#include ./curtain.glsl

void main() {
  float ang = (gl_FragCoord.x / float(CURTAIN_WIDTH) - 0.5) * TAU;
  vec2 around = vec2(cos(ang), sin(ang));
  float row = floor(gl_FragCoord.y);
  #ifdef CURTAIN_STRIP
  float hemi = row >= 1.0 ? 37.0 : 0.0;
  // Half floats hold the sign, but keep the table in [0, 1] (decoded * 2 - 1).
  gl_FragColor = vec4(curtainMeander(around, hemi, uTime), curtainBreaks(around, hemi, uTime), 0.0, 0.0) * 0.5 + 0.5;
  #else
  float rows = float(CURTAIN_ROWS);
  bool south = row >= rows;
  float hemi = south ? 37.0 : 0.0;
  float r = south ? row - rows : row;
  float mlat = CURTAIN_MLAT_MIN + (CURTAIN_MLAT_MAX - CURTAIN_MLAT_MIN) * r / (rows - 1.0);
  float d = CURTAIN_D_MIN + (CURTAIN_D_MAX - CURTAIN_D_MIN) * r / (rows - 1.0);
  // The strip's texels, as baked (same width, same angles).
  vec2 mb = texelFetch(uStrip, ivec2(gl_FragCoord.x, south ? 1 : 0), 0).rg;
  gl_FragColor = vec4(
    mb.x,
    curtainFold(around, hemi, mlat, uTime) * 0.5 + 0.5,
    mb.y,
    curtainBreaks2(around, hemi, d, uTime) * 0.5 + 0.5
  );
  #endif
}
