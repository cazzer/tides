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
import { isLowQuality } from '../quality'
import { sunSurface } from './sun-surface'
import { SunProminences } from './SunProminences'
import { SunSpicules } from './SunSpicules'
import { eyeInObject, SUN_FRINGE, SUN_FRINGE_FADE_PX, SUN_SEGMENTS, SUN_SHELL } from './sun-spicules'

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function tick(surface: ReturnType<typeof sunSurface>, material: THREE.ShaderMaterial, time: number) {
  surface.step()
  material.uniforms.time.value = time
}

// Per view, at draw time: the eye and the view direction in the Sun's
// frame, which the photosphere traces its sphere in (sun/fragment.frag),
// and the fringe's fade in device px, which its fwidth measures in.
function setView(material: THREE.ShaderMaterial, renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Object3D) {
  const { uEyeObject, uDirObject, uFringeFadePx } = material.uniforms
  eyeInObject(camera, mesh, uEyeObject.value, uDirObject.value)
  uFringeFadePx.value.set(...SUN_FRINGE_FADE_PX).multiplyScalar(renderer.getPixelRatio())
}

interface SunRendererProps {
  diameter: number
  /** The main view (not a panel or ship mode), whose corona reaches further. */
  interactive?: boolean
}

export default function SunRenderer({ diameter, interactive = false }: SunRendererProps) {
  // In ship mode only ShipView mounts a scene, so this is the ship's Sun.
  const shipMode = useStore((s) => s.shipMode)
  // A plain sphere: the trace makes the limb exact, so no limb sphere.
  const sphere = useMemo(() => {
    const geometry = new THREE.SphereGeometry(diameter, ...SUN_SEGMENTS)
    // Culled and picked by the shell the vertex shader draws.
    geometry.computeBoundingSphere()
    geometry.boundingSphere!.radius *= SUN_SHELL
    return geometry
  }, [diameter])
  useEffect(() => () => sphere.dispose(), [sphere])
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
      // The traced surface's depth, where blades and filaments stand on it
      // close in: the high tier only, as the low tier has no blades and a
      // depth write costs a phone its early depth test.
      defines: isLowQuality() ? {} : { SUN_TRACED_DEPTH: '' },
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
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (mesh.current) setView(sunMaterial, renderer, camera, mesh.current)
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
      {/* Only where the eye can come close: View from Earth and Moon Phase
          never draw a blade. */}
      {!isLowQuality() && (shipMode || interactive) && <SunSpicules radius={diameter} />}
      {/* Far glare: keeps the Sun a bright point when its disc is sub-pixel
          at flight-scale ranges (tides-2hv.12); separate from the corona. */}
      {shipMode && <SunGlare radius={diameter} />}
    </>
  )
}
