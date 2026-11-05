import { useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import coronaVertex from '../shaders/sun-corona/vertex.glsl'
import coronaFragment from '../shaders/sun-corona/fragment.frag'
import { CORONA_MAX_ANGLE, CORONA_OUTER_MAIN, CORONA_OUTER_PERSPECTIVE, CORONA_QUAD_MAIN, coronaClipRect } from './corona-geometry'
import { SunGlare } from './SunGlare'
import { SunGlow } from './glow/SunGlow'
import { sunRaycast } from './sun-pick'
import { useStore } from '../store'
import { isLowQuality } from '../quality'
import { sunSurface } from './sun-surface'
import { useSceneGate } from './scene-shown'
import { SunProminences } from './SunProminences'
import { SunSpicules } from './SunSpicules'
import { eyeSky, EYE_AIRLESS_KM } from '../night-flight'
import { sunDiscTint } from '../cloud-layer'
import { eyeInObject, SUN_FRINGE, SUN_FRINGE_FADE_PX, SUN_SEGMENTS, SUN_SHELL, sunShellScale } from './sun-spicules'
import { STOP_TOP_LEVEL_SHARE, sphereLevels, useSphereLevel } from '../ship/sphere-lod'
import type { SphereSegments } from '../ship/limb-detail'

// Outside the component: the react-hooks lint rejects mutating a memoised
// material in place, as three's uniforms are meant to be.
function tick(surface: ReturnType<typeof sunSurface>, material: THREE.ShaderMaterial, time: number) {
  surface.step()
  material.uniforms.time.value = time
}

// Per view, at draw time: the eye and the view direction in the Sun's
// frame, which the photosphere traces its sphere in (sun/fragment.frag),
// the fringe's fade in device px, which its fwidth measures in, and the
// air the eye sees the Sun through (night-flight.ts eyeSky), by its up in
// the Sun's frame (sun/air.glsl); and the disc, for the sky (setSkyOverDisc()).
function setView(
  material: THREE.ShaderMaterial,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  mesh: THREE.Object3D,
  geometry: THREE.BufferGeometry
) {
  const { uEyeObject, uDirObject, uFringeFadePx, uAirUp, uAirKm, uRadius, uShell } = material.uniforms
  uShell.value = geometry.userData.sunShell ?? SUN_SHELL
  eyeInObject(camera, mesh, uEyeObject.value, uDirObject.value)
  uFringeFadePx.value.set(...SUN_FRINGE_FADE_PX).multiplyScalar(renderer.getPixelRatio())
  uAirKm.value = eyeSky.heightKm
  toObject.copy(mesh.matrixWorld).invert()
  uAirUp.value.copy(eyeSky.up).transformDirection(toObject)
  setSkyOverDisc(camera, mesh, uRadius.value)
}

// The Sun's sphere of `radius` at `segments`, culled and picked by the shell
// the vertex shader draws it out to, which its facets set (sunShellScale).
function sunSphere(radius: number, segments: SphereSegments): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, ...segments)
  const shell = sunShellScale(segments)
  geometry.computeBoundingSphere()
  geometry.boundingSphere!.radius *= shell
  geometry.userData.segments = segments
  geometry.userData.sunShell = shell
  return geometry
}

// The direction from the eye to the Sun's centre, and its distance.
function towardSun(camera: THREE.Camera, sun: THREE.Object3D): number {
  sunWorld.setFromMatrixPosition(sun.matrixWorld)
  const distance = sunWorld.sub(eyeWorld.setFromMatrixPosition(camera.matrixWorld)).length()
  sunWorld.divideScalar(distance)
  return distance
}

// The corona's, per view: the air's extinction toward the Sun's centre.
function setCoronaAir(corona: THREE.ShaderMaterial, camera: THREE.Camera, sun: THREE.Object3D) {
  const tint = corona.uniforms.uAirTint.value as THREE.Color
  if (eyeSky.heightKm >= EYE_AIRLESS_KM) {
    tint.setRGB(1, 1, 1)
    return
  }
  towardSun(camera, sun)
  tint.setRGB(...sunDiscTint(sunWorld.dot(eyeSky.up), eyeSky.heightKm))
}

const coronaCentre = new THREE.Vector3()
const coronaViewport = new THREE.Vector4()
const coronaScissor = new THREE.Vector4()
const coronaFloor = new THREE.Vector4()
const coronaClip = new THREE.Vector4()
let coronaScissorTest = false
let coronaClipped = false

// The main view's corona is drawn only out to CORONA_QUAD_MAIN limb radii,
// a scissor inside the current one: past it the glow is under a display
// step. That holds for exposures within the bake's range (CORONA_QUAD_MAIN
// keeps a margin for the night flight's); a brighter one could lift the
// cut-off glow over a step. Only into the canvas with a perspective camera:
// a render target keeps its own scissor, and an ortho main view is drawn
// whole.
function clipCorona(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sun: THREE.Object3D, radius: number) {
  coronaClipped = false
  if (renderer.getRenderTarget() || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return
  // The scissor in effect: three applies the CSS one in device px, rounded
  // by setScissor but floored after a render target switch. Clip only
  // where the two agree, so it's known to the pixel and restored exactly.
  const ratio = renderer.getPixelRatio()
  renderer.getScissor(coronaScissor).multiplyScalar(ratio)
  coronaFloor.copy(coronaScissor).floor()
  if (!coronaScissor.round().equals(coronaFloor)) return
  coronaCentre.setFromMatrixPosition(sun.matrixWorld).applyMatrix4(camera.matrixWorldInverse)
  renderer.getCurrentViewport(coronaViewport)
  if (!coronaClipRect(coronaCentre.x, coronaCentre.y, coronaCentre.z, radius, CORONA_QUAD_MAIN, camera.projectionMatrix.elements, coronaViewport, coronaClip)) return
  coronaScissorTest = renderer.getScissorTest()
  if (coronaScissorTest) {
    const x0 = Math.max(coronaClip.x, coronaScissor.x)
    const y0 = Math.max(coronaClip.y, coronaScissor.y)
    const x1 = Math.min(coronaClip.x + coronaClip.z, coronaScissor.x + coronaScissor.z)
    const y1 = Math.min(coronaClip.y + coronaClip.w, coronaScissor.y + coronaScissor.w)
    coronaClip.set(x0, y0, Math.max(x1 - x0, 0), Math.max(y1 - y0, 0))
  }
  // Straight to the GL state, in device px: three's own scissor stays as it was.
  renderer.state.scissor(coronaClip)
  renderer.state.setScissorTest(true)
  coronaClipped = true
}

function unclipCorona(renderer: THREE.WebGLRenderer) {
  if (!coronaClipped) return
  coronaClipped = false
  renderer.state.scissor(coronaScissor)
  renderer.state.setScissorTest(coronaScissorTest)
}

function fadeCorona(corona: THREE.ShaderMaterial, fade: number) {
  const tint = corona.uniforms.uAirTint.value as THREE.Color
  tint.multiplyScalar(fade)
}

// The sky over the disc from inside the air (atmosphere/fragment.frag,
// tides-d9f.2): the disc is drawn far fainter than the Sun, so the sky in
// front of it, nothing against the true disc, would pale a setting one to
// white. It gives way over the disc's inner SKY_GIVES_WAY of its radius,
// easing to the limb, by as much as the air takes the disc's green (the
// channel that turns it from gold to red), squared, so it gives way well
// before the disc is down (79% with the Sun 6 degrees up, 60% at 10) and a
// high Sun keeps its sky.
function setSkyOverDisc(camera: THREE.Camera, sun: THREE.Object3D, radius: number) {
  if (eyeSky.heightKm >= EYE_AIRLESS_KM) return
  const distance = towardSun(camera, sun)
  const angle = Math.asin(Math.min((radius * sun.matrixWorld.getMaxScaleOnAxis()) / distance, 1))
  eyeSky.sunDisc.copy(sunWorld)
  eyeSky.sunDiscCos.set(Math.cos(angle * SKY_GIVES_WAY[1]), Math.cos(angle * SKY_GIVES_WAY[0]))
  eyeSky.sunDiscFade = 1 - sunDiscTint(sunWorld.dot(eyeSky.up), eyeSky.heightKm)[1] ** 2
}

// Over what of the disc's radius the sky gives way: all of it inside the
// first, none from the second (the limb, which the fringe's jets stand on).
const SKY_GIVES_WAY: readonly [number, number] = [0.8, 0.97]

const toObject = new THREE.Matrix4()
const sunWorld = new THREE.Vector3()
const eyeWorld = new THREE.Vector3()

interface SunRendererProps {
  diameter: number
  /** The main view (not a panel or ship mode), whose corona reaches further. */
  interactive?: boolean
  /** Scales the corona each draw, 0..1 (View from Earth's sky: full only in totality). */
  coronaFade?: () => number
}

export default function SunRenderer({ diameter, interactive = false, coronaFade }: SunRendererProps) {
  // In ship mode only ShipView mounts a scene, so this is the ship's Sun.
  const shipMode = useStore((s) => s.shipMode)
  // A plain sphere: the trace makes the limb exact, so no limb sphere. Sized
  // to the Sun on this View's screen (tides-0oi.16), each level's built
  // once, with its own shell (sunShellLevel); the top within the ship's stop.
  const mesh = useRef<THREE.Mesh>(null)
  const level = useSphereLevel(mesh, diameter, SUN_SEGMENTS, diameter * STOP_TOP_LEVEL_SHARE)
  const spheres = useMemo(() => sphereLevels(SUN_SEGMENTS).map((segments) => sunSphere(diameter, segments)), [diameter])
  useEffect(() => () => spheres.forEach((sphere) => sphere.dispose()), [spheres])
  const sphere = spheres.find(({ userData }) => userData.segments[0] === level[0]) ?? spheres[0]
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
        uAirUp: { value: new THREE.Vector3(0, 1, 0) },
        uAirKm: { value: EYE_AIRLESS_KM },
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
        uAirTint: { value: new THREE.Color(1, 1, 1) },
      },
    })
  }, [diameter, interactive, surface])

  useEffect(() => () => sunMaterial.dispose(), [sunMaterial])
  useEffect(() => () => coronaMaterial.dispose(), [coronaMaterial])

  // The bake waits for every view on the first load to show (CompileGate):
  // its first face is ~100 ms of GPU work cold, which the gate's sync calls
  // (first uses, uploads) would wait behind.
  // The loading screen stays up until it's done, too: an unbaked Sun is plain.
  const { shown: sceneShown, waitFor } = useSceneGate()
  // Layout effects, so the hold is on before the first frame runs.
  useLayoutEffect(() => {
    if (!sceneShown) return surface.hold()
  }, [surface, sceneShown])
  useLayoutEffect(() => waitFor(() => surface.done()), [surface, waitFor])
  useFrame((state) => tick(surface, sunMaterial, state.clock.elapsedTime))
  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry) => {
      if (mesh.current) setView(sunMaterial, renderer, camera, mesh.current, geometry)
    },
    [sunMaterial]
  )
  const onBeforeCoronaRender = useCallback(
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (!mesh.current) return
      setCoronaAir(coronaMaterial, camera, mesh.current)
      if (coronaFade) fadeCorona(coronaMaterial, coronaFade())
      if (interactive) clipCorona(renderer, camera, mesh.current, diameter)
    },
    [coronaMaterial, coronaFade, interactive, diameter]
  )

  return (
    <>
      <mesh
        ref={mesh}
        geometry={sphere}
        raycast={sunRaycast}
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
        onBeforeRender={onBeforeCoronaRender}
        onAfterRender={unclipCorona}
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
      {/* Its glow (tides-64u.2), handed over from the glare above as the disc
          grows, so the two never stack. Only drawn where a GlowPass is. */}
      <SunGlow radius={diameter} />
    </>
  )
}
