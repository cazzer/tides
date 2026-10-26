// The look of each kind of cloud at the shell's hit (tides-tvr.4.2): the
// blended cloud-type grid (./cloudBlend.ts, ../cloud-types.ts) read where the
// ray meets a cloud, its shares refined by the satellites' infrared there,
// and turned into the knobs the hit's shading takes (../cloud-types.ts
// lookOf()). Untyped, or where the grid has no confidence, the knobs are the
// untyped look's own defines, so those clouds draw as tides-tvr.3 did.
//
// GLSL for the shell's fragment stage, after cloudDetail(): it reads FIELD's
// uCloudMap and uCloudMeasured, and the detail's RELIEF and DETAIL_* defines.
// Every number comes from ../cloud-types.ts, which mirrors it.
import {
  CIRRUS_STRETCH,
  type CloudLook,
  IR_COLD_KM,
  IR_DEEP_KM,
  IR_THIN_OPACITY,
  IR_WARM_KM,
  IR_WEIGHT,
  NEUTRAL_LOOK,
  STRETCH_EDGES,
  STRETCH_POLE_EDGES,
  TYPE_LOOKS,
} from '../cloud-types'
import { MAX_CLOUD_TOP_KM } from '../cloud-layer'

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

// The shares in t (a type texel) refined by the infrared in raw (the cloud
// map's texel: top height over MAX_CLOUD_TOP_KM, opacity, trust):
// refineWithIr(). Cold, thin tops toward cirrus, deep, opaque ones toward
// cumulus, warm ones toward low cloud, split as the model splits it.
vec4 cloudTypeShares(vec4 t, vec3 raw) {
  vec4 s = vec4(t.rgb, max(1.0 - t.r - t.g - t.b, 0.0));
  float w = ${f(IR_WEIGHT)} * raw.b * uCloudMeasured;
  float km = raw.r * ${f(MAX_CLOUD_TOP_KM)};
  float cold = smoothstep(${f(IR_COLD_KM[0])}, ${f(IR_COLD_KM[1])}, km);
  float deep = smoothstep(${f(IR_DEEP_KM[0])}, ${f(IR_DEEP_KM[1])}, km);
  float warm = 1.0 - smoothstep(${f(IR_WARM_KM[0])}, ${f(IR_WARM_KM[1])}, km);
  float thin = 1.0 - smoothstep(${f(IR_THIN_OPACITY[0])}, ${f(IR_THIN_OPACITY[1])}, raw.g);
  float low = s.y + s.w;
  vec4 lowSplit = low > 1e-3 ? vec4(0.0, s.y, 0.0, s.w) / low : vec4(0.0, 0.0, 0.0, 1.0);
  vec4 target = cold * thin * vec4(1.0, 0.0, 0.0, 0.0) + deep * (1.0 - thin) * vec4(0.0, 1.0, 0.0, 0.0)
    + warm * lowSplit;
  return s * (1.0 - w * (cold * thin + deep * (1.0 - thin) + warm)) + w * target;
}

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
  // The same texel cloudColumn() just read, at its own resolution; the
  // heights are only there where the map is measured.
  vec3 raw = uCloudMeasured > 0.5 ? textureLod(uCloudMap, st, lod).rgb : vec3(0.0);
  vec4 s = cloudTypeShares(t, raw);
  lookD += t.a * (LOOK_D * s - LOOK_NEUTRAL_D);
  lookL += t.a * (LOOK_L * s - LOOK_NEUTRAL_L);
}
`
