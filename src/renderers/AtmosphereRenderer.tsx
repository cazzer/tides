// A thin blue limb glow on the sunlit side, warming toward the terminator
// (tides-qe5). Additive from outside, so it only ever brightens the limb.
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
  eyeNearEarth,
} from './earth-shells'
import { isLowQuality } from '../quality'
import { useBodySphere } from '../ship/limb-detail'
import { createSkyView, SKY_VIEW_UNIFORMS, type SkyView } from './skyView'
import { eyeSky } from '../night-flight'

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
const _toShell = new THREE.Matrix4()

// Per view, at draw time: the Sun's disc, which the sky gives way over
// from inside (SunRenderer's setSkyOverDisc(), drawn before it), in the
// shell's frame.
function setSunDisc(material: THREE.ShaderMaterial, shell: THREE.Object3D) {
  const { uSunDisc, uSunDiscCos } = material.uniforms
  uSunDiscCos.value.set(eyeSky.sunDiscCos.x, eyeSky.sunDiscCos.y, eyeSky.sunDiscFade)
  if (eyeSky.sunDiscFade > 0) uSunDisc.value.copy(eyeSky.sunDisc).transformDirection(_toShell.copy(shell.matrixWorld).invert())
}

// The table for `camera`'s eye in the shell's frame (sea level `radius`),
// or off over the haze, where the limb's glow takes over (haze.glsl
// hazeGlow()), and for any camera but the near-Earth one (eyeNearEarth: the
// ship's, or the main view's in close zoom; the Moon Phase panel's sits
// inside the shells, at the centre, but never draws the sky
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
  if (!eyeNearEarth(camera)) {
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
          uSunDisc: { value: new THREE.Vector3(0, 0, 1) },
          uSunDiscCos: { value: new THREE.Vector3(1, 1, 0) },
          ...SKY_VIEW_UNIFORMS,
        },
        transparent: true,
        depthWrite: false,
        // Premultiplied: the haze adds its glow and, over the ground from
        // inside, hides its cover's share of it (haze.glsl hazeCover(),
        // tides-d9f.3); elsewhere its alpha is 0, an additive blend.
        defines: { HAZE_COVER: '' },
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        // Double-sided in ship mode (pickShellFaces), where the shader keeps
        // one face per ray; under the cloud shell's top it stops at the
        // ground, which lays its own share of the haze over itself
        // (groundHaze.ts). That program warmed ahead (ship-warmup.ts
        // warmSides): the main view's first close zoom turns to it
        // (tides-tvr.7.4).
        forceSinglePass: true,
        userData: { warmSides: [THREE.DoubleSide] },
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
      // The sky-view table's pass, for the warm-ups (ship-warmup.ts).
      userData={{ warmProbes: () => (skyView ? [skyView.probe] : []) }}
      onBeforeRender={(_renderer, _scene, camera, _geometry, shader) => {
        pickShellFaces(mesh.current!, shader, camera, hazeStop)
        setSunDisc(shader as THREE.ShaderMaterial, mesh.current!)
      }}
    />
  )
}
