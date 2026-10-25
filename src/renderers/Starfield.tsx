import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { MakeTime, RotateVector, Rotation_EQJ_ECT, Vector } from 'astronomy-engine'

import starsBinUrl from '../assets/stars.bin?url'
import starsDistanceUrl from '../assets/stars.distance.bin?url'
import starsMeta from '../assets/stars.meta.json'
import { eclipticToScene } from '../ephemeris'
import { useStore } from '../store'
import { depthAmount, shellDepth, shellPointVertex, shellScale, shellVertex } from './starDepth'

type StarfieldProps = {
  radius?: number
  size?: number
  opacity?: number
  fromSurface?: boolean
  /** Spread the stars into a depth shell as this view zooms out (starDepth.ts). */
  depth?: boolean
}

export const DEFAULT_RADIUS = 1000
const DEFAULT_SIZE = 1.2

// stars.bin holds J2000 unit vectors as (cosδ cosα, sinδ, cosδ sinα)
// (scripts/convertStars.mjs); returns J2000 equatorial (x toward α = 0h,
// z north). Read as-is, that layout puts the celestial pole on the scene's
// ecliptic pole and mirrors right ascension.
export function starDirectionsEQJ(floatData: Float32Array, stride: number) {
  const starCount = Math.floor(floatData.length / stride)
  const directions = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i += 1) {
    directions[i * 3] = floatData[i * stride]
    directions[i * 3 + 1] = floatData[i * stride + 2]
    directions[i * 3 + 2] = floatData[i * stride + 1]
  }
  return directions
}

const axisImages = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const toScene = new THREE.Matrix4()

// Turns J2000 equatorial into the scene's ecliptic of date (precession is
// ~0.36° by 2026, so the J2000 catalog can't be used as-is).
export function orientStarfield(stars: THREE.Object3D, t: number) {
  const time = MakeTime(new Date(t))
  const rotation = Rotation_EQJ_ECT(time)
  axisImages.forEach((image, axis) => {
    const unit = new Vector(+(axis === 0), +(axis === 1), +(axis === 2), time)
    eclipticToScene(RotateVector(rotation, unit), image)
  })
  toScene.makeBasis(axisImages[0], axisImages[1], axisImages[2])
  stars.quaternion.setFromRotationMatrix(toScene)
}

const cameraPosition = new THREE.Vector3()

// The stars are infinitely far away: centred on whichever camera is drawing
// them, every panel sees them in their true directions. Centred on the Sun,
// parallax put them up to ~2.9° off as seen from the Earth. The main view's
// depth shell (starDepth.ts) moves its centre `share` of the way from the
// camera to `towards`, so the eye sits off-centre and sees the parallax.
export function centreStarfieldOn(
  stars: THREE.Object3D,
  camera: THREE.Object3D,
  towards?: THREE.Vector3,
  share = 0
) {
  camera.getWorldPosition(cameraPosition)
  if (towards && share > 0) cameraPosition.lerp(towards, share)
  stars.position.copy(stars.parent ? stars.parent.worldToLocal(cameraPosition) : cameraPosition)
  stars.updateMatrixWorld()
}

// Drawn brightness is linear in magnitude, not flux: 1 at magnitude -1.5,
// down to a floor of 0.1 at 5.7, where the faint ~60% of the catalogue sits.
const BRIGHTEST_MAGNITUDE = -1.5
const MAGNITUDES_TO_BLACK = 8
const BRIGHTNESS_FLOOR = 0.1
export function starBrightness(vmag: number) {
  return THREE.MathUtils.clamp(
    1 - (vmag - BRIGHTEST_MAGNITUDE) / MAGNITUDES_TO_BLACK,
    BRIGHTNESS_FLOOR,
    1
  )
}

// So the 7.2 magnitudes down to the floor span one decade of drawn brightness,
// the flux of 2.5. A magnitude lost to the sky dims a drawn star by this much
// of one: in full, extinction took the floor stars out of the bottom ~10° of
// sky and left an empty band above the horizon (tides-clo).
export const DRAWN_MAGNITUDE_SCALE =
  (2.5 * Math.log10(1 / BRIGHTNESS_FLOOR)) / ((1 - BRIGHTNESS_FLOOR) * MAGNITUDES_TO_BLACK)

// Magnitudes a star loses per airmass through a clear sky (V band). From the
// surface, stars fade into the horizon rather than running sharp up to the
// ground, which read as the starfield being cut off.
export const EXTINCTION_PER_AIRMASS = 0.25
const DRAWN_EXTINCTION_PER_AIRMASS = EXTINCTION_PER_AIRMASS * DRAWN_MAGNITUDE_SCALE

// Rozenberg's airmass: 1 at the zenith, ~40 (not infinite) at the horizon.
export function airmass(sinAltitude: number) {
  const s = Math.max(sinAltitude, 0)
  return 1 / (s + 0.025 * Math.exp(-11 * s))
}

// Share of a star's drawn zenith brightness left at this altitude.
export function extinction(sinAltitude: number) {
  return 10 ** (-0.4 * DRAWN_EXTINCTION_PER_AIRMASS * (airmass(sinAltitude) - 1))
}

const extinctionVertex = /* glsl */ `
#include <color_vertex>
if (uExtinction > 0.5) {
  float s = max(dot(normalize(mat3(modelMatrix) * position), uZenith), 0.0);
  float airmass = 1.0 / (s + 0.025 * exp(-11.0 * s));
  vColor.rgb *= pow(10.0, -0.4 * ${DRAWN_EXTINCTION_PER_AIRMASS.toFixed(5)} * (airmass - 1.0));
}
`

// Sets the shell's fade, size and the point it is centred toward (starDepth.ts).
// Module level, so the refs and memoised uniforms aren't mutated in a hook.
function fadeShell(
  stars: THREE.Object3D | null,
  uDepth: { value: number },
  centre: THREE.Vector3,
  target: THREE.Vector3 | undefined,
  scale: number,
  amount: number
) {
  uDepth.value = amount
  if (target) centre.copy(target)
  stars?.scale.setScalar(scale)
}

// The surface camera's parent is the observer, whose +Y is the zenith.
export function zenithOf(camera: THREE.Camera, target: THREE.Vector3) {
  return camera.parent
    ? target.set(0, 1, 0).transformDirection(camera.parent.matrixWorld)
    : target.set(0, 1, 0)
}

export default function Starfield({
  radius = DEFAULT_RADIUS,
  size = DEFAULT_SIZE,
  opacity = 1,
  fromSurface = false,
  depth = false,
}: StarfieldProps) {
  const [buffer, distanceBuffer] = useLoader(
    THREE.FileLoader,
    [starsBinUrl, starsDistanceUrl],
    (loader) => {
      loader.setResponseType('arraybuffer')
    }
  ) as ArrayBuffer[]

  const geometry = useMemo(() => {
    const floatData = new Float32Array(buffer)
    const stride = starsMeta.stride ?? 7
    const starCount = Math.floor(floatData.length / stride)

    const directions = starDirectionsEQJ(floatData, stride)
    const distances = new Float32Array(distanceBuffer)
    const depths = new Float32Array(starCount).map((_, i) => shellDepth(distances[i]))
    const colors = new Float32Array(starCount * 3)

    for (let i = 0; i < starCount; i += 1) {
      const baseIndex = i * stride
      const positionIndex = i * 3
      const r = floatData[baseIndex + 3]
      const g = floatData[baseIndex + 4]
      const b = floatData[baseIndex + 5]
      const vmag = floatData[baseIndex + 6]

      const brightness = starBrightness(vmag)

      colors[positionIndex] = r * brightness
      colors[positionIndex + 1] = g * brightness
      colors[positionIndex + 2] = b * brightness
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(directions.slice(), 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.setAttribute('starDepth', new THREE.BufferAttribute(depths, 1))
    geom.computeBoundingSphere()

    return { geom }
  }, [buffer, distanceBuffer])

  useEffect(() => {
    return () => geometry.geom.dispose()
  }, [geometry])

  const uniforms = useMemo(
    () => ({
      uZenith: { value: new THREE.Vector3(0, 1, 0) },
      uExtinction: { value: fromSurface ? 1 : 0 },
      uDepth: { value: 0 },
    }),
    [fromSurface]
  )
  const onBeforeCompile = useMemo(
    () => (shader: THREE.WebGLProgramParametersWithUniforms) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'uniform vec3 uZenith;\nuniform float uExtinction;\nuniform float uDepth;\nattribute float starDepth;\nvoid main() {'
        )
        .replace('#include <begin_vertex>', shellVertex)
        .replace('#include <color_vertex>', extinctionVertex)
        .replace('gl_PointSize = size;', shellPointVertex)
    },
    [uniforms]
  )

  const stars = useRef<THREE.Points>(null)
  const shellCentre = useRef(new THREE.Vector3())
  useFrame(({ camera, controls }) => {
    if (stars.current) {
      orientStarfield(stars.current, useStore.getState().timestamp ?? Date.now())
    }
    const target = (controls as { target?: THREE.Vector3 } | null)?.target
    const distance = target ? camera.position.distanceTo(target) : 0
    const amount = depth && target ? depthAmount(distance) : 0
    fadeShell(stars.current, uniforms.uDepth, shellCentre.current, target, shellScale(radius, distance, amount), amount)
  })

  return (
    <points
      ref={stars}
      onBeforeRender={(_renderer, _scene, camera) => {
        if (!stars.current) return
        centreStarfieldOn(stars.current, camera, shellCentre.current, uniforms.uDepth.value)
        if (fromSurface) zenithOf(camera, uniforms.uZenith.value)
      }}
      frustumCulled={false}
      scale={radius}
    >
      <primitive
        attach="geometry"
        object={geometry.geom}
      />
      <pointsMaterial
        size={size}
        sizeAttenuation={false}
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={false}
        onBeforeCompile={onBeforeCompile}
      />
    </points>
  )
}
