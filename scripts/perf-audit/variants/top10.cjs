// Shader variants behind the tides-0oi top-10 (audit tides-0oi.2), as in-page text replacements for ab.cjs.
// Each: match = in-page predicate source over (material) picking the program; pairs = [from, to] where from is a
// string (every occurrence) or { re, flags } (a RegExp, String.replace). The audit's poses and results are in the
// bd notes on tides-0oi.2; these are the exact texts that produced them. If the source moved since, ab.cjs prints
// hits 0 for a pair: update the text, never trust a variant with a zero hit.
const SEA_EARLY_OUT = `float sFlat = sIn > 0.0 ? sIn : sOut;
  { float rg = uSeaLevel * 0.9995; float dg = be * be - (dot(eye, eye) - rg * rg);
    if (dg > 0.0 && -be - sqrt(dg) > 0.0 && -be - sqrt(dg) < sFlat) discard; }`

const AURORA_GATE = 'if (mlat < sarLat - 4.0 || mlat > polLat + 1.5) continue;'
const DETAIL_CALL = 'vec4 o = detailNoise(DETAIL_TURNS[k] * p / wavelength + float(k) * 23.17);'
const WATER_GLINT = { re: 'float waterGlint\\(vec3 l, vec3 v, vec3 n\\) \\{' }
const WATER_NORMAL = { re: 'if \\(specularStrength > 0\\.0\\) \\{(\\s*)float waterPx' }

module.exports = {
  // #1 clouds-1 (a): low tier's flat cloud sheet seen from under it; pose: close zoom <= ~40 km, ground in view.
  cloudSeaEarlyOut: {
    match: '(m) => !!m.uniforms?.uCloudCeiling',
    pairs: [['float sFlat = sIn > 0.0 ? sIn : sOut;', SEA_EARLY_OUT]],
  },
  // #1 clouds-1 (b): no gl_FragDepth (prototype: unconditional; ship it only while the eye is inside the sheet).
  cloudNoFragDepth: { match: '(m) => !!m.uniforms?.uCloudCeiling', pairs: [['gl_FragDepth = z;', '']] },
  // Control for both: hide the sheet (shows the pose exercises it).
  cloudSkip: { match: '(m) => !!m.uniforms?.uCloudCeiling', pairs: [[{ re: 'void main\\(\\) \\{' }, 'void main() { discard;']] },

  // #2 shells-4: aurora march gate when there's no storm; pose: night close zoom 400 km at 65N 120E (mlat ~56).
  auroraStormGate: {
    match: '(m) => !!m.uniforms?.uOval',
    pairs: [[AURORA_GATE, 'if (mlat < (storm > 0.0 ? sarLat - 4.0 : min(diffuseLat - 1.0, eqLat - 4.2) - 0.3) || mlat > polLat + 1.5) continue;']],
  },
  // #3 shells-1 cost floor: the 2 per-step noise fields replaced by constants (VISIBLE: timing bound only; the real
  // bake needs a texture, see the shells notes).
  auroraNoiseConst: {
    match: '(m) => !!m.uniforms?.uOval',
    pairs: [
      ['float meander = snoise3(vec3(around * 1.7 + hemi, t * 0.012));', 'float meander = 0.0;'],
      ['float fold = snoise3(vec3(around * 4.5 + vec2(t * 0.02, -hemi), mlat * 0.4 - t * 0.015));', 'float fold = 0.0;'],
    ],
  },
  auroraSkip: { match: '(m) => !!m.uniforms?.uOval', pairs: [['float thickness = uOuter - uInner;', 'discard; float thickness = uOuter - uInner;']] },

  // #6 ground-5: skip zero-weight detail octaves (weight 0 where GIBS fully covers); pose: daylit land close zoom.
  groundDetailGate: {
    match: '(m) => m.isMeshPhongMaterial',
    pairs: [
      [DETAIL_CALL, 'if (weight > 0.0) { ' + DETAIL_CALL],
      ['/ wavelength);\n    wavelength *= 0.5;', '/ wavelength); }\n    wavelength *= 0.5;'],
    ],
  },

  // #9 water-4: night water: glint early-out (exact) + wave-normal block gated at sun elevation dot > -0.2
  // (-0.05 is NOT exact); pose: night close zoom 100 km over ocean, plus terminator poses.
  waterNight: {
    match: '(m) => m.isMeshPhongMaterial',
    pairs: [
      [WATER_NORMAL, 'if (specularStrength > 0.0 && dot(waterUpView, directionalLights[0].direction) > -0.2) {$1float waterPx'],
      [WATER_GLINT, 'float waterGlint(vec3 l, vec3 v, vec3 n) {\n  if (dot(waterUpView, l) <= -0.02) return 0.0;'],
    ],
  },
}
