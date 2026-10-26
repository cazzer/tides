// The clouds' shadows on the streamed tiles (tides-zmw.9.12): the globe's
// ground shadow (../cloudShaders.ts CLOUD_GROUND_GLSL, clouds.groundPatch's
// fragment) on the tiles' frame, on the cloud layer's own uniforms (the map,
// drift, Sun and sea level EarthRenderer sets each frame), so a shadow falls
// on a tile where it falls on the globe.
//
// The globe reads its ground point from a varying, vCloudGround (the ground
// mesh's position, in its frame, before the displacement). On the tiles the
// point's direction is the base's surfaceUp, the globe's for the same ground
// (the displacement is radial); cloudGroundShadow() takes nothing else of
// the point but the blur's footprint, length(fwidth(vCloudGround)), renamed
// to surfaceCloudFootprint.
//
// Per vertex, with the fragment's own where the blur is wider. Per fragment
// the globe's shadow costs the tiles +0.58 ms at 1080p at the canyon stop
// (headless burst, same tiles in one page: three sunbeam samples, each an
// atan, an asin and a tap, on every tile pixel), past the 0.4 ms budget. A
// tile has far fewer vertices than pixels (~230k drawn there), and the
// shadow is a smooth field (blurred to cloudLod 2.5 at least: mip texels of
// 60 km and more, where the tiles' vertices are metres to tens of km
// apart), so the vertex stage runs the globe's function at that floor (a
// footprint of ~0: not 0, whose log2 is undefined) and the fragment
// interpolates it: +0.12 ms (min) to +0.3 ms (p50) on a shared GPU, where
// per fragment measured +0.8 to +1.0. The fragment takes the footprint from
// surfaceRay's derivatives (surfaceGround is quantised to ~0.5 m), which
// differentiate the displaced surface, not the globe's undisplaced sphere:
// the step between neighbouring pixels' ground points with its rise
// included, so at least the globe's footprint for the same ground and more
// on steep relief (more blur, never less). Where that asks for more blur
// than the floor (pixels tens of km wide, a sliver at the horizon) the
// fragment runs the globe's function itself. One float varying.
//
// The switch is on the pixel's footprint, not the vertices' spacing, which
// the errorTarget and coarse parent tiles stretch. Measured against the
// same tiles shaded per fragment (headless, top of the band, 173 and 152
// km, pitch -8 to -35, two Sun heights), the edges sit within p90 0.6 to
// 1.1 px at errorTarget 4, 1.1 at 8 and 2.4 (3.2 in the horizon's third)
// at 16, about two levels of children missing; p99 3 to 6.5 px. The field
// is too blurred for a linear step across a vertex spacing to move an edge
// far. Against the globe at the same pose the shadow's edges sit within
// 1.2 to 1.5 px (median), 3.3 to 4.2 px (p90), through the handover band.
//
// The heads go after the base's (the fragment's reads surfaceRay); the
// light after lights_fragment_end, as on the globe. The haze's head, later
// in the list, lands above them at common and drops its uSeaLevel macro
// after itself, so the cloud field's own uSeaLevel and uSunDir uniforms
// declare as on the globe, where the haze comes after the clouds too.
import { CLOUD_GROUND_GLSL } from '../cloudShaders'
import { injectAfterChunk, renameInSnippet, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile clouds'

/** The blur's floor in cloudGroundShadow(): max(cloudLod(...) + 1.0, 2.5). */
export const CLOUD_GROUND_LOD_FLOOR = 2.5

const VARYING = 'varying float vSurfaceCloudLit;'

/** The adapter's GLSL for a cloud layer that is `flat` (the low tier's)
 * (the test checks it against the globe's). */
export function tileCloudsGlsl(flat: boolean) {
  const footprint = renameInSnippet(
    CLOUD_GROUND_GLSL.head(flat),
    'length(fwidth(vCloudGround))',
    'surfaceCloudFootprint',
    WHAT,
    1
  )
  const head = (declarations: string) => renameInSnippet(footprint, 'varying vec3 vCloudGround;', declarations, WHAT, 1)
  return {
    /** Vertex globals: the field and the shadow at the blur's floor. */
    vertexHead: head(`${VARYING}\nconst float surfaceCloudFootprint = 1e-20;`),
    /** Vertex main, with the base's surfaceUp set. */
    vertexBody: 'vSurfaceCloudLit = cloudGroundShadow(normalize(surfaceUp));',
    fragmentHead: head(`${VARYING}\nfloat surfaceCloudFootprint;`),
    /** Fragment main, early, in uniform control flow for the derivatives. */
    fragmentBody: 'surfaceCloudFootprint = length(fwidth(surfaceRay));',
    light: renameInSnippet(
      CLOUD_GROUND_GLSL.light,
      'cloudGroundShadow(normalize(vCloudGround))',
      `(cloudLod(surfaceCloudFootprint) + 1.0 > ${CLOUD_GROUND_LOD_FLOOR.toFixed(1)} ? cloudGroundShadow(surfaceUp) : vSurfaceCloudLit)`,
      WHAT,
      1
    ),
  }
}

/** As the globe's cloud layer: its shadows on the tiles. */
export const tileClouds: TileAdapter = (link) => {
  const { flat, uniforms } = link.clouds
  const glsl = tileCloudsGlsl(flat)
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = surfaceInject(
          surfaceInject(shader.vertexShader, 'vertexHead', glsl.vertexHead),
          'vertexBody',
          glsl.vertexBody
        )
        shader.fragmentShader = injectAfterChunk(
          surfaceInject(
            surfaceInject(shader.fragmentShader, 'fragmentHead', glsl.fragmentHead),
            'fragmentBody',
            glsl.fragmentBody
          ),
          'lights_fragment_end',
          glsl.light,
          WHAT
        )
      },
      customProgramCacheKey: () => `cloud-shadow${flat ? '-flat' : ''}-surface`,
    },
  }
}
