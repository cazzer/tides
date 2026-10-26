uniform samplerCube uCorona;
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
  float fibre = 0.78 + 0.22 * rays;

  // The glow at the limb: steep, warm, unstructured...
  float inner = 0.16 * exp(-x / 0.05) + 0.08 * exp(-x / 0.22);
  // ...then pale streamers falling off with height, and plumes at the poles.
  float corona = (0.02 + 0.13 * streamer) * fibre * pow(r, -2.6) * exp(-x / 1.4)
               + 0.06 * pole * (0.4 + 0.6 * max(rays, 0.0)) * exp(-x / 0.28);

  // The chromosphere: a thin pink rim with a fringe of spicules. It carries
  // on under r = 1, where the Sun hides it, so no seam opens at the limb.
  float spicules = 0.75 + 0.5 * pattern.b;
  float rim = max(0.006 * spicules, 0.6 * fwidth(r));
  float chromosphere = 0.14 * exp(-x / rim);

  float fade = 1.0 - smoothstep(1.0 + 0.35 * (vOuter - 1.0), vOuter, r);
  vec3 warm = vec3(1.0, 0.68, 0.38);
  vec3 pearl = vec3(0.95, 0.93, 0.9);
  vec3 col = warm * inner + pearl * corona + vec3(1.0, 0.24, 0.32) * chromosphere;
  gl_FragColor = vec4(col * fade, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
