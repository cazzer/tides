import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import vertexShader from '../shaders/sun-spicule/vertex.glsl'
import fragmentShader from '../shaders/sun-spicule/fragment.frag'
import { whenIdle } from '../ship/limb-detail'
import { createSpiculeGeometry, SPICULE_FADE_PX, spiculeInstanceCount, SUN_FRINGE } from './sun-spicules'

const viewport = new THREE.Vector4()

// One blade geometry (~4 MB) for every view that draws the Sun, built in an
// idle period rather than during a render (its layout takes ~50 ms) and
// dropped when the last view lets it go.
let shared: { geometry: THREE.InstancedBufferGeometry; blades: number } | null = null
let users = 0
let cancelBuild: (() => void) | null = null
const listeners = new Set<() => void>()

function retainSpicules(): () => void {
  users++
  if (!shared && !cancelBuild) {
    cancelBuild = whenIdle(() => {
      cancelBuild = null
      const geometry = createSpiculeGeometry()
      shared = { geometry, blades: geometry.instanceCount }
      listeners.forEach((listener) => listener())
    })
  }
  return () => {
    users--
    if (users > 0) return
    cancelBuild?.()
    cancelBuild = null
    shared?.geometry.dispose()
    shared = null
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const sharedSpicules = () => shared

function createMaterial() {
  return new THREE.ShaderMaterial({
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
}

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function setTime(material: THREE.ShaderMaterial, time: number) {
  material.uniforms.time.value = time
}

// Per view, at draw time: the view's height (the main view and each panel
// differ), and none of the ~100k blades while they would all be too thin.
// The geometry is shared, so its count is set for each draw.
function prepare(
  material: THREE.ShaderMaterial,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  mesh: THREE.Mesh
) {
  if (!shared) return
  renderer.getCurrentViewport(viewport)
  const viewHeight = viewport.w / renderer.getPixelRatio()
  material.uniforms.uViewHeight.value = viewHeight
  shared.geometry.instanceCount = spiculeInstanceCount(camera, mesh, viewHeight, shared.blades)
}

/**
 * The spicules as 3D blades in tufts (sun-spicules.ts), one instanced draw,
 * high tier only, once their geometry is built. A child of the Sun's
 * oriented group, so they turn with it.
 */
export function SunSpicules({ radius }: { radius: number }) {
  useEffect(() => retainSpicules(), [])
  const spicules = useSyncExternalStore(subscribe, sharedSpicules)
  const material = useMemo(() => createMaterial(), [])
  useEffect(() => () => material.dispose(), [material])
  useFrame((state) => setTime(material, state.clock.elapsedTime))
  const mesh = useRef<THREE.Mesh>(null)
  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (mesh.current) prepare(material, renderer, camera, mesh.current)
    },
    [material]
  )
  if (!spicules) return null
  return (
    <mesh
      ref={mesh}
      geometry={spicules.geometry}
      material={material}
      scale={radius}
      onBeforeRender={onBeforeRender}
      raycast={() => null}
    />
  )
}
