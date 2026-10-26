// Bakes the photosphere into a cube map once (sun-surface.ts): the costly
// cellular noise runs at load, a face per frame, never while drawing.
//   r, g: two granulation patterns the surface shader cross-fades between,
//         so the cells seem to boil without any per-frame noise;
//   b:    the sunspots, as a brightness factor (1 = none, ~0.1 = umbra);
//   a:    plage and the supergranular network, bright where faculae show.
// Directions are in the Sun's frame (+Y the pole), so all of it turns with
// the Sun. SUN_SPOTS and SUN_REGIONS are defined by sun-surface.ts.
uniform vec4 uSpots[SUN_SPOTS];      // xyz centre, w umbra radius (rad)
uniform vec4 uSpotShape[SUN_SPOTS];  // x penumbra/umbra, y stretch, z seed
uniform vec4 uRegions[SUN_REGIONS];  // xyz centre, w plage radius (rad)
uniform float uGranules;
varying vec3 vDirection;

#include ../aurora/noise3.glsl

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

// Distances to the nearest and second-nearest cell centres (Worley F1, F2).
vec2 worley(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + 0.15 + 0.7 * hash3(cell + o) - f;
    float d = dot(r, r);
    if (d < d1) {
      d2 = d1;
      d1 = d;
    } else if (d < d2) {
      d2 = d;
    }
  }
  return sqrt(vec2(d1, d2));
}

// Granules: bright, domed cell interiors between narrow dark lanes, the
// lanes warped so the cells read as irregular polygons, not a lattice.
float granulation(vec3 n, vec3 offset) {
  vec3 p = n * uGranules + offset;
  p += 0.35 * vec3(snoise3(p * 0.5), snoise3(p * 0.5 + 17.0), snoise3(p * 0.5 + 41.0));
  vec2 f = worley(p);
  float edge = f.y - f.x;
  float lane = smoothstep(0.02, 0.3, edge);
  float dome = 1.0 - 0.8 * f.x * f.x;
  // Some cells run hotter than others.
  float cellHeat = 0.85 + 0.3 * hash3(floor(p + 0.5)).x;
  return clamp(lane * dome * cellHeat, 0.0, 1.0);
}

void main() {
  vec3 n = normalize(vDirection);

  float a = granulation(n, vec3(0.0));
  float b = granulation(n, vec3(31.7, 12.3, 57.9));

  // The supergranular network: faint bright lanes ~30x a granule across.
  vec2 sg = worley(n * uGranules * 0.14 + 3.1 * snoise3(n * 6.0));
  float network = 1.0 - smoothstep(0.0, 0.12, sg.y - sg.x);

  float spot = 1.0;
  float plage = 0.0;
  for (int i = 0; i < SUN_REGIONS; i++) {
    float angle = acos(clamp(dot(n, uRegions[i].xyz), -1.0, 1.0));
    float reach = uRegions[i].w;
    if (angle > reach) continue;
    // Patchy plage across the region, densest at its middle.
    float patches = smoothstep(-0.2, 0.6, snoise3(n * 55.0 + float(i) * 7.0)
                                          + 0.5 * snoise3(n * 140.0));
    plage = max(plage, patches * smoothstep(reach, 0.35 * reach, angle));
  }
  for (int i = 0; i < SUN_SPOTS; i++) {
    vec3 c = uSpots[i].xyz;
    float umbra = uSpots[i].w;
    float ratio = uSpotShape[i].x;
    float angle = acos(clamp(dot(n, c), -1.0, 1.0));
    if (angle > umbra * ratio * 1.5) continue;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    vec3 north = cross(c, east);
    vec2 q = vec2(dot(n, east) / uSpotShape[i].y, dot(n, north)) / umbra;
    float rho = length(q);
    vec2 around = q / max(rho, 1e-5);
    float seed = uSpotShape[i].z;
    // Ragged edges, then radial penumbral filaments.
    float rag = 1.0 + 0.16 * snoise3(vec3(around * 1.4, seed))
                    + 0.07 * snoise3(vec3(around * 4.0, seed + 9.0));
    float r = rho / rag;
    float inUmbra = 1.0 - smoothstep(0.8, 1.08, r);
    float filaments = snoise3(vec3(around * 16.0, r * 0.7 + seed))
                    + 0.5 * snoise3(vec3(around * 38.0, r * 1.5 + seed));
    float pen = clamp(0.66 + 0.2 * filaments, 0.42, 0.9);
    float umb = 0.1 + 0.05 * smoothstep(0.4, 0.9, snoise3(vec3(q * 2.5, seed)));
    float inSpot;
    float level;
    if (ratio > 1.05) {
      inSpot = 1.0 - smoothstep(ratio * 0.9, ratio * 1.04, r);
      level = mix(pen, umb, inUmbra);
    } else {
      // A pore: a small dark knot with no penumbra.
      inSpot = 1.0 - smoothstep(0.6, 1.15, r);
      level = 0.3;
    }
    spot = min(spot, mix(1.0, level, inSpot));
  }
  // No faculae on top of a spot.
  plage *= smoothstep(0.6, 0.95, spot);

  gl_FragColor = vec4(a, b, spot, clamp(max(plage, 0.35 * network), 0.0, 1.0));
}
