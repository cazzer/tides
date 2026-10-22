import { useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import noiseVertex from '../shaders/sun-noise/vertex.glsl'
import noiseFragment from '../shaders/sun-noise/fragment.frag'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import coronaVertex from '../shaders/sun-corona/vertex.glsl'
import coronaFragment from '../shaders/sun-corona/fragment.frag'
import { CubeCamera, meshBounds } from '@react-three/drei'
import { CORONA_MAX_ANGLE } from './corona-geometry'
import { SunGlare } from './SunGlare'
import { useStore } from '../store'
import { useBodySphere } from '../ship/limb-detail'

// https://www.youtube.com/watch?v=3krH52AhPqk
// ended at 1:04:24

const REFLECTION_LAYER = 1

interface SunRendererProps {
  diameter: number
}

export default function SunRenderer({ diameter }: SunRendererProps) {
  // In ship mode only ShipView mounts a scene, so this is the ship's Sun.
  const shipMode = useStore((s) => s.shipMode)
  const sphere = useBodySphere('sun', diameter, [128, 128])
  const noiseMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: noiseVertex,
      fragmentShader: noiseFragment,
      side: THREE.DoubleSide,
      uniforms: {
        time: { value: 0 },
      },
    })
  }, [])
  const sunMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        uPerlin: { value: null },
      },
      vertexShader: sunVertex,
      fragmentShader: sunFragment,
    })
  }, [])
  const coronaMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: coronaVertex,
      fragmentShader: coronaFragment,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // A glow, not a surface: writing depth would hide labels behind it.
      depthWrite: false,
      // The Sun's near side hides the quad's middle, so only the limb glows.
      depthTest: true,
      uniforms: {
        time: { value: 0 },
        uRadius: { value: diameter },
        uMaxAngle: { value: CORONA_MAX_ANGLE },
      },
    })
  }, [diameter])

  useEffect(() => {
    return () => {
      noiseMaterial.dispose()
      sunMaterial.dispose()
    }
  }, [noiseMaterial, sunMaterial])
  useEffect(() => () => coronaMaterial.dispose(), [coronaMaterial])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    noiseMaterial.uniforms.time.value = t
    sunMaterial.uniforms.time.value = t
    coronaMaterial.uniforms.time.value = t
  })

  return (
    <>
      <CubeCamera
        position={[0, 0, 0]}
        resolution={256}
        frames={Infinity}
        near={0.5}
        far={1000}
        onUpdate={(cubeCamera) => {
          cubeCamera.children.forEach((child) =>
            child.layers.set(REFLECTION_LAYER)
          )
        }}
      >
        {(texture) => {
          sunMaterial.uniforms.uPerlin.value = texture
          return (
            <mesh
              position={[0, 0, 0]}
              geometry={sphere}
              raycast={meshBounds}
            >
              <primitive
                object={sunMaterial}
                attach="material"
              />
            </mesh>
          )
        }}
      </CubeCamera>
      {/* Corona: a billboard the vertex shader sizes and turns to the eye. */}
      <mesh
        frustumCulled={false}
        renderOrder={-1}
        raycast={() => null}
      >
        <planeGeometry args={[2, 2]} />
        <primitive
          object={coronaMaterial}
          attach="material"
        />
      </mesh>
      {/* Far glare: keeps the Sun a bright point when its disc is sub-pixel
          at flight-scale ranges (tides-2hv.12); separate from the corona. */}
      {shipMode && <SunGlare radius={diameter} />}
      {/* Noise sphere - only visible to CubeCamera */}
      <mesh
        position={[0, 0, 0]}
        layers={REFLECTION_LAYER}
      >
        <sphereGeometry args={[diameter + 10, 128, 128]} />
        <primitive
          object={noiseMaterial}
          attach="material"
        />
      </mesh>
    </>
  )
}
