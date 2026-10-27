// The sky's radiance as the sea reflects it (tides-07z): a small local model
// of the clear sky over the eye, for the water's Fresnel reflection
// (./water.ts) on the globe's ground and the streamed tiles. Open water is
// dark under any Sun (its body reflects a few percent at most), so what makes
// it read as water from low down is the sky it mirrors: a few percent of the
// zenith's blue looking down, nearly all of the horizon's paler glow at
// grazing. Phong's Blinn-Phong glint gave none of that, and the sea away from
// the Sun's highlight went near-black.
//
// Not the atmosphere's own scattering (shaders/atmosphere, owned elsewhere
// and far too costly to march per ground pixel): a few terms in the
// direction r against the local up and the Sun, all relative to the Sun's
// colour, so the caller multiplies by directionalLights[0].color and the
// reflection dims with the Sun's own light (the cloud shadow, the eclipse,
// the terrain shadow, which multiply directSpecular after it). With s the
// Sun's elevation's sine, e the ray's over the horizon and c its cosine to
// the Sun:
// - the level: SKY_LEVEL of the Sun's colour at full day, fading through
//   civil twilight to nothing (SKY_DAY), never under SKY_FLOOR of it while
//   the Sun is up (a low Sun still lights a bright sky);
// - the colour: the atmosphere's own zenith blue (ATMOSPHERE_SKY) toward a
//   paler horizon (SKY_HORIZON), which under a low Sun warms toward the
//   atmosphere's dusk (ATMOSPHERE_DUSK), more on the Sun's side;
// - a soft brightening round the Sun (the aureole), not the Sun's disc: the
//   disc is the glint's (water.ts's microfacet term).
// skyRadiance() mirrors the GLSL; the test checks its shape.
import { ATMOSPHERE_DUSK, ATMOSPHERE_SKY } from './earth-shells'

/** The sky's radiance at full day, over the Sun's colour. */
export const SKY_LEVEL = 0.06
/** The level's share left at sunrise (sqrt(s) brings the rest by noon). */
export const SKY_FLOOR = 0.25
/** sin(elevation) over which the sky comes up: dark at -0.10 (about the end
 * of civil twilight's brightest part), full day's rule at 0.05. */
export const SKY_DAY = [-0.1, 0.05] as const
/** sin(elevation) by which the dusk's warmth has gone. */
export const SKY_DUSK_END = 0.3
/** The horizon's colour by day (linear). */
export const SKY_HORIZON: readonly [number, number, number] = [0.75, 0.85, 1.0]

const f = (x: number) => x.toFixed(6)
const v3 = (c: readonly [number, number, number]) => `vec3(${c.map(f).join(', ')})`

/** skyRadiance(dir, up, sun): unit vectors in any one frame. */
export const SKY_RADIANCE_GLSL = /* glsl */ `
vec3 skyRadiance(vec3 dir, vec3 up, vec3 sun) {
  float s = dot(up, sun);
  float e = saturate(dot(dir, up));
  float c = saturate(dot(dir, sun));
  float day = smoothstep(${f(SKY_DAY[0])}, ${f(SKY_DAY[1])}, s);
  float level = ${f(SKY_LEVEL)} * day * (${f(SKY_FLOOR)} + ${f(1 - SKY_FLOOR)} * sqrt(saturate(s)));
  float dusk = (1.0 - smoothstep(0.0, ${f(SKY_DUSK_END)}, s)) * (0.4 + 0.6 * c);
  vec3 horizon = mix(${v3(SKY_HORIZON)}, ${v3(ATMOSPHERE_DUSK)}, 0.6 * dusk);
  float toHorizon = 1.0 - e;
  float c2 = c * c;
  float c4 = c2 * c2;
  return level * mix(${v3(ATMOSPHERE_SKY)}, horizon, toHorizon * toHorizon * toHorizon) * (1.0 + 0.5 * c4 * c4);
}
`

type Vec3 = readonly [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const saturate = (x: number) => Math.min(Math.max(x, 0), 1)
const smoothstep = (a: number, b: number, x: number) => {
  const t = saturate((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The sky's radiance along `dir` over the Sun's colour, as the GLSL's
 * skyRadiance() (unit vectors). */
export function skyRadiance(dir: Vec3, up: Vec3, sun: Vec3): [number, number, number] {
  const s = dot(up, sun)
  const e = saturate(dot(dir, up))
  const c = saturate(dot(dir, sun))
  const day = smoothstep(SKY_DAY[0], SKY_DAY[1], s)
  const level = SKY_LEVEL * day * (SKY_FLOOR + (1 - SKY_FLOOR) * Math.sqrt(saturate(s)))
  const dusk = (1 - smoothstep(0, SKY_DUSK_END, s)) * (0.4 + 0.6 * c)
  const toHorizon = (1 - e) ** 3
  const aureole = 1 + 0.5 * c ** 8
  return [0, 1, 2].map((i) => {
    const horizon = SKY_HORIZON[i] + (ATMOSPHERE_DUSK[i] - SKY_HORIZON[i]) * 0.6 * dusk
    return level * (ATMOSPHERE_SKY[i] + (horizon - ATMOSPHERE_SKY[i]) * toHorizon) * aureole
  }) as [number, number, number]
}
