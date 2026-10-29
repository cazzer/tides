// The solar eclipse demo's shadow aid (tides-zec.7), main view only: the
// Moon's umbra on Earth filled dark and ringed in white, the penumbra deepened
// and its outer edge ringed, all from the same geometry as the ground's own
// eclipse shading (eclipseShadow.ts), so it marks where the shadow truly is.
// A clear shell just above the cloud tops, a child of Earth's OrbitingBody
// with no transform of its own: eclipsePoint() reads its fragments as the
// same geography as the ground under them.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { AURORA_RENDER_ORDER, groundHazeTop } from '../renderers/earth-shells'
import { ECLIPSE_GLSL, useEclipseShadowState } from '../renderers/eclipseShadow'
import { SUN_RADIUS_KM } from '../eclipse'
import { isLowQuality } from '../quality'

// Over the clouds: × Earth's radius, above the cloud shell's top.
const LIFT = 0.002
const UMBRA_FILL = 0.85
const PENUMBRA_DEEPEN = 0.3
const UMBRA_LINE = '#FFFFFF'
const PENUMBRA_LINE = '#C8D2FF'
const PENUMBRA_LINE_OPACITY = 0.7
// Each line's half width, in CSS pixels.
const LINE_PX = 1.5
// After the air and aurora shells, which would wash it out; the ground's
// depth still hides the far side.
const RENDER_ORDER = AURORA_RENDER_ORDER + 1

function noRaycast() {}

const vertexShader = /* glsl */ `
${ECLIPSE_GLSL.vertexHead}
void main() {
  vEclipsePoint = eclipsePoint(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = /* glsl */ `
#include <common>
${ECLIPSE_GLSL.fragmentHead}
uniform float uLinePx;
uniform vec3 uUmbraLine;
uniform vec3 uPenumbraLine;

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
  vec3 p = vEclipsePoint;
  vec3 a = moonShadowAngles(p);
  float visible = eclipseSunlight(p).x;
  // 1 on the umbra's edge (none where the Moon looks smaller than the Sun),
  // and on the penumbra's.
  float tU = a.z / max(a.y - a.x, 1e-6);
  float tP = a.z / (a.x + a.y);
  // The cone runs on through Earth: only the sunward side shows it.
  float day = smoothstep(-0.02, 0.06, dot(normalize(p), normalize(uEclipseSun - p)));

  float umbraLine = edgeLine(tU);
  float penumbraLine = edgeLine(tP) * ${PENUMBRA_LINE_OPACITY.toFixed(2)};
  float line = umbraLine + penumbraLine * (1.0 - umbraLine);
  vec3 lineColor = (uUmbraLine * umbraLine + uPenumbraLine * penumbraLine * (1.0 - umbraLine)) / max(line, 1e-6);
  float umbra = 1.0 - smoothstep(1.0 - fwidth(tU), 1.0, tU);
  float fill = max(${UMBRA_FILL.toFixed(2)} * umbra, ${PENUMBRA_DEEPEN.toFixed(2)} * (1.0 - visible));
  float alpha = (line + fill * (1.0 - line)) * day;
  if (alpha <= 0.0) discard;

  // Straight colour through the output transform, then premultiplied: the
  // lines carry colour, the fill only darkens.
  gl_FragColor = vec4(lineColor, 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * line * day, alpha);
}
`

export function MoonShadowGlobe({ radius }: { radius: number }) {
  const shadow = useEclipseShadowState('earth')
  // The quality tier is fixed for the page.
  const shellRadius = useMemo(() => radius + groundHazeTop(isLowQuality()) + LIFT * radius, [radius])
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
          uUmbraLine: { value: new THREE.Color(UMBRA_LINE) },
          uPenumbraLine: { value: new THREE.Color(PENUMBRA_LINE) },
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
    [shadow]
  )

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  // Through the mesh, not the memoised material (react-hooks/immutability).
  const mesh = useRef<THREE.Mesh>(null)
  useFrame(({ gl }) => {
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (shader) shader.uniforms.uLinePx.value = LINE_PX * gl.getPixelRatio()
  })

  return (
    <mesh ref={mesh} renderOrder={RENDER_ORDER} geometry={geometry} material={material} raycast={noRaycast} />
  )
}
