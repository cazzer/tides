// The value noise behind the fine detail where a map is magnified: the
// clouds' edges and tops (tides-01v.2, ./cloudShaders.ts) and the ground
// (tides-01v.4, ./groundDetail.ts). Both sum octaves of it in object space,
// each octave turned off the last one's lattice, so nothing tiles, seams at
// the dateline or pinches at the poles.
import * as THREE from 'three'

const f = (x: number) => x.toFixed(6)

// Turns each detail octave off the last one's lattice: powers of one
// orthonormal turn, as GLSL mat3s. Precomputed, since chaining the product in
// the shader's loop costs more than the noise itself on the flat path.
const DETAIL_TURN = new THREE.Matrix3().fromArray([0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64])

/** GLSL: `const mat3 DETAIL_TURNS[octaves]`, the turn for each octave. */
export function detailTurnsGlsl(octaves: number): string {
  const turn = new THREE.Matrix3()
  const turns: string[] = []
  for (let k = 0; k < octaves; k++) {
    turns.push(`mat3(${turn.elements.map(f).join(', ')})`)
    turn.premultiply(DETAIL_TURN)
  }
  return `const mat3 DETAIL_TURNS[${octaves}] = mat3[](${turns.join(',\n  ')});`
}

/** GLSL: detailNoise(p), value noise in 0..1 (x) and its gradient (yzw). */
export const DETAIL_NOISE_GLSL = /* glsl */ `
// A lattice corner's value, 0..1, from its axes' hashes xored together.
float detailCorner(uint h) {
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967295.0);
}

// Value noise, 0..1, and its gradient (Quilez's analytic derivatives; checked
// by hand, not by a test: re-check the k terms after any edit).
vec4 detailNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 du = 6.0 * f * (1.0 - f);
  // Each axis hashed once for both its lattice lines, shared by the corners.
  const uvec3 SPREAD = uvec3(0x8da6b343u, 0xd8163841u, 0xcb1ab31fu);
  uvec3 lo = uvec3(ivec3(i)) * SPREAD;
  uvec3 hi = lo + SPREAD;
  float a = detailCorner(lo.x ^ lo.y ^ lo.z);
  float b = detailCorner(hi.x ^ lo.y ^ lo.z);
  float e = detailCorner(lo.x ^ hi.y ^ lo.z);
  float g = detailCorner(hi.x ^ hi.y ^ lo.z);
  float h = detailCorner(lo.x ^ lo.y ^ hi.z);
  float k = detailCorner(hi.x ^ lo.y ^ hi.z);
  float m = detailCorner(lo.x ^ hi.y ^ hi.z);
  float n = detailCorner(hi.x ^ hi.y ^ hi.z);
  float k1 = b - a;
  float k2 = e - a;
  float k3 = h - a;
  float k4 = a - b - e + g;
  float k5 = a - e - h + m;
  float k6 = a - b - h + k;
  float k7 = -a + b + e - g + h - k - m + n;
  return vec4(
    a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x
      + k7 * u.x * u.y * u.z,
    du * vec3(
      k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
      k2 + k4 * u.x + k5 * u.z + k7 * u.x * u.z,
      k3 + k5 * u.y + k6 * u.x + k7 * u.x * u.y));
}
`
