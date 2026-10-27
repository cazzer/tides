// Bakes the Sun's face in extreme ultraviolet into a cube map once
// (sun-surface.ts): the costly noise runs at load, a face per frame, never
// while drawing. The look is SDO's 171-304 Å Sun, not white light: hot
// coronal plasma traced along the magnetic field.
//   r:    active-region structure: loop arcades between each region's two
//         poles, fans of open field off their outer sides, bright moss
//         over the poles themselves;
//   g:    the regions' broad, diffuse glow;
//   b:    darkening, as a brightness factor (1 = none): coronal holes and
//         filaments;
//   a:    the quiet Sun's network, mottle and bright points.
// Directions are in the Sun's frame (+Y the pole), so all of it turns with
// the Sun. SUN_REGIONS is defined by sun-surface.ts.
uniform vec4 uRegions[SUN_REGIONS];  // xyz centre, w reach (rad)
uniform vec4 uLead[SUN_REGIONS];     // xyz leading pole, w strength
uniform vec4 uFollow[SUN_REGIONS];   // xyz following pole, w span (rad)
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

// Brightness by field line: noise read round a circle by the line's label
// (an angle), so it has no seam where the angle wraps, and each line is lit
// along its whole length, which is what makes strands.
float strands(float label, float seed, float density) {
  vec2 c = vec2(cos(label), sin(label));
  float s = 0.55 * snoise3(vec3(c * density, seed))
          + 0.3 * snoise3(vec3(c * density * 2.7, seed + 5.0))
          + 0.15 * snoise3(vec3(c * density * 6.3, seed + 9.0));
  return smoothstep(-0.35, 0.9, s);
}

void main() {
  vec3 n = normalize(vDirection);

  float loops = 0.0;
  float glow = 0.0;
  for (int i = 0; i < SUN_REGIONS; i++) {
    vec3 c = uRegions[i].xyz;
    float span = uFollow[i].w;
    float strength = uLead[i].w;
    if (dot(n, c) < cos(min(uRegions[i].w * 2.6, 1.5))) continue;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    vec3 north = cross(c, east);
    // The tangent plane at the region, in units of the poles' separation.
    vec2 q = vec2(dot(n, east), dot(n, north)) / span;
    // Real fields are lumpy: bend the lines so no arc is a clean circle.
    vec3 w = n * 9.0 / span + float(i) * 3.1;
    q += 0.11 * vec2(snoise3(w * 0.12), snoise3(w * 0.12 + 17.0));
    vec2 a = vec2(dot(uLead[i].xyz, east), dot(uLead[i].xyz, north)) / span;
    vec2 b = vec2(dot(uFollow[i].xyz, east), dot(uFollow[i].xyz, north)) / span;
    vec2 da = q - a;
    vec2 db = q - b;
    float ra = length(da);
    float rb = length(db);
    float seed = float(i) * 13.7;

    // A bipole's field lines are the circles through both poles: each has
    // one value of arg(q - a) - arg(q - b), tight arcs between the poles,
    // wide ones round them.
    float label = atan(da.y, da.x) - atan(db.y, db.x);
    float d = length(q - 0.5 * (a + b));
    float arcade = strands(label, seed, 6.0) * exp(-d * d / 0.9);

    // Open field fanning off each pole's outer side, falling away with
    // distance: the bright plumes that splay out of an active region.
    vec2 axis = normalize(a - b);
    float fanA = strands(atan(da.y, da.x), seed + 2.0, 9.0)
               * smoothstep(-0.3, 0.6, dot(da / max(ra, 1e-4), axis))
               * smoothstep(0.2, 0.5, ra) * exp(-ra / 1.0);
    float fanB = strands(atan(db.y, db.x), seed + 4.0, 9.0)
               * smoothstep(-0.3, 0.6, dot(db / max(rb, 1e-4), -axis))
               * smoothstep(0.2, 0.5, rb) * exp(-rb / 0.8);

    // Moss: bright, knotty cores over the poles.
    float knots = smoothstep(-0.3, 0.8, snoise3(n * 220.0 + seed));
    float moss = (exp(-ra * ra / 0.06) + 0.8 * exp(-rb * rb / 0.08)) * (0.45 + 0.55 * knots);

    float weight = 0.45 + 0.55 * strength;
    loops += weight * (0.8 * arcade + 0.55 * (fanA + fanB) + 0.9 * moss);
    glow += weight * exp(-d * d / 6.0);
  }
  // Fine grain, so no arc reads as a clean vector line.
  loops *= 0.75 + 0.25 * snoise3(n * 160.0);

  // Coronal holes: dark, ragged caps over the poles, and a few patches of
  // quiet Sun at low latitude where no region sits.
  float rag = 0.12 * snoise3(n * 3.0 + 5.0) + 0.07 * snoise3(n * 11.0) + 0.04 * snoise3(n * 30.0);
  float polar = smoothstep(0.8, 0.92, abs(n.y) + rag);
  float lowHole = smoothstep(0.62, 0.8, snoise3(n * 1.2 + 31.0) + 1.6 * rag)
                * (1.0 - smoothstep(0.05, 0.35, glow));
  // Not clean blobs: plumes and bright points still show inside.
  float hole = max(polar, lowHole) * (0.8 + 0.2 * snoise3(n * 24.0));

  // Filament channels: soft, dark lanes drawn out east-west in the quiet
  // Sun (ridged noise here crosses itself in scribbles and claws).
  vec3 warp = vec3(snoise3(n * 3.0 + 50.0), snoise3(n * 3.0 + 60.0), snoise3(n * 3.0 + 70.0));
  float filament = smoothstep(0.62, 0.9, snoise3(n * vec3(1.8, 5.0, 1.8) + 0.5 * warp + 77.0))
                 * (1.0 - hole) * (1.0 - smoothstep(0.2, 0.6, glow));
  float darkening = (1.0 - 0.55 * hole) * (1.0 - 0.3 * filament);

  // The quiet Sun: a soft, fuzzy network round supergranules, a mottle
  // between and scattered bright points. Lines of any kind (warped cell
  // edges, ridged noise) read as contour rings close up, so all of it is
  // blurred.
  vec2 sg = worley(n * 13.0 + 0.4 * snoise3(n * 6.0));
  float network = 1.0 - smoothstep(0.0, 0.4, sg.y - sg.x);
  float mottle = 0.5 + 0.3 * snoise3(n * 30.0 + warp) + 0.12 * snoise3(n * 90.0);
  float points = smoothstep(0.5, 0.95, snoise3(n * 70.0)) * (0.5 + 0.5 * network);
  float quiet = 0.35 * network + 0.4 * mottle + 0.35 * points;

  gl_FragColor = vec4(clamp(vec3(loops, glow, darkening), 0.0, 1.0), clamp(quiet, 0.0, 1.0));
}
