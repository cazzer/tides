// A thin blue limb glow on the sunlit side, warming toward the terminator
// (tides-qe5). Additive, so it only ever brightens the limb.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { sunDirectionLocal } from '../aurora'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'
import {
  ATMOSPHERE_DUSK,
  ATMOSPHERE_GAIN,
  ATMOSPHERE_OUTER,
  ATMOSPHERE_RENDER_ORDER,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SKY,
  ATMOSPHERE_SURFACE,
  groundHazeTop,
  pickShellFaces,
  shipNearEarth,
} from './earth-shells'
import { isLowQuality } from '../quality'
import { useBodySphere } from '../ship/limb-detail'
import { createSkyView, SKY_VIEW_UNIFORMS, type SkyView } from './skyView'

// Fractions of the Earth's radius. The haze starts at the cloud deck and
// thins out with an (exaggerated, for visibility) ~60 km scale height.
const SURFACE = ATMOSPHERE_SURFACE
const OUTER = ATMOSPHERE_OUTER
const SCALE_HEIGHT = ATMOSPHERE_SCALE_HEIGHT
// Linear RGB: blue overhead, reddening toward the terminator.
const SKY = new THREE.Vector3(...ATMOSPHERE_SKY)
const DUSK = new THREE.Vector3(...ATMOSPHERE_DUSK)

const noRaycast = () => null

// After the ship's settle (ShipController, SHIP_SETTLE_PRIORITY) has put the
// camera where this frame draws it, before drei's Views render (1 and up).
const SKY_VIEW_PRIORITY = 0.9
const _eye = new THREE.Vector3()
const _sun = new THREE.Vector3()

// The table for `camera`'s eye in the shell's frame (sea level `radius`),
// or off over the haze, where the limb's glow takes over (haze.glsl
// hazeGlow()), and for any camera but the ship's near Earth (the Moon Phase
// panel's sits inside the shells, at the centre, but never draws the sky
// from inside). Module level, so the memoised table isn't mutated in a hook.
function drawSkyView(
  skyView: SkyView,
  gl: THREE.WebGLRenderer,
  shell: { current: THREE.Object3D | null },
  camera: THREE.Camera,
  radius: number,
  timestamp: number
) {
  if (!shell.current) return
  if (!shipNearEarth(camera)) {
    skyView.update(gl, null, 0)
    return
  }
  const eye = shell.current.worldToLocal(camera.getWorldPosition(_eye))
  const eyeR = eye.length() / radius
  const inside = eyeR < ATMOSPHERE_SURFACE + 4 * ATMOSPHERE_SCALE_HEIGHT
  skyView.update(gl, inside ? eyeR : null, eye.normalize().dot(sunDirectionLocal(timestamp, _sun)))
}

export default function AtmosphereRenderer({ radius }: { radius: number }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          uSurface: { value: 0 },
          uOuter: { value: 0 },
          uScaleHeight: { value: 0 },
          uSeaLevel: { value: 0 },
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uGain: { value: ATMOSPHERE_GAIN },
          uSky: { value: SKY },
          uDusk: { value: DUSK },
          ...SKY_VIEW_UNIFORMS,
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        // Double-sided in ship mode (pickShellFaces), where the shader keeps
        // one face per ray; under the cloud shell's top it stops at the
        // ground, which lays its own share of the haze over itself
        // (groundHaze.ts).
        forceSinglePass: true,
      }),
    []
  )
  // Uniforms are updated through the mesh, not the memoised material.
  const mesh = useRef<THREE.Mesh>(null)
  // The glow is faint but not zero at its outer edge, so from the ship's stop
  // a coarse shell shows as facets there.
  const geometry = useBodySphere('earth', radius * OUTER, [96, 48])
  // Under the cloud shell's top the haze stops at the ground (groundHaze.ts);
  // the quality tier is fixed for the page.
  const hazeStop = useMemo(() => radius + groundHazeTop(isLowQuality()), [radius])

  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    const { timestamp } = useStore.getState()
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (timestamp == null || !shader) return
    const u = shader.uniforms
    u.uSurface.value = radius * SURFACE
    u.uOuter.value = radius * OUTER
    u.uScaleHeight.value = radius * SCALE_HEIGHT
    u.uSeaLevel.value = radius
    sunDirectionLocal(timestamp, u.uSun.value)
  })

  // The high tier's sky-view table, marched for the drawing eye each frame
  // it is inside the haze (skyView.ts).
  const skyView = useMemo(() => (isLowQuality() ? null : createSkyView()), [])
  useEffect(() => () => skyView?.dispose(), [skyView])
  useFrame(({ gl, camera }) => {
    const { timestamp } = useStore.getState()
    if (skyView && timestamp != null) drawSkyView(skyView, gl, mesh, camera, radius, timestamp)
  }, SKY_VIEW_PRIORITY)

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      renderOrder={ATMOSPHERE_RENDER_ORDER}
      raycast={noRaycast}
      onBeforeRender={(_renderer, _scene, camera, _geometry, shader) =>
        pickShellFaces(mesh.current!, shader, camera, hazeStop)
      }
    />
  )
}
