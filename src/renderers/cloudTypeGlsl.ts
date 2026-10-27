// The look of each kind of cloud at the shell's hit (tides-tvr.4.2): the
// blended cloud-type grid (./cloudBlend.ts, ../cloud-types.ts) read where the
// ray meets a cloud, its shares refined by the satellites' infrared there,
// and turned into the knobs the hit's shading takes (../cloud-types.ts
// lookOf()). Untyped, or where the grid has no confidence, the knobs are the
// untyped look's own defines, so those clouds draw as tides-tvr.3 did.
//
// GLSL for the shell's fragment stage, ahead of cloudDetail(), in the typed
// program only (CLOUD_TYPED): it reads FIELD's uCloudMap and uCloudMeasured,
// and the detail's RELIEF and DETAIL_* defines. Every number comes from
// ../cloud-types.ts, which mirrors it.
//
// And their columns (tides-tvr.4.3): the blend (./cloudBlend.ts) writes how
// each typed top is lowered or its base lifted into the blended map's alpha
// (CLOUD_TYPED_TOP_GLSL), which the typed march reads back in cloudColumn()
// (TYPED_CODE_GLSL, ./cloudShaders.ts).
import {
  CIRRUS_STRETCH,
  CLOUD_KINDS,
  type CloudKind,
  type CloudLook,
  CUMULUS_TOP_KM,
  IR_COLD_KM,
  LIFTED_THICKNESS_KM,
  IR_DECK_OPACITY,
  IR_DEEP_KM,
  IR_THIN_OPACITY,
  IR_WARM_KM,
  IR_WEIGHT,
  NEUTRAL_LOOK,
  STRETCH_EDGES,
  STRETCH_POLE_EDGES,
  TYPE_LOOKS,
  TYPE_SHAPES,
  TYPE_TOP_KM,
  TYPED_LIFT_EASE_KM,
  TYPED_LIFT_KM,
  TYPED_LIFT_SHARES,
  TYPED_LIFT_STEPS,
  TYPED_LOWEST_SHARE,
  TYPED_ZERO_CODE,
  TYPED_ZERO_SLACK,
} from '../cloud-types'
import { MAX_CLOUD_TOP_KM, MIN_MEASURED_TOP_KM } from '../cloud-layer'

const f = (x: number) => x.toFixed(6)

// The grid's order: R cirrus, G cumulus, B alto, and stratus the rest.
const KINDS = [TYPE_LOOKS.cirrus, TYPE_LOOKS.cumulus, TYPE_LOOKS.alto, TYPE_LOOKS.stratus]

/** A mat4 whose columns are each kind's knobs `keys`, so that the matrix
 * times the shares is their mix. */
function lookMatrix(keys: readonly (keyof CloudLook)[]): string {
  return `mat4(${KINDS.map((look) => `vec4(${keys.map((k) => f(look[k])).join(', ')})`).join(',\n  ')})`
}

// lookD: the detail and relief (relief, interior, edge, grain); lookL: the
// rest (stretch, occ, under, alpha).
const D_KEYS = ['relief', 'interior', 'edge', 'grain'] as const
const L_KEYS = ['stretch', 'occ', 'under', 'alpha'] as const

// The shares refined by the infrared (refineWithIr()): the look's at the hit,
// and the typed tops' in the blend (CLOUD_TYPED_TOP_GLSL).
export const CLOUD_TYPE_SHARES_GLSL = /* glsl */ `
// The shares in t (a type texel) refined by the infrared in raw (the cloud
// map's texel: top height over MAX_CLOUD_TOP_KM, opacity, trust):
// refineWithIr(). Cold, thin tops toward cirrus, deep, opaque ones toward
// cumulus, warm opaque ones toward low cloud: a deck where the top is near
// opaque, else split as the model splits it. raw is all 0 where the map has
// no measured heights (cloudLook()), so its trust needs no other gate.
vec4 cloudTypeShares(vec4 t, vec3 raw) {
  vec4 s = vec4(t.rgb, max(1.0 - t.r - t.g - t.b, 0.0));
  float w = ${f(IR_WEIGHT)} * raw.b;
  float km = raw.r * ${f(MAX_CLOUD_TOP_KM)};
  float cold = smoothstep(${f(IR_COLD_KM[0])}, ${f(IR_COLD_KM[1])}, km);
  float deep = smoothstep(${f(IR_DEEP_KM[0])}, ${f(IR_DEEP_KM[1])}, km);
  float warm = 1.0 - smoothstep(${f(IR_WARM_KM[0])}, ${f(IR_WARM_KM[1])}, km);
  float thin = 1.0 - smoothstep(${f(IR_THIN_OPACITY[0])}, ${f(IR_THIN_OPACITY[1])}, raw.g);
  float toLow = warm * (1.0 - thin);
  float deck = smoothstep(${f(IR_DECK_OPACITY[0])}, ${f(IR_DECK_OPACITY[1])}, raw.g);
  float low = s.y + s.w;
  vec4 lowSplit = mix(low > 1e-3 ? vec4(0.0, s.y, 0.0, s.w) / low : vec4(0.0, 0.0, 0.0, 1.0),
    vec4(0.0, 0.0, 0.0, 1.0), deck);
  vec4 target = cold * thin * vec4(1.0, 0.0, 0.0, 0.0) + deep * (1.0 - thin) * vec4(0.0, 1.0, 0.0, 0.0)
    + toLow * lowSplit;
  return s * (1.0 - w * (cold * thin + deep * (1.0 - thin) + toLow)) + w * target;
}
`

export const CLOUD_LOOK_GLSL = /* glsl */ `
// The blended type grid (R cirrus, G cumulus, B alto, A confidence), and
// whether the map shown has one at all.
uniform sampler2D uCloudType;
uniform float uCloudTyped;

// The untyped look: the detail's own defines, so that it is the same
// literals, and the knobs tides-tvr.3 doesn't have at 1 (none for stretch).
#define LOOK_NEUTRAL_D vec4(RELIEF, DETAIL_INTERIOR, DETAIL_EDGE, DETAIL_RELIEF)
#define LOOK_NEUTRAL_L vec4(${L_KEYS.map((k) => f(NEUTRAL_LOOK[k])).join(', ')})
// Cirrus's detail: its noise's scale across the pole axis, drawn out east-
// west, and the stretch share over which it goes from round to stretched,
// faded toward the poles by |sin latitude|.
#define CLOUD_STRETCH vec3(${f(1 / CIRRUS_STRETCH)}, 1.0, ${f(1 / CIRRUS_STRETCH)})
#define STRETCH_FROM ${f(STRETCH_EDGES[0])}
#define STRETCH_TO ${f(STRETCH_EDGES[1])}
#define STRETCH_POLE_FROM ${f(STRETCH_POLE_EDGES[0])}
#define STRETCH_POLE_TO ${f(STRETCH_POLE_EDGES[1])}
// Each kind's knobs, a column each: cirrus, cumulus, alto, stratus.
const mat4 LOOK_D = ${lookMatrix(D_KEYS)};
const mat4 LOOK_L = ${lookMatrix(L_KEYS)};
${CLOUD_TYPE_SHARES_GLSL}
// The look at map coordinates st (the cloud map's, drift and all), read at
// the hit's mip lod: lookOf(). Untyped, or with no confidence, exactly the
// untyped look, and nothing is read. textureLod, as it runs past the
// discards.
void cloudLook(vec2 st, float lod, out vec4 lookD, out vec4 lookL) {
  lookD = LOOK_NEUTRAL_D;
  lookL = LOOK_NEUTRAL_L;
  if (uCloudTyped < 0.5) return;
  vec4 t = textureLod(uCloudType, st, 0.0);
  if (t.a <= 0.0) return;
  // The map's own texel there, no further than a mip down: further, its
  // heights average with clear texels' 0 and the type would change with
  // the zoom. The heights are only there where the map is measured.
  vec3 raw = uCloudMeasured > 0.5 ? textureLod(uCloudMap, st, min(lod, 1.0)).rgb : vec3(0.0);
  vec4 s = cloudTypeShares(t, raw);
  lookD += t.a * (LOOK_D * s - LOOK_NEUTRAL_D);
  lookL += t.a * (LOOK_L * s - LOOK_NEUTRAL_L);
}
`

// How the alpha codes the typed column (../cloud-types.ts typedTopCode(),
// typedColumn()): under TYPED_ZERO_CODE, the share of the untyped top's
// height kept (code over TYPED_ZERO_CODE, at least TYPED_LOWEST_SHARE); over
// it, how far the base is lifted, TYPED_LIFT_KM over TYPED_LIFT_STEPS codes,
// the column then a layer LIFTED_THICKNESS(alpha) km deep once lifted
// TYPED_LIFT_EASE_KM; within TYPED_ZERO_SLACK of it, no change.
export const TYPED_CODE_GLSL = /* glsl */ `
#define TYPED_ZERO_CODE ${f(TYPED_ZERO_CODE)}
#define TYPED_ZERO_SLACK ${f(TYPED_ZERO_SLACK)}
#define TYPED_LOWEST_SHARE ${f(TYPED_LOWEST_SHARE)}
#define TYPED_LIFT_KM_PER_CODE (${f(TYPED_LIFT_KM)} / ${f(TYPED_LIFT_STEPS)})
#define TYPED_LIFT_STEPS ${f(TYPED_LIFT_STEPS)}
#define TYPED_LIFT_EASE_KM ${f(TYPED_LIFT_EASE_KM)}
#define LIFTED_THICKNESS(alpha) (${f(LIFTED_THICKNESS_KM[0])} + ${f(LIFTED_THICKNESS_KM[1])} * (alpha))
`

/** A vec4 of each kind's `value`, in the grid's order. */
const kinds = (value: (kind: CloudKind) => string) => `vec4(${CLOUD_KINDS.map(value).join(', ')})`

// The blend's: the alpha for the blended map's texel c (its height over
// MAX_CLOUD_TOP_KM, opacity and trust, the height and trust 0 where no
// input measured them, as the march reads them) under the blended type
// texel t: typedTopCode() of the shares refined by the infrared there. No
// confidence, no change (TYPED_ZERO_CODE): the untyped clouds', and the
// static ones'. The untyped top is cloudColumn()'s, and each kind's as
// ../cloud-types.ts has it, its top where unmeasured mixed toward the
// measured one by the trust and shaped by its opacity. Mostly cirrus and
// alto (R and B), the column is lifted; short of a code's lift, the top is
// lowered, never raised, so that it stays on the ground.
export const CLOUD_TYPED_TOP_GLSL = /* glsl */ `
${TYPED_CODE_GLSL}
// Each kind's shape (typeShape()): the share of its height it keeps at no
// opacity, all of it from TYPE_SHAPE_FROM to TYPE_SHAPE_TO.
#define TYPE_SHAPE_FLOOR ${kinds((k) => f(TYPE_SHAPES[k][0]))}
#define TYPE_SHAPE_FROM ${kinds((k) => f(TYPE_SHAPES[k][1]))}
#define TYPE_SHAPE_TO ${kinds((k) => f(TYPE_SHAPES[k][2]))}
${CLOUD_TYPE_SHARES_GLSL}
float cloudTypedCode(vec4 t, vec3 c) {
  if (t.a <= 0.0) return TYPED_ZERO_CODE / 255.0;
  vec4 s = cloudTypeShares(t, c);
  float g = c.g;
  float measured = max(c.r * ${f(MAX_CLOUD_TOP_KM)}, ${f(MIN_MEASURED_TOP_KM)});
  float untyped = mix(1.5 + 7.0 * g * g, measured, c.b) * (0.25 + 0.75 * smoothstep(0.0, 0.65, g));
  vec4 km = mix(${kinds((k) => (k === 'cumulus' ? `${f(CUMULUS_TOP_KM[0])} + ${f(CUMULUS_TOP_KM[1])} * g * g` : f(TYPE_TOP_KM[k])))},
    vec4(measured), c.b);
  vec4 shape = TYPE_SHAPE_FLOOR + (1.0 - TYPE_SHAPE_FLOOR) * smoothstep(TYPE_SHAPE_FROM, TYPE_SHAPE_TO, vec4(g));
  float typed = dot(s, km * shape);
  float lifting = smoothstep(${f(TYPED_LIFT_SHARES[0])}, ${f(TYPED_LIFT_SHARES[1])}, s.x + s.z);
  float lift = t.a * lifting * max(typed - min(untyped, LIFTED_THICKNESS(g)), 0.0);
  if (lift >= TYPED_LIFT_KM_PER_CODE) {
    return (TYPED_ZERO_CODE + min(lift / TYPED_LIFT_KM_PER_CODE, TYPED_LIFT_STEPS)) / 255.0;
  }
  float keep = clamp(mix(1.0, typed / max(untyped, 1e-6), t.a), TYPED_LOWEST_SHARE, 1.0);
  return TYPED_ZERO_CODE * keep / 255.0;
}
`
