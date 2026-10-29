// The solar eclipse demo's shadow aid (tides-zec.7), main view only: the
// Moon's umbra on Earth filled dark and ringed in white, the penumbra deepened
// and its outer edge ringed, all from the same geometry as the ground's own
// eclipse shading (eclipseShadow.ts), so it marks where the shadow truly is.
// A clear shell just over the highest ground, a child of Earth's
// OrbitingBody with no transform of its own. Each fragment follows the eye's
// ray on to sea level and shades the point it meets there, so the marks sit
// on the geography seen behind them, not on the ground straight below the
// shell, which at a slant is well off to one side.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CLOUD_UNDER_AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { ECLIPSE_GLSL, useEclipseShadowState } from '../renderers/eclipseShadow'
import { TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY } from '../cloud-layer'
import { SUN_RADIUS_KM } from '../eclipse'

// × Earth's radius over the highest ground, clear of the sphere's facets.
const LIFT = 0.001
const UMBRA_FILL = 0.85
// The penumbra darkens toward the umbra: the spot is the core of a patch.
const PENUMBRA_DEEPEN = 0.45
const UMBRA_LINE_OPACITY = 0.7
const PENUMBRA_LINE_OPACITY = 0.5
// Each line's half width, in CSS pixels.
const LINE_PX = 1
// After the air, aurora and cloud shells (the clouds' latest, from under
// their tops, is CLOUD_UNDER_AURORA_RENDER_ORDER), which write no depth: it
// draws over them, and the ground's depth still hides the far side. Under
// the labels (LABEL_RENDER_ORDER, 4), which must stay unshaded.
const RENDER_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.5

const eye = new THREE.Vector3()

// The eye in the shell's own frame, per camera, and the lines' width in
// device pixels. Module level, so the material is changed outside the hook.
function placeEye(
  mesh: THREE.Object3D,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  material: THREE.Material | THREE.Material[]
) {
  const shader = material as THREE.ShaderMaterial
  eye.setFromMatrixPosition(camera.matrixWorld)
  shader.uniforms.uEye.value.copy(mesh.worldToLocal(eye))
  shader.uniforms.uLinePx.value = LINE_PX * renderer.getPixelRatio()
}

function noRaycast() {}

const vertexShader = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = /* glsl */ `
#include <common>
${ECLIPSE_GLSL.fragmentHead}
uniform mat4 modelMatrix;
uniform vec2 uEclipseBody;
${ECLIPSE_GLSL.point}
uniform float uLinePx;
uniform vec3 uEye;
uniform float uSeaLevel;
varying vec3 vLocal;

// Mirrors eclipseSunlight()'s first lines: the Sun's and the occluder's
// angular radii and their separation, unclamped, so the edges can be found.
vec3 moonShadowAngles(vec3 point) {
  vec3 toSun = uEclipseSun - point;
  vec3 toOccluder = uEclipseOccluder.xyz - point;
  float sunDistance = length(toSun);
  float occluderDistance = length(toOccluder);
  float sunRadius = asin(${SUN_RADIUS_KM.toFixed(1)} / sunDistance);
  float occluderRadius = asin(min(1.0, uEclipseOccluder.w / occluderDistance));
  float separation = 2.0 * asin(min(1.0,
    0.5 * length(toSun / sunDistance - toOccluder / occluderDistance)));
  return vec3(sunRadius, occluderRadius, separation);
}

// 1 on t = 1, fading out over uLinePx pixels either side.
float edgeLine(float t) {
  return 1.0 - smoothstep(0.0, uLinePx * fwidth(t), abs(t - 1.0));
}

void main() {
  if (uEclipseActive < 0.5) discard;
  // Where the eye's ray through this fragment meets sea level (the shell's
  // frame). No discard on a miss before the derivatives below: the miss is
  // masked out at the end.
  vec3 ray = normalize(vLocal - uEye);
  float b = dot(uEye, ray);
  // From the closest approach, not b² - |eye|²: that cancels in float32.
  vec3 closest = uEye - b * ray;
  float h = uSeaLevel * uSeaLevel - dot(closest, closest);
  // Antialiased like the ground's silhouette beside it.
  float hit = clamp(h / max(fwidth(h), 1e-12) + 0.5, 0.0, 1.0);
  vec3 p = eclipsePoint(uEye + (-b - sqrt(max(h, 0.0))) * ray);
  vec3 a = moonShadowAngles(p);
  float visible = eclipseSunlight(p).x;
  // 1 on the umbra's edge (none where the Moon looks smaller than the Sun),
  // and on the penumbra's.
  float tU = a.z / max(a.y - a.x, 1e-6);
  float tP = a.z / (a.x + a.y);
  // The cone runs on through Earth: only the sunward side shows it, up to
  // the moment the umbra slides off at the terminator.
  float day = smoothstep(-0.01, 0.005, dot(normalize(p), normalize(uEclipseSun - p)));

  float umbraLine = edgeLine(tU) * ${UMBRA_LINE_OPACITY.toFixed(2)};
  float penumbraLine = edgeLine(tP) * ${PENUMBRA_LINE_OPACITY.toFixed(2)};
  float line = umbraLine + penumbraLine * (1.0 - umbraLine);
  float umbra = 1.0 - smoothstep(1.0 - fwidth(tU), 1.0, tU);
  float shade = 1.0 - visible;
  float fill = max(${UMBRA_FILL.toFixed(2)} * umbra, ${PENUMBRA_DEEPEN.toFixed(2)} * shade * shade);
  float mask = day * hit;
  float alpha = (line + fill * (1.0 - line)) * mask;
  if (alpha <= 0.0) discard;

  // Premultiplied: the lines are white, the fill only darkens.
  gl_FragColor = vec4(vec3(line * mask), alpha);
}
`

export function MoonShadowGlobe({ radius }: { radius: number }) {
  const shadow = useEclipseShadowState('earth')
  const shellRadius = radius + TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + LIFT * radius
  const geometry = useMemo(() => new THREE.SphereGeometry(shellRadius, 128, 64), [shellRadius])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          // The shadow's own uniform objects, which it updates each frame.
          ...shadow.uniforms,
          uLinePx: { value: LINE_PX },
          uEye: { value: new THREE.Vector3() },
          uSeaLevel: { value: radius },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        toneMapped: false,
        // Premultiplied (gl_FragColor above).
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    [shadow, radius]
  )

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  const mesh = useRef<THREE.Mesh>(null)

  return (
    <mesh
      ref={mesh}
      renderOrder={RENDER_ORDER}
      geometry={geometry}
      material={material}
      raycast={noRaycast}
      onBeforeRender={(renderer, _scene, camera, _geometry, mat) => {
        if (mesh.current) placeEye(mesh.current, renderer, camera, mat)
      }}
    />
  )
}
