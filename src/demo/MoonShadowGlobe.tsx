// The solar eclipse demo's shadow aid (tides-zec.7), main view only: the
// Moon's umbra on Earth filled dark and ringed in white, the penumbra deepened
// and its outer edge ringed, all from the same geometry as the ground's own
// eclipse shading (eclipseShadow.ts), so it marks where the shadow truly is.
// A clear shell just over the highest ground, a child of Earth's
// OrbitingBody with no transform of its own. Each fragment follows the eye's
// ray on to sea level and shades the point it meets there, so the marks sit
// on the geography seen behind them, not on the ground straight below the
// shell, which at a slant is well off to one side.
// With `totalityPath` (tides-zec.12) it also leaves the umbra's path of
// totality darkened behind it: the ground the axis has crossed since landfall
// up to the sim time (totality-path.ts), so it is right after any jump.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { CLOUD_UNDER_AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { ECLIPSE_GLSL, useEclipseShadowState } from '../renderers/eclipseShadow'
import { TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY } from '../cloud-layer'
import { SUN_RADIUS_KM } from '../eclipse'
import { useStore } from '../store'
import { LANDFALL_MS, TRAIL_ROWS, trailTable } from './totality-path'

// × Earth's radius over the highest ground, clear of the sphere's facets.
const LIFT = 0.001
const UMBRA_FILL = 0.85
// The penumbra darkens toward the umbra: the spot is the core of a patch.
const PENUMBRA_DEEPEN = 0.45
const UMBRA_LINE_OPACITY = 0.7
const PENUMBRA_LINE_OPACITY = 0.5
// Each line's half width, in CSS pixels.
const LINE_PX = 1
// The path of totality: lighter than the umbra, so the dot stays its head.
const TRAIL_FILL = 0.55
const TRAIL_LINE_OPACITY = 0.35
// Half the path's width (~200 km across mid-path), km; at least TRAIL_MIN_PX
// CSS pixels so it reads from afar, but never past TRAIL_MAX_WIDEN times
// itself, where at the limb pixels span thousands of km.
const TRAIL_HALF_KM = 100
const TRAIL_MIN_PX = 2
const TRAIL_MAX_WIDEN = 3
// Mean radius: the cross-track distance is only for the path's width.
const EARTH_MEAN_RADIUS_KM = 6371
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

// The path of totality up to the sim time, read as each frame draws.
function placeTrail(material: THREE.Material | THREE.Material[], on: boolean) {
  const shader = material as THREE.ShaderMaterial
  const { timestamp } = useStore.getState()
  shader.uniforms.uTrailOn.value = on ? 1 : 0
  shader.uniforms.uTrailNow.value =
    typeof timestamp === 'number' ? (timestamp - LANDFALL_MS) / 1000 : -1
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
// totality-path.ts's trailTable(): per row of longitude, the centre's
// latitude, seconds after landfall it passed, and cos of the track's angle
// from east; uTrailLon is row 0's longitude and the step, rad.
uniform vec4 uTrail[${TRAIL_ROWS}];
uniform vec2 uTrailLon;
uniform float uTrailNow;
uniform float uTrailOn;
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

// 1 on t = 1, fading out over uLinePx pixels either side; or with outside 1,
// moved out by those pixels so it stops at t = 1. The umbra's line sits
// outside: near the limb the umbra is a few pixels across, and a line on its
// edge covers it, leaving a white dot where the dark one should be.
float edgeLine(float t, float outside) {
  float width = uLinePx * fwidth(t);
  return 1.0 - smoothstep(0.0, width, abs(t - 1.0 - outside * width));
}

// The path of totality at the sea-level point \`local\` (Earth's frame): x its
// fill, y its edge lines; 0 off the path and where the axis hasn't yet been.
vec2 totalityPath(vec3 local) {
  vec3 n = normalize(local);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = -atan(n.z, n.x);
  float f = (lon - uTrailLon.x) / uTrailLon.y;
  float row = clamp(floor(f), 0.0, ${(TRAIL_ROWS - 2).toFixed(1)});
  int i = int(row);
  vec4 r = mix(uTrail[i], uTrail[i + 1], clamp(f - row, 0.0, 1.0));
  float onTable = step(0.0, f) * step(f, ${(TRAIL_ROWS - 1).toFixed(1)});
  // Across a locally straight track, from the offset due north.
  float crossKm = (lat - r.x) * ${EARTH_MEAN_RADIUS_KM.toFixed(1)} * r.z;
  // Antialiased at the head, under the umbra's dot.
  float since = uTrailNow - r.y;
  float passed = clamp(since / max(fwidth(since), 1e-6) + 0.5, 0.0, 1.0);
  float halfKm = clamp(${TRAIL_MIN_PX.toFixed(1)} * uLinePx * fwidth(crossKm),
    ${TRAIL_HALF_KM.toFixed(1)}, ${(TRAIL_HALF_KM * TRAIL_MAX_WIDEN).toFixed(1)});
  float t = abs(crossKm) / halfKm;
  float fill = 1.0 - smoothstep(1.0 - fwidth(t), 1.0, t);
  float on = uTrailOn * onTable * passed;
  return vec2(fill, edgeLine(t, 0.0)) * on;
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
  vec3 local = uEye + (-b - sqrt(max(h, 0.0))) * ray;
  vec3 p = eclipsePoint(local);
  vec3 a = moonShadowAngles(p);
  float visible = eclipseSunlight(p).x;
  // 1 on the umbra's edge (none where the Moon looks smaller than the Sun),
  // and on the penumbra's.
  float tU = a.z / max(a.y - a.x, 1e-6);
  float tP = a.z / (a.x + a.y);
  // The cone runs on through Earth: only the sunward side shows it, up to
  // the moment the umbra slides off at the terminator.
  float day = smoothstep(-0.01, 0.005, dot(normalize(p), normalize(uEclipseSun - p)));

  float umbraLine = edgeLine(tU, 1.0) * ${UMBRA_LINE_OPACITY.toFixed(2)};
  float penumbraLine = edgeLine(tP, 0.0) * ${PENUMBRA_LINE_OPACITY.toFixed(2)};
  float line = umbraLine + penumbraLine * (1.0 - umbraLine);
  float umbra = 1.0 - smoothstep(1.0 - fwidth(tU), 1.0, tU);
  float shade = 1.0 - visible;
  float fill = max(${UMBRA_FILL.toFixed(2)} * umbra, ${PENUMBRA_DEEPEN.toFixed(2)} * shade * shade) * day;
  line *= day;
  // Ground the shadow has crossed, so not only the sunward side; its lines
  // stop at the umbra, which they would otherwise cross to the dot's centre.
  vec2 path = totalityPath(local);
  float pathLine = path.y * ${TRAIL_LINE_OPACITY.toFixed(2)} * (1.0 - umbra * day);
  line += pathLine * (1.0 - line);
  fill = max(fill, ${TRAIL_FILL.toFixed(2)} * path.x);
  float alpha = (line + fill * (1.0 - line)) * hit;
  if (alpha <= 0.0) discard;

  // Premultiplied: the lines are white, the fill only darkens.
  gl_FragColor = vec4(vec3(line * hit), alpha);
}
`

interface MoonShadowGlobeProps {
  radius: number
  /** Leave the path of totality behind the umbra (aids.totalityPath). */
  totalityPath: boolean
}

export function MoonShadowGlobe({ radius, totalityPath }: MoonShadowGlobeProps) {
  const shadow = useEclipseShadowState('earth')
  const shellRadius = radius + TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + LIFT * radius
  const geometry = useMemo(() => new THREE.SphereGeometry(shellRadius, 128, 64), [shellRadius])
  const trail = useMemo(() => trailTable(), [])
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
          uTrail: { value: trail.rows },
          uTrailLon: { value: new THREE.Vector2(trail.lon0, trail.dLon) },
          uTrailNow: { value: -1 },
          uTrailOn: { value: 0 },
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
    [shadow, radius, trail]
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
        placeTrail(mat, totalityPath)
      }}
    />
  )
}
