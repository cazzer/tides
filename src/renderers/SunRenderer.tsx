import { useCallback, useMemo, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import coronaVertex from '../shaders/sun-corona/vertex.glsl'
import coronaFragment from '../shaders/sun-corona/fragment.frag'
import { meshBounds } from '@react-three/drei'
import { CORONA_MAX_ANGLE, CORONA_OUTER_MAIN, CORONA_OUTER_PERSPECTIVE } from './corona-geometry'
import { SunGlare } from './SunGlare'
import { useStore } from '../store'
import { LIMB_SEGMENTS, useBodySphere } from '../ship/limb-detail'
import { isLowQuality } from '../quality'
import { sunSurface } from './sun-surface'
import { SunProminences } from './SunProminences'
import { SunSpicules } from './SunSpicules'
import { SUN_FRINGE, SUN_FRINGE_FADE_PX, sunShellScale } from './sun-spicules'

const SUN_SEGMENTS = [128, 128] as const

// Both spheres useBodySphere may hand over, so one shell fits either.
const SUN_SHELL = Math.max(sunShellScale(SUN_SEGMENTS), sunShellScale(LIMB_SEGMENTS))

const eyeToObject = new THREE.Matrix4()

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function tick(surface: ReturnType<typeof sunSurface>, material: THREE.ShaderMaterial, time: number) {
  surface.step()
  material.uniforms.time.value = time
}

// The eye and the view direction in the Sun's frame, per view: the
// photosphere traces its sphere there (sun/fragment.frag).
function setEye(material: THREE.ShaderMaterial, camera: THREE.Camera, mesh: THREE.Object3D) {
  eyeToObject.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).invert()
  material.uniforms.uEyeObject.value.set(0, 0, 0).applyMatrix4(eyeToObject)
  material.uniforms.uDirObject.value.set(0, 0, -1).transformDirection(eyeToObject)
}

interface SunRendererProps {
  diameter: number
  /** The main view (not a panel or ship mode), whose corona reaches further. */
  interactive?: boolean
}

export default function SunRenderer({ diameter, interactive = false }: SunRendererProps) {
  // In ship mode only ShipView mounts a scene, so this is the ship's Sun.
  const shipMode = useStore((s) => s.shipMode)
  const sphere = useBodySphere('sun', diameter, SUN_SEGMENTS)
  const gl = useThree((s) => s.gl)
  // The photosphere's and corona's baked detail, shared by every view on
  // this renderer.
  const surface = useMemo(() => sunSurface(gl, isLowQuality()), [gl])
  const sunMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        uSurface: { value: surface.surface },
        uPlasma: { value: surface.plasma },
        uRadius: { value: diameter },
        uShell: { value: SUN_SHELL },
        uFringe: { value: SUN_FRINGE },
        uFringeFadePx: { value: new THREE.Vector2(...SUN_FRINGE_FADE_PX) },
        uEyeObject: { value: new THREE.Vector3() },
        uDirObject: { value: new THREE.Vector3(0, 0, -1) },
      },
      vertexShader: sunVertex,
      fragmentShader: sunFragment,
      // The traced limb's coverage, smoothed by the canvas's MSAA.
      alphaToCoverage: true,
    })
  }, [surface, diameter])
  const coronaMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: coronaVertex,
      fragmentShader: coronaFragment,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // A glow, not a surface: writing depth would hide labels behind it.
      depthWrite: false,
      // The Sun's near side hides the quad's middle, so only the limb glows.
      // Strictly: from the ship's lowest stop the depth step at the Sun (~60
      // units) dwarfs the quad's 2R push, so both land on one depth value and
      // a tie must go to the Sun (tides-01v.8.1).
      depthTest: true,
      depthFunc: THREE.LessDepth,
      uniforms: {
        uRadius: { value: diameter },
        uMaxAngle: { value: CORONA_MAX_ANGLE },
        uOuter: { value: interactive ? CORONA_OUTER_MAIN : CORONA_OUTER_PERSPECTIVE },
        uCorona: { value: surface.corona },
      },
    })
  }, [diameter, interactive, surface])

  useEffect(() => () => sunMaterial.dispose(), [sunMaterial])
  useEffect(() => () => coronaMaterial.dispose(), [coronaMaterial])

  useFrame((state) => tick(surface, sunMaterial, state.clock.elapsedTime))
  const mesh = useRef<THREE.Mesh>(null)
  const onBeforeRender = useCallback(
    (_renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (mesh.current) setEye(sunMaterial, camera, mesh.current)
    },
    [sunMaterial]
  )

  return (
    <>
      <mesh
        ref={mesh}
        geometry={sphere}
        raycast={meshBounds}
        onBeforeRender={onBeforeRender}
      >
        <primitive
          object={sunMaterial}
          attach="material"
        />
      </mesh>
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
      <SunProminences radius={diameter} />
      {!isLowQuality() && <SunSpicules radius={diameter} />}
      {/* Far glare: keeps the Sun a bright point when its disc is sub-pixel
          at flight-scale ranges (tides-2hv.12); separate from the corona. */}
      {shipMode && <SunGlare radius={diameter} />}
    </>
  )
}
