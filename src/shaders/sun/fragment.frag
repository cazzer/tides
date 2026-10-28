// The Sun's disc in extreme ultraviolet, from the baked face (loops, glow,
// holes and filaments, network) and plasma (churn) cubes of sun-surface.ts:
// three lookups and arithmetic, at every quality tier and distance. Styled
// on SDO's gold 171 Å Sun rather than white light: structure that reads at
// whole-disc scale, and a limb that brightens instead of darkening.
//
// The sphere is traced along each pixel's ray, not rasterised, so its limb
// can carry a fringe of spicules (sun-spicules.ts) that the shell drawn
// round it leaves room for; only fringe pixels pay for its noise.
uniform samplerCube uSurface;
uniform samplerCube uPlasma;
uniform float time;
// The sphere's radius, in the mesh's own units.
uniform float uRadius;
uniform float uFringe;       // SUN_FRINGE, solar radii
uniform vec2 uFringeFadePx;  // SUN_FRINGE_FADE_PX
// The eye (perspective) and the view direction (orthographic) in the Sun's
// frame, from SunRenderer, so the trace holds under any parent transform.
uniform vec3 uEyeObject;
uniform vec3 uDirObject;
// Not in three's fragment prefix: for the traced surface's depth.
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec3 vObject;

#include ../aurora/noise3.glsl
#include ../clip-depth.glsl

mat2 rotate(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

// A gold ramp by brightness: deep red-brown in the holes, saturated
// orange-gold across the quiet Sun, toward white in the brightest loops
// (where the tone mapping's shoulder takes over).
vec3 gold(float x) {
  x = clamp(x, 0.0, 2.0);
  return vec3(x, 0.4 * pow(x, 1.6), 0.02 * pow(x, 4.0)) * 2.5;
}

void main() {
  vec3 d = isOrthographic ? uDirObject : normalize(vObject - uEyeObject);
  float b = dot(vObject, d);
  vec3 closest = vObject - b * d;
  // How near the ray passes the centre, in solar radii: under 1 it hits.
  float miss = length(closest) / uRadius;
  // A pixel, in solar radii across the limb.
  float edge = max(fwidth(miss), 1e-6);

  // Spicules: a fringe of fine jets standing on the limb, fixed in the
  // Sun's frame so the edge is ragged the same way from every side. Under
  // a pixel or so tall it would only shimmer, so it sinks into the limb.
  float height = uFringe * smoothstep(uFringeFadePx.x, uFringeFadePx.y, uFringe / edge);
  if (miss > 0.999 && height > 0.0) {
    vec3 radial = normalize(closest);
    // Each octave fades out as its jets narrow to a few pixels apart, so
    // the fringe never aliases into sparkle.
    float fine = smoothstep(2.0, 4.0, 1.0 / (420.0 * edge));
    float coarse = smoothstep(2.0, 4.0, 1.0 / (130.0 * edge));
    float jets = 0.6 * fine * snoise3(radial * 420.0) + 0.4 * coarse * snoise3(radial * 130.0);
    height *= 0.25 + 0.75 * smoothstep(-0.3, 0.8, jets);
  }
  // Coverage, a pixel soft: alpha-to-coverage turns it into a smooth edge.
  // Discarded only after the lookups below, which take their mip level
  // from their neighbours' coordinates.
  float solid = 1.0 - smoothstep(1.0 + height - edge, 1.0 + height + edge, miss);

  // The sphere along this ray, or its limb (the ray's nearest approach) for
  // a fringe pixel.
  float m = min(miss, 1.0);
  vec3 hit = closest - d * uRadius * sqrt(max(1.0 - m * m, 0.0));
  vec3 s = normalize(hit);
  float mu = clamp(dot(s, -d), 0.0, 1.0);
  float limbward = 1.0 - mu;

  // The plasma's two reading frames, each turning slowly on its own axis,
  // so their sum churns instead of sliding.
  float t = time * 0.015;
  vec3 layer0 = s;
  layer0.yz = rotate(t) * layer0.yz;
  vec3 layer1 = s;
  layer1.xz = rotate(0.6 - 0.8 * t) * layer1.xz;

  vec4 face = textureCube(uSurface, s);
  // Two turning copies of the plasma, so it churns rather than slides.
  float p0 = textureCube(uPlasma, layer0).r;
  float p1 = textureCube(uPlasma, layer1).g;
  // The two trade places over ~18 s, out of step from place to place, so
  // the plasma brightens and fades where it stands as well as drifting.
  float phase = time * 0.35 + 7.0 * (s.x * 0.71 + s.y * 1.13 + s.z * 0.83);
  float w = 0.5 + 0.5 * sin(phase);
  float churn = mix(p0, p1, w);
  float flicker = mix(p1, p0, w);
  if (solid <= 0.0) discard;

#ifdef SUN_TRACED_DEPTH
  float depth = fragDepthOfClip(projectionMatrix * modelViewMatrix * vec4(hit, 1.0));
  #ifndef USE_REVERSED_DEPTH_BUFFER
  // On a standard buffer far out, the trace's rounding could leave the
  // Sun a step behind the corona's quad, which must lose that tie
  // (tides-01v.8.1): lean a few steps of a 24-bit buffer toward the eye.
  depth = max(depth - 4.0 / 16777216.0, 0.0);
  #endif
  gl_FragDepth = depth;
#endif

  // The quiet Sun: churning, mottled with the network.
  float I = 0.42 + 0.22 * face.a + 0.4 * (churn - 0.5);
  // Active regions on top, their loops brightening and dimming as the
  // plasma under them turns over.
  I += face.r * (1.35 + 1.0 * (flicker - 0.5)) + 0.35 * face.g;
  I *= face.b;

  // Optically thin: toward the limb the eye looks through more corona, so
  // the edge brightens into the glow beyond it (sun-corona/fragment.frag).
  I *= 0.88 + 0.75 * pow(limbward, 3.0);
  // The jets themselves: a little dimmer than the limb behind them.
  I *= 1.0 - 0.35 * smoothstep(1.0, 1.0 + 0.6 * uFringe, miss);
  gl_FragColor = vec4(gold(I), solid);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
