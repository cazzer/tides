import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import vertexShader from '../shaders/sun-spicule/vertex.glsl'
import fragmentShader from '../shaders/sun-spicule/fragment.frag'
import { createSpiculeGeometry, SPICULE_FADE_PX, SPICULE_WIDTH, SUN_FRINGE } from './sun-spicules'

const viewport = new THREE.Vector4()
const centre = new THREE.Vector3()
const eye = new THREE.Vector3()

function createSpicules() {
  const geometry = createSpiculeGeometry()
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Premultiplied, as the prominences: glow adds, cover darkens the disc.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
    // One pass, though double-sided and transparent.
    forceSinglePass: true,
    depthTest: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      uViewHeight: { value: 1 },
      uFadePx: { value: new THREE.Vector2(...SPICULE_FADE_PX) },
      uFringe: { value: SUN_FRINGE },
    },
  })
  return { geometry, material, blades: geometry.instanceCount }
}

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function setTime(material: THREE.ShaderMaterial, time: number) {
  material.uniforms.time.value = time
}

// Per view, at draw time: the view's height (the main view and each panel
// differ), and none of the ~100k blades at all while even the widest, at
// the nearest the surface comes to the eye, would be under the fade.
function prepare(
  { geometry, material, blades }: ReturnType<typeof createSpicules>,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  mesh: THREE.Object3D
) {
  renderer.getCurrentViewport(viewport)
  const viewHeight = viewport.w / renderer.getPixelRatio()
  material.uniforms.uViewHeight.value = viewHeight
  const radius = mesh.matrixWorld.getMaxScaleOnAxis()
  let px = SPICULE_WIDTH[1] * radius * camera.projectionMatrix.elements[5] * 0.5 * viewHeight
  if (!(camera as THREE.OrthographicCamera).isOrthographicCamera) {
    centre.setFromMatrixPosition(mesh.matrixWorld)
    eye.setFromMatrixPosition(camera.matrixWorld)
    px /= Math.max(centre.distanceTo(eye) - radius, 1e-9)
  }
  geometry.instanceCount = px < SPICULE_FADE_PX[0] ? 0 : blades
}

/**
 * The spicules as 3D blades in tufts (sun-spicules.ts), one instanced draw,
 * high tier only. A child of the Sun's oriented group, so they turn with it.
 */
export function SunSpicules({ radius }: { radius: number }) {
  const spicules = useMemo(() => createSpicules(), [])
  const { geometry, material } = spicules
  useEffect(() => () => {
    geometry.dispose()
    material.dispose()
  }, [geometry, material])
  useFrame((state) => setTime(material, state.clock.elapsedTime))
  const mesh = useRef<THREE.Mesh>(null)
  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (mesh.current) prepare(spicules, renderer, camera, mesh.current)
    },
    [spicules]
  )
  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      scale={radius}
      onBeforeRender={onBeforeRender}
      raycast={() => null}
    />
  )
}
