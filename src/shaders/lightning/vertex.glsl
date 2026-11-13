// Lightning flashes (tides-ufyr.13): one camera-facing quad per ring slot
// (renderers/lightningInstances.ts), at the cloud deck's height over the
// flash, played out from its wall-clock start. flashIntensity mirrors
// ../../lightning.ts; keep them in step.
attribute vec4 aDir;   // xyz: unit direction in the Earth's frame; w: flicker seed
attribute vec4 aFlash; // x: start (s); y: duration (s); z: brightness; w: glow radius (km)

uniform float uTime;
uniform float uRadius;
uniform float uKmToScene;
uniform float uMinPx;
uniform float uViewportH;
uniform vec3 uSun;

varying vec2 vUv;
varying float vI;

#define FLASH_MIN_S 0.1
#define FLASH_MAX_S 0.4
#define FLASH_TAIL_S 0.15
#define PULSE_ATTACK_S 0.005
#define PULSE_DECAY_S 0.035
#define DAY_FLOOR 0.08

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

void main() {
  float age = uTime - aFlash.x;
  float d = clamp(aFlash.y, FLASH_MIN_S, FLASH_MAX_S);
  vUv = position.xy;
  vI = 0.0;
  // Unlit slots collapse to a point off screen: no fragments.
  if (age < 0.0 || age > d + FLASH_TAIL_S) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 dir = normalize(aDir.xyz);
  vec4 centre = modelViewMatrix * vec4(dir * uRadius, 1.0);
  // Perspective (the ship, the panels) or orthographic (the main view).
  bool perspective = projectionMatrix[2][3] == -1.0;
  float depth = -centre.z;
  // Scene units per (CSS) pixel at the flash: uViewportH is in CSS px.
  float pxWorld = 2.0 / (projectionMatrix[1][1] * uViewportH) * (perspective ? depth : 1.0);
  float size = max(aFlash.w * uKmToScene, uMinPx * pxWorld);
  // Fades as the eye comes within a few glows of it (flying through).
  float near = perspective ? smoothstep(size, 4.0 * size, depth) : 1.0;
  float day = mix(1.0, DAY_FLOOR, smoothstep(-0.10, 0.15, dot(dir, uSun)));
  vI = flashIntensity(age, aFlash.y, aDir.w) * aFlash.z * day * near;
  // Dark (between pulses, or the eye inside it): no fragments either, so a
  // quad filling the screen costs nothing.
  if (vI <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  centre.xy += position.xy * size;
  gl_Position = projectionMatrix * centre;
}
