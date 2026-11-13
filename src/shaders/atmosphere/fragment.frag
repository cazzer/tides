// Atmosphere limb glow (tides-qe5): a thin scattering haze, brightest where
// the line of sight grazes the sunlit limb, warming toward the terminator.
// The column of an exponential atmosphere is estimated analytically (no
// march, so no banding): a ray that misses the surface at closest radius p
// crosses sqrt(2πpH)·exp(−(p−R)/H) of it. Over the disc it is faded out
// just inside the limb rather than drawn as H/cos(z): the day side is
// already bright, and a full haze washes it out. Lit where it is thickest.
// Shared by the Earth (AtmosphereRenderer) and the planets (PlanetAtmosphere),
// which pass their own sky and dusk colours (linear RGB). Each is double-
// sided near its body (ship mode, close zoom: pickShellFaces), and so drawn
// from inside (the Earth's: tides-01v.8.2; the planets': tides-ufyr.4).
// Only the Earth's, over the ground from inside, also hides some of what it
// covers by the sea's share (HAZE_COVER). The planets' (uSeaLevel 0, no
// HAZE_COVER) are blended premultiplied as the Earth's (planetMaterials.ts
// planetAtmosphereMaterial), alpha 0 and so additive, outside; from inside
// over the ground they veil it (tides-ufyr.4.1): their alpha is the glow's
// brightest channel, so glow plus what is left of the globe stays under 1 in
// each channel and nothing clips into hue bands (Venus's over its albedo-1
// cloud tops). The veil is whole up to PLANET_HAZE_VEIL_HEIGHTS scale heights
// over the surface, where the ship stops, and eases out to the shell's edge
// (hazeVeilWeight), so the approach and the view from outside are as before.

uniform float uSurface;
uniform float uOuter;
uniform float uScaleHeight;
uniform vec3 uSun;
uniform float uGain;
uniform vec3 uSky;
uniform vec3 uDusk;
// Read only from inside (columnAheadOverSea()); the planets' is 0, no sea.
uniform float uSeaLevel;
// The sky-view table (renderers/skyView.ts): only the Earth's, from inside.
uniform sampler2D uSkyView;
uniform vec2 uSkyViewSize;
uniform float uSkyViewOn;
#ifdef HAZE_COVER
// The Sun's disc from inside (the Earth's: AtmosphereRenderer): its
// direction, and the cosines of the cone the sky gives way across, from
// none to all, and how far (0: not at all).
uniform vec3 uSunDisc;
uniform vec3 uSunDiscCos;
#endif

varying vec3 vPos;
varying vec3 vRayOrigin;

#include ../shell/face.glsl

#include haze.glsl

void main() {
  vec3 ro = vRayOrigin;
  #ifdef DOUBLE_SIDED
  vec3 rd = normalize(vRayDir);
  #else
  vec3 rd = normalize(vPos - vRayOrigin);
  #endif
  float H = uScaleHeight;

  float b = dot(ro, rd);
  float c2 = dot(ro, ro) - b * b; // squared closest-approach radius
  float grazing = sqrt(6.2831853 * uSurface * H);
  float p = sqrt(c2);
  vec3 at;
  float column;
  float hs = uSurface * uSurface - c2;
  float cover = 0.0;
  bool sky = true;
  #ifndef HAZE_COVER
  float veil = 0.0;
  #endif
  #ifdef DOUBLE_SIDED
  bool back = shellBackFace(ro, rd, uOuter);
  if (gl_FrontFacing == back) discard;
  if (back) {
    column = columnAheadOverSea(ro, rd, grazing, at);
    // Over the ground from inside, the haze hides what it lies over.
    float bSea = dot(ro, rd);
    if (bSea < 0.0 && bSea * bSea - (dot(ro, ro) - uSeaLevel * uSeaLevel) > 0.0) {
      cover = hazeCover(column, rd, ro, uSun);
      sky = false;
    }
    #ifndef HAZE_COVER
    // Over the ground ahead, the planets' haze veils it.
    if (b < 0.0 && b * b - (dot(ro, ro) - uSurface * uSurface) > 0.0) {
      veil = 1.0 - smoothstep(uSurface + PLANET_HAZE_VEIL_HEIGHTS * H, uOuter, length(ro));
    }
    #endif
  } else
  #endif
  if (hs > 0.0) {
    // In front of the disc: fade out within a few scale heights of the limb
    // so the day side keeps its colours.
    at = ro + rd * (-b - sqrt(hs));
    column = grazing * exp(-(uSurface - p) / (1.5 * H));
  } else {
    at = ro - rd * b;
    column = grazing * sqrt(p / uSurface) * exp(-(p - uSurface) / H);
  }

  #ifdef HAZE_COVER
  // Blended premultiplied (the Earth's AtmosphereRenderer): added where
  // cover is 0, as the planets' additive blend adds. Over the Sun's disc
  // the sky gives way as the air reddens it (SunRenderer setSkyOverDisc(),
  // tides-d9f.2), where the ray meets no sea in front of it.
  vec3 glow = hazeGlow(column, grazing, at, uSun, rd, ro);
  if (sky && uSunDiscCos.z > 0.0) glow *= 1.0 - uSunDiscCos.z * smoothstep(uSunDiscCos.x, uSunDiscCos.y, dot(rd, uSunDisc));
  gl_FragColor = vec4(glow, cover);
  #else
  gl_FragColor = vec4(hazeGlow(column, grazing, at, uSun, rd, ro), 0.0);
  #endif

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifndef HAZE_COVER
  // On the encoded colour, as the blend reads it.
  gl_FragColor.a = min(veil * max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b), 1.0);
  #endif
}
