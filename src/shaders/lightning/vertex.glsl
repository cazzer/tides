// Lightning flashes (tides-ufyr.13): one quad per ring slot
// (renderers/lightningInstances.ts), lying flat on the cloud deck's tangent
// plane over the flash (tides-ufyr.13.1), played out from its wall-clock
// start. flashIntensity mirrors ../../lightning.ts, the patch's shape, size
// and shear ../../lightning-patch.ts; keep them in step.
attribute vec4 aDir;   // xyz: unit direction in the Earth's frame; w: flicker seed
attribute vec4 aFlash; // x: start (s); y: duration (s); z: brightness; w: glow radius (km)

uniform float uTime;
uniform float uRadius;
uniform float uKmToScene;
uniform float uMinPx;
uniform float uViewportW;
uniform float uViewportH;
uniform float uMaxFrac;
uniform float uMinEdgePx;
uniform vec3 uSun;

varying vec2 vUv;
varying float vI;
// The corner's cloud-map coordinate (cloudUv(), renderers/cloudShaders.ts),
// u unwrapped about the flash's so the patch has no seam.
varying vec2 vCloudUv;
varying vec2 vNoiseOffset;

#define FLASH_MIN_S 0.1
#define FLASH_MAX_S 0.4
#define FLASH_TAIL_S 0.15
#define PULSE_ATTACK_S 0.005
#define PULSE_DECAY_S 0.035
#define DAY_FLOOR 0.08
#define LIGHTNING_PI 3.141592653589793

float flashIntensity(float age, float dur, float seed) {
  float d = clamp(dur, FLASH_MIN_S, FLASH_MAX_S);
  if (age < 0.0 || age > d + FLASH_TAIL_S) return 0.0;
  float n = 1.0 + min(floor(seed * 3.0), 2.0);
  float intensity = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    if (fk >= n) break;
    float a = age - d * fk / n;
    if (a < 0.0) continue;
    float envelope = a < PULSE_ATTACK_S ? a / PULSE_ATTACK_S : exp(-(a - PULSE_ATTACK_S) / PULSE_DECAY_S);
    float amplitude = k == 0 ? 1.0 : 0.5 + 0.4 * fract(seed * (fk + 1.0) * 13.7);
    intensity = max(intensity, amplitude * envelope);
  }
  return intensity;
}

// cloudUv()'s u, not wrapped.
float cloudU(vec3 d) {
  return atan(d.z, -d.x) / (2.0 * LIGHTNING_PI);
}

void main() {
  float age = uTime - aFlash.x;
  float d = clamp(aFlash.y, FLASH_MIN_S, FLASH_MAX_S);
  vUv = position.xy;
  vI = 0.0;
  vCloudUv = vec2(0.0);
  vNoiseOffset = vec2(0.0);
  // Unlit slots collapse to a point off screen: no fragments.
  if (age < 0.0 || age > d + FLASH_TAIL_S) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 dir = normalize(aDir.xyz);
  float seed = aDir.w;
  vec4 centre = modelViewMatrix * vec4(dir * uRadius, 1.0);
  // Perspective (the ship, the panels) or orthographic (the main view).
  bool perspective = projectionMatrix[2][3] == -1.0;
  float depth = -centre.z;
  // Scene units per (CSS) pixel at the flash: the viewport is in CSS px.
  float pxWorld = 2.0 / (projectionMatrix[1][1] * uViewportH) * (perspective ? depth : 1.0);
  float day = mix(1.0, DAY_FLOOR, smoothstep(-0.10, 0.15, dot(dir, uSun)));
  vI = flashIntensity(age, aFlash.y, seed) * aFlash.z * day;
  // Dark (between pulses): no fragments either.
  if (vI <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // The patch's shape (flashShape()).
  float angle = 2.0 * LIGHTNING_PI * fract(seed * 97.31);
  float aspect = 1.0 + 0.6 * fract(seed * 61.7);
  vNoiseOffset = vec2(fract(seed * 13.1), fract(seed * 29.7)) * 64.0;
  // The tangent plane (flashTangentBasis()): east and north, turned.
  vec3 east = abs(dir.y) > 0.9999 ? vec3(0.0, 0.0, -1.0) : cross(vec3(0.0, 1.0, 0.0), dir);
  east = normalize(east - dir * dot(east, dir));
  vec3 north = cross(dir, east);
  float c = cos(angle);
  float s = sin(angle);
  vec3 e1 = c * east + s * north;
  vec3 e2 = c * north - s * east;
  // Its major half-axis, held between the floor and the cap (flashHalfSize()).
  float major = min(max(aFlash.w * uKmToScene * sqrt(aspect), uMinPx * pxWorld),
    uMaxFrac * min(uViewportW, uViewportH) * pxWorld);
  float minor = major / aspect;
  vec3 cornerLocal = dir * uRadius + major * (position.x * e1 + position.y * e2 / aspect);
  vec4 corner = modelViewMatrix * vec4(cornerLocal, 1.0);
  // Toward the limb, sheared to face the eye just enough to stay
  // uMinEdgePx thick (limbShear()).
  vec3 nV = normalize(mat3(modelViewMatrix) * dir);
  vec3 vV = perspective ? normalize(-centre.xyz) : vec3(0.0, 0.0, 1.0);
  if (dot(nV, vV) < 0.0) nV = -nV;
  // Clamped: rounding can take it past 1, and the root below to NaN.
  float mu = min(abs(dot(nV, vV)), 1.0);
  float minMu = min(1.0, uMinEdgePx * pxWorld / minor);
  float t = max(0.0, minMu - mu) / max(sqrt(1.0 - mu * mu), 1e-3);
  // Face on, vV - mu * nV is 0 (and so is t): no shear, and no NaN.
  vec3 h = vV - mu * nV;
  vec3 hV = h * inversesqrt(max(dot(h, h), 1e-12));
  corner.xyz -= nV * t * dot(corner.xyz - centre.xyz, hV);
  // The cloud under the corner (unwrapU()).
  vec3 cornerDir = normalize(cornerLocal);
  float uCentre = cloudU(dir);
  float du = cloudU(cornerDir) - uCentre;
  vCloudUv = vec2(uCentre + du - floor(du + 0.5), 0.5 + asin(clamp(cornerDir.y, -1.0, 1.0)) / LIGHTNING_PI);
  gl_Position = projectionMatrix * corner;
}
