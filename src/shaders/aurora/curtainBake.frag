// Bakes ./curtain.glsl's noise for one uTime (tides-0oi.5): a CURTAIN_WIDTH x
// (2 x CURTAIN_ROWS) table, read by ./fragment.frag through curtainUv. Each
// texel comes from gl_FragCoord, so it is right at any viewport that covers it.

uniform float uTime;

#include ./noise3.glsl

const float TAU = 6.28318530718;

#include ./curtain.glsl

void main() {
  float ang = (gl_FragCoord.x / float(CURTAIN_WIDTH) - 0.5) * TAU;
  float rows = float(CURTAIN_ROWS);
  float row = floor(gl_FragCoord.y);
  bool south = row >= rows;
  float hemi = south ? 37.0 : 0.0;
  float r = south ? row - rows : row;
  float mlat = CURTAIN_MLAT_MIN + (CURTAIN_MLAT_MAX - CURTAIN_MLAT_MIN) * r / (rows - 1.0);
  float d = CURTAIN_D_MIN + (CURTAIN_D_MAX - CURTAIN_D_MIN) * r / (rows - 1.0);
  vec2 around = vec2(cos(ang), sin(ang));
  // Half floats hold the sign, but keep the table in [0, 1] (decoded * 2 - 1).
  gl_FragColor = vec4(
    curtainMeander(around, hemi, uTime),
    curtainFold(around, hemi, mlat, uTime),
    curtainBreaks(around, hemi, uTime),
    curtainBreaks2(around, hemi, d, uTime)
  ) * 0.5 + 0.5;
}
