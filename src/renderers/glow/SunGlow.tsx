import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { GLARE_FADE_PX } from '../glare-geometry'
import { GLOW_LAYER, GLOW_SCALE } from './glow'
import { GLOW_ORDER, glowOn, useGlowSource } from './glowSources'
import { sunGlowWeight } from './sun-glow'

/** [TUNE] The Sun's glow, linear, at the disc's centre (limb-darkened out). */
const SUN_GLOW_INTENSITY = 1.5
/** The glow's colour: the gold of the EUV disc (tides-5xd), a touch whiter. */
const SUN_GLOW_COLOR = new THREE.Color('#ffc46b')

const vertexShader = /* glsl */ `
  varying vec3 vNormalView;
  void main() {
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec3 vNormalView;
  void main() {
    // Brightest at the centre, a third at the limb: the glow hugs a disc,
    // not a flat coin.
    float mu = clamp(normalize(vNormalView).z, 0.0, 1.0);
    gl_FragColor = vec4(uColor * uIntensity * (0.35 + 0.65 * mu), 1.0);
  }
`

const centre = new THREE.Vector3()
const eye = new THREE.Vector3()
const viewport = new THREE.Vector4()

// The glow's strength for this draw, from the disc's radius in the View's
// CSS px: the glow target is the View at the pixel ratio times its scale.
// Module level, so the render hook doesn't mutate a memoised value in place.
function setSunGlow(
  material: THREE.ShaderMaterial,
  sun: THREE.Object3D,
  radius: number,
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera
): void {
  renderer.getCurrentViewport(viewport)
  sun.getWorldPosition(centre)
  material.uniforms.uIntensity.value =
    SUN_GLOW_INTENSITY *
    sunGlowWeight({
      distance: centre.distanceTo(camera.getWorldPosition(eye)),
      radius: radius * sun.matrixWorld.getMaxScaleOnAxis(),
      projectionYY: camera.projectionMatrix.elements[5],
      isPerspective: (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true,
      viewHeightPx: viewport.w / (renderer.getPixelRatio() * GLOW_SCALE),
      fadePx: GLARE_FADE_PX,
    })
}

/**
 * The Sun in the glow layer (tides-64u.2): a plain sphere of the disc's size
 * in its gold, so the limb blooms. It fades in over the disc radii that
 * SunGlare (ship mode's far glare) fades out over, so the two hand over and
 * never stack: the Sun reads as one source at every zoom. Mount inside the
 * Sun's group.
 */
export function SunGlow({ radius }: { radius: number }) {
  return glowOn() ? <SunGlowOn radius={radius} /> : null
}

function SunGlowOn({ radius }: { radius: number }) {
  const mesh = useRef<THREE.Mesh>(null)
  useGlowSource(mesh, GLOW_ORDER.opaque)
  const geometry = useMemo(() => new THREE.SphereGeometry(radius, 48, 24), [radius])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uColor: { value: SUN_GLOW_COLOR.clone() },
          uIntensity: { value: 0 },
        },
        toneMapped: false,
      }),
    []
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    mesh.current?.layers.set(GLOW_LAYER)
  }, [])

  const onBeforeRender = useCallback(
    (renderer: THREE.WebGLRenderer, _scene: THREE.Scene, camera: THREE.Camera) => {
      if (mesh.current) setSunGlow(material, mesh.current, radius, renderer, camera)
    },
    [material, radius]
  )

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      onBeforeRender={onBeforeRender}
      raycast={() => null}
    />
  )
}
