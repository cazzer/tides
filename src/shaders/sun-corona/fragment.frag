uniform samplerCube uCorona;
// The Sun's sunDiscTint() at its centre, seen from inside Earth's air.
uniform vec3 uAirTint;
varying vec2 vPlane;
varying float vOuter;
varying vec3 vSolarPlane;
varying vec3 vSolarLimb;

void main() {
  // r is in limb radii from the centre; x is the height above the limb.
  float r = length(vPlane);
  if (r >= vOuter) discard;
  float x = max(r - 1.0, 0.0);
  // Which way is out, in the Sun's frame (+Y its pole): everything below is
  // a function of it, so the structure turns with the Sun, not the screen.
  vec3 d = normalize(vSolarPlane / max(r, 1e-4) + vSolarLimb);
  float lat = d.y;
  // The baked pattern (sun-bake/corona.frag), signed.
  vec3 pattern = textureCube(uCorona, d).rgb * 2.0 - 1.0;

  // Helmet streamers: broad bright bases over the active latitudes that
  // narrow, as the threshold rises with height, into long radial stalks.
  float activity = pattern.r;
  float belt = 0.45 + 0.55 * exp(-lat * lat * 5.0);
  float rise = clamp(x / 1.6, 0.0, 1.0);
  float streamer = smoothstep(0.02 + 0.45 * rise, 0.75, activity * belt + 0.12);
  // Polar plumes: short, fine rays over the poles' coronal holes.
  float pole = smoothstep(0.72, 0.95, abs(lat));
  // Fine radial striation, the same at every height so it reads as rays.
  float rays = pattern.g;
  float fibre = 0.9 + 0.1 * rays;

  // The glow at the limb: steep and warm, frayed by the rays and brighter
  // over active longitudes, as the limb is fringed with unresolved loops...
  float fray = (0.85 + 0.3 * max(rays, 0.0)) * (0.8 + 0.4 * max(activity, 0.0));
  // Only the thin glow at the limb frays: rays in the wide one read as a
  // lens flare.
  float inner = 0.3 * exp(-x / 0.045) * mix(1.0, fray, smoothstep(0.0, 0.03, x)) + 0.13 * exp(-x / 0.2);
  // ...then pale streamers falling off with height, and plumes at the poles.
  float corona = (0.012 + 0.055 * streamer) * fibre * pow(r, -2.6) * exp(-x / 1.4)
               + 0.025 * pole * (0.85 + 0.15 * rays) * exp(-x / 0.22);

  // The chromosphere: a thin pink rim with a fringe of spicules. It carries
  // on under r = 1, where the Sun hides it, so no seam opens at the limb.
  float spicules = 0.75 + 0.5 * pattern.b;
  float rim = max(0.006 * spicules, 0.6 * fwidth(r));
  float chromosphere = 0.14 * exp(-x / rim);

  float fade = 1.0 - smoothstep(1.0 + 0.35 * (vOuter - 1.0), vOuter, r);
  vec3 warm = vec3(1.0, 0.5, 0.17);
  vec3 pearl = vec3(1.0, 0.62, 0.32);
  vec3 col = warm * inner + pearl * corona + vec3(1.0, 0.62, 0.26) * chromosphere;
  gl_FragColor = vec4(col * fade * uAirTint, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
