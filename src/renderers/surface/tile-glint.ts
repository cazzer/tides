// The water's sun glint on the streamed tiles (tides-zmw.9.14): the globe's
// Phong specular (GLOBE_SPECULAR, GLOBE_SHININESS, which the composer's
// TerrainPhongMaterial already carries) with specularStrength from the
// globe's specular (water) mask, as the globe's specularmap_fragment takes
// it, sharpened at the coasts by the tile's own elevation.
//
// The mask is the globe's map (link.maps.specular, through a uniform: a
// slot would be freed with each tile), read at the base's surfaceGlobeUv
// with surfaceGlobeTex. Its texels are ~10 km (4096 px round the equator),
// so on its own it spills glint onto the land along every coast and fades it
// out over the water near the shore. The tile's elevation grid (bumpMap,
// metres at true scale; the displacement's, already bound: one tap) draws
// the coast to the DEM's texel: Mapterhorn's sea is exactly 0 m (no
// bathymetry), so
// - at sea level (|elevation| under ~0.5 m) the water takes the glint where
//   the mask holds any water at all (GLINT_SEA, a low ramp): near-shore
//   water glints fully up to the DEM's coastline, and the land beside it,
//   above sea level, doesn't;
// - anywhere else (land, inland lakes such as the Great Lakes at ~176 m,
//   and ground below the sea: the Caspian at -28 m, the Dead Sea's shores,
//   Death Valley, polders) only where the mask is mostly water (GLINT_INLAND,
//   a high ramp): a lake's open water glints, the land along its shore and
//   the sea's doesn't. The DEM can't tell a lake from land (lake surfaces
//   are not flat in it: half-metre steps), so inland the mask decides, as on
//   the globe, only sharper.
// Both are ANDed with the mask, so low-lying land the mask calls land
// (Death Valley, the Qattara) never glints, and the open sea (mask 1, 0 m)
// glints exactly as on the globe.
//
// No varyings, no feature defines: one tap of the mask (filtered for the
// pixel, no implicit derivatives) and one of the grid, after the base's
// anchor (below three's specularmap_fragment and the base's
// specularStrength = 0); and Phong's direct light with its specular term
// skipped on the land (below).
import { injectAfterChunk, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile glint'

/** |elevation| (m) over which the ground stops being the sea. */
export const GLINT_SEA_LEVEL = [0.25, 0.75] as const
/** The mask's ramp at sea level: any water near the coast. */
export const GLINT_SEA = [0.05, 0.3] as const
/** The mask's ramp elsewhere: mostly water. */
export const GLINT_INLAND = [0.6, 0.9] as const

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** specularStrength for the globe's `mask` (0 land to 1 water) over ground
 * at `elevation` metres, as the GLSL computes it. */
export function glintStrength(mask: number, elevation: number): number {
  const sea = 1 - smoothstep(GLINT_SEA_LEVEL[0], GLINT_SEA_LEVEL[1], Math.abs(elevation))
  const inland = smoothstep(GLINT_INLAND[0], GLINT_INLAND[1], mask)
  return inland + (smoothstep(GLINT_SEA[0], GLINT_SEA[1], mask) - inland) * sea
}

const f = (x: number) => x.toFixed(6)

const HEAD = /* glsl */ `
uniform sampler2D uTileSpecularMap;
`

// The library's tiles always bind the grid as the bump map; without one
// (never on a lit tile) the mask decides alone, as inland.
const SPECULAR = /* glsl */ `
{
  float glintMask = surfaceGlobeTex(uTileSpecularMap, surfaceGlobeUv).r;
  #ifdef USE_BUMPMAP
    float glintSea = 1.0 - smoothstep(${f(GLINT_SEA_LEVEL[0])}, ${f(GLINT_SEA_LEVEL[1])}, abs(texture2D(bumpMap, vBumpMapUv).x));
  #else
    float glintSea = 0.0;
  #endif
  specularStrength = mix(smoothstep(${f(GLINT_INLAND[0])}, ${f(GLINT_INLAND[1])}, glintMask),
    smoothstep(${f(GLINT_SEA[0])}, ${f(GLINT_SEA[1])}, glintMask), glintSea);
}
`

// three r180's RE_Direct_BlinnPhong (lights_phong_pars_fragment as three
// ships it, blank lines stripped; the test pins it to three's text) with
// its specular term skipped where the strength is 0 (the land), which
// leaves those pixels as they were: with the base's constant
// specularStrength = 0 the compiler dropped Blinn-Phong altogether, and the
// glint's strength brings it back for every light.
export const BLINN_PHONG_DIRECT = /* glsl */ `void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
\tfloat dotNL = saturate( dot( geometryNormal, directLight.direction ) );
\tvec3 irradiance = dotNL * directLight.color;
\treflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
\treflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}`

const GATED_DIRECT = `${BLINN_PHONG_DIRECT.replace('RE_Direct_BlinnPhong(', 'RE_Direct_TileGlint(').replace(
  '\treflectedLight.directSpecular +=',
  '\tif ( material.specularStrength > 0.0 ) reflectedLight.directSpecular +='
)}
#undef RE_Direct
#define RE_Direct RE_Direct_TileGlint
`

/** The adapter's GLSL (the test checks it). */
export const TILE_GLINT_GLSL = { head: HEAD, specular: SPECULAR, direct: GATED_DIRECT }

export const tileGlint: TileAdapter = (link) => {
  const uniforms = { uTileSpecularMap: link.maps.specular }
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        let fragment = surfaceInject(surfaceInject(shader.fragmentShader, 'fragmentHead', HEAD), 'specular', SPECULAR)
        fragment = injectAfterChunk(fragment, 'lights_phong_pars_fragment', GATED_DIRECT, WHAT)
        shader.fragmentShader = fragment
      },
      customProgramCacheKey: () => 'glint-surface',
    },
  }
}
