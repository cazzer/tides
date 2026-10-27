// The sky-view table (tides-34q.2): the sky from inside, single scattering
// marched along each direction from an eye at uEyeR (sea-level radii; at
// the haze's base if under it) to the haze's top or the sea, with the
// sunlight's column toward the Sun at each step in closed form (Chapman's,
// hazeAbove(), and past the horizon from the beam's lowest point) and the
// Earth's shadow, so the low Sun's sky grades from a warm horizon to blue,
// the Belt of Venus stands opposite, and the twilight glows. A texel is a
// direction by its azimuth from the Sun's (u, 0 to pi: the sky is symmetric
// about the Sun's vertical) and its elevation over the eye's level (v,
// squeezed toward the horizon: skyViewDir() and skyViewGlow() in haze.glsl), for the Sun at
// uSunMu (the sine of its elevation at the eye).

precision highp float;

uniform float uEyeR;
uniform float uSunMu;
uniform vec2 uSize;

// haze.glsl's uniforms, in sea-level radii; the limb's colours are unused.
#define uSeaLevel 1.0
#define uSurface SKY_VIEW_SURFACE
#define uScaleHeight SKY_VIEW_SCALE_HEIGHT
#define uGain 0.0
#define uSky vec3(0.0)
#define uDusk vec3(0.0)
#define SKY_VIEW_BUILD
#include haze.glsl

// The column from radius r toward the Sun at mu, either side of the
// horizon: past it, twice the grazing column at the beam's lowest point,
// less the part behind.
float hazeToSun(float r, float mu) {
  if (mu >= 0.0) return hazeAbove(r, mu);
  float low = r * sqrt(1.0 - mu * mu);
  return 2.0 * hazeAbove(max(low, uSurface), 0.0) - hazeAbove(r, -mu);
}

#define SKY_VIEW_STEPS 32

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5) / (uSize - 1.0);
  vec3 rd = skyViewDir(uv);
  float H = uScaleHeight;
  vec3 ro = vec3(0.0, max(uEyeR, uSurface), 0.0);
  vec3 sun = vec3(sqrt(max(1.0 - uSunMu * uSunMu, 0.0)), uSunMu, 0.0);
  float top = uSurface + 10.0 * H;
  float b = dot(ro, rd);
  float tEnd = -b + sqrt(max(b * b - (dot(ro, ro) - top * top), 0.0));
  // To the sea (the density held at the base's under it).
  float hg = b * b - (dot(ro, ro) - 1.0);
  if (b < 0.0 && hg > 0.0) tEnd = min(tEnd, -b - sqrt(hg));
  float dt = tEnd / float(SKY_VIEW_STEPS);
  vec3 ext = SKY_RAYLEIGH + SKY_MIE * 1.1;
  vec3 extSun = (SKY_RAYLEIGH + SKY_MIE + SKY_OZONE) * SKY_AIRMASS;
  vec3 tauView = vec3(0.0);
  vec3 single = vec3(0.0);
  vec3 multi = vec3(0.0);
  for (int i = 0; i < SKY_VIEW_STEPS; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    float r = length(p);
    float dens = exp(-max(r - uSurface, 0.0) / H) * dt / H;
    tauView += ext * dens * 0.5;
    float mu = dot(p, sun) / r;
    // In the Earth's shadow where the sunbeam meets the sea, softened.
    float bs = dot(p, sun);
    float hs = bs * bs - (r * r - 1.0);
    float shadow = bs < 0.0 ? smoothstep(0.0, 0.02 * r * r, -hs) : 1.0;
    vec3 sunT = shadow * exp(-extSun * hazeToSun(r, mu) / H);
    single += sunT * exp(-tauView) * dens;
    // Light scattered more than once: bluer, and less reddened.
    multi += sqrt(sunT) * exp(-tauView) * dens;
    tauView += ext * dens * 0.5;
  }
  float c = dot(rd, sun);
  float g = SKY_MIE_G;
  float pR = 0.0596831 * (1.0 + c * c);
  float pM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  gl_FragColor = vec4(SKY_SUN * (single * (SKY_RAYLEIGH * pR + SKY_MIE * pM)
    + SKY_MULTI * multi * SKY_RAYLEIGH * 0.0795775), 1.0);
}
