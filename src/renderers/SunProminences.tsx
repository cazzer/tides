import { useCallback, useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import vertexShader from '../shaders/sun-prominence/vertex.glsl'
import fragmentShader from '../shaders/sun-prominence/fragment.frag'
import { isLowQuality } from '../quality'
import { createProminenceGeometry, PROMINENCE_FADE_PX, PROMINENCE_LOOP_FADE_PX } from './sun-prominences'
import { SUN_FRINGE, SUN_FRINGE_FADE_PX } from './sun-spicules'

const viewport = new THREE.Vector4()

function createProminences(low: boolean) {
  const geometry = createProminenceGeometry(low)
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Premultiplied: glow adds, and a filament's cover darkens the disc.
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
      uFringe: { value: SUN_FRINGE },
      uFringeFadePx: { value: new THREE.Vector2() },
      uFadePx: { value: new THREE.Vector2(...PROMINENCE_FADE_PX) },
      uLoopFadePx: { value: new THREE.Vector2(...PROMINENCE_LOOP_FADE_PX) },
    },
  })
  return { geometry, material }
}

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function setTime(material: THREE.ShaderMaterial, time: number) {
  material.uniforms.time.value = time
}

// The view's height at draw time: the main view and each panel differ.
function setViewHeight(material: THREE.ShaderMaterial, renderer: THREE.WebGLRenderer) {
  renderer.getCurrentViewport(viewport)
  material.uniforms.uViewHeight.value = viewport.w / renderer.getPixelRatio()
  material.uniforms.uFringeFadePx.value.set(...SUN_FRINGE_FADE_PX).multiplyScalar(renderer.getPixelRatio())
}

/**
 * Prominences and coronal loops (sun-prominences.ts), one draw. A child of
 * the Sun's oriented group, so they turn with it.
 */
export function SunProminences({ radius }: { radius: number }) {
  const { geometry, material } = useMemo(() => createProminences(isLowQuality()), [])
  useEffect(() => () => {
    geometry.dispose()
    material.dispose()
  }, [geometry, material])
  useFrame((state) => setTime(material, state.clock.elapsedTime))
  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer) => setViewHeight(material, renderer),
    [material]
  )
  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={radius}
      onBeforeRender={onBeforeRender}
      raycast={() => null}
    />
  )
}
