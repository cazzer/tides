import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'

// Line-art figures from Stellarium's modern sky culture, by Johan Meuris
// (Free Art License 1.3; built by scripts/convertConstellationArt.mjs, which
// keeps the notice in the JSON).
import artAtlasUrl from '../assets/constellation-art.webp?url'
import art from '../assets/constellation-art.json'
import {
  DEFAULT_RADIUS,
  EXTINCTION_PER_AIRMASS,
  centreStarfieldOn,
  orientStarfield,
  zenithOf,
} from './Starfield'
import { useStore } from '../store'
import { constellationArtGeometry } from '../constellationArt'

const ART_COLOR = '#a8bde0'
const ART_OPACITY = 0.18
// Strokes are thresholded here rather than drawn as sampled, so a figure
// spread over a wide sky keeps thin, crisp lines instead of blurred ones.
const STROKE_EDGE = 0.6

// Additive, so the figures only ever lighten the sky, and fading into the
// horizon with the same extinction as the stars.
const vertexShader = /* glsl */ `
uniform vec3 uZenith;
varying vec2 vUv;
varying float vExtinction;
void main() {
  vUv = uv;
  float s = max(dot(normalize(mat3(modelMatrix) * position), uZenith), 0.0);
  float airmass = 1.0 / (s + 0.025 * exp(-11.0 * s));
  vExtinction = pow(10.0, -0.4 * ${EXTINCTION_PER_AIRMASS.toFixed(3)} * (airmass - 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vExtinction;
void main() {
  float stroke = texture2D(uMap, vUv).r;
  float blur = max(fwidth(stroke), 0.02);
  float line = smoothstep(${STROKE_EDGE} - blur, ${STROKE_EDGE} + blur, stroke);
  gl_FragColor = vec4(uColor * line * uOpacity * vExtinction, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function Figures({ radius }: { radius: number }) {
  const atlas = useLoader(THREE.TextureLoader, artAtlasUrl)
  const geometry = useMemo(() => constellationArtGeometry(art), [])

  useEffect(() => {
    return () => geometry.dispose()
  }, [geometry])

  const uniforms = useMemo(
    () => ({
      uMap: { value: atlas },
      uColor: { value: new THREE.Color(ART_COLOR) },
      uOpacity: { value: ART_OPACITY },
      uZenith: { value: new THREE.Vector3(0, 1, 0) },
    }),
    [atlas]
  )

  const figures = useRef<THREE.Mesh>(null)
  useFrame(() => {
    if (figures.current) {
      orientStarfield(figures.current, useStore.getState().timestamp ?? Date.now())
    }
  })

  return (
    <mesh
      ref={figures}
      onBeforeRender={(_renderer, _scene, camera) => {
        if (!figures.current) return
        centreStarfieldOn(figures.current, camera)
        zenithOf(camera, uniforms.uZenith.value)
      }}
      frustumCulled={false}
      // Under the stick figures, which draw after it.
      renderOrder={-1}
      scale={[radius, radius, radius]}
    >
      <primitive
        attach="geometry"
        object={geometry}
      />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

// Drawn on the starfield's sphere like ConstellationLines; only the View from
// Earth panel mounts it. Its own Suspense, so loading the atlas never blanks
// the scene.
export default function ConstellationArt({ radius = DEFAULT_RADIUS }: { radius?: number }) {
  return (
    <Suspense fallback={null}>
      <Figures radius={radius} />
    </Suspense>
  )
}
