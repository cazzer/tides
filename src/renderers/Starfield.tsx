import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import { MakeTime, RotateVector, Rotation_EQJ_ECT, Vector } from 'astronomy-engine'

import starsBinUrl from '../assets/stars.bin?url'
import starsMeta from '../assets/stars.meta.json'
import { eclipticToScene } from '../ephemeris'
import { useStore } from '../store'

type StarfieldProps = {
  radius?: number
  size?: number
  opacity?: number
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
// parallax put them up to ~2.9° off as seen from the Earth.
export function centreStarfieldOn(stars: THREE.Object3D, camera: THREE.Object3D) {
  camera.getWorldPosition(cameraPosition)
  stars.position.copy(stars.parent ? stars.parent.worldToLocal(cameraPosition) : cameraPosition)
  stars.updateMatrixWorld()
}

export default function Starfield({
  radius = DEFAULT_RADIUS,
  size = DEFAULT_SIZE,
  opacity = 1,
}: StarfieldProps) {
  const buffer = useLoader(THREE.FileLoader, starsBinUrl, (loader) => {
    loader.setResponseType('arraybuffer')
  }) as ArrayBuffer

  const geometry = useMemo(() => {
    const floatData = new Float32Array(buffer)
    const stride = starsMeta.stride ?? 7
    const starCount = Math.floor(floatData.length / stride)

    const positions = starDirectionsEQJ(floatData, stride)
    const colors = new Float32Array(starCount * 3)

    for (let i = 0; i < starCount; i += 1) {
      const baseIndex = i * stride
      const positionIndex = i * 3
      const r = floatData[baseIndex + 3]
      const g = floatData[baseIndex + 4]
      const b = floatData[baseIndex + 5]
      const vmag = floatData[baseIndex + 6]

      const brightness = THREE.MathUtils.clamp(1 - (vmag + 1.5) / 8, 0.1, 1)

      colors[positionIndex] = r * brightness
      colors[positionIndex + 1] = g * brightness
      colors[positionIndex + 2] = b * brightness
    }

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.computeBoundingSphere()

    return geom
  }, [buffer])

  useEffect(() => {
    return () => geometry.dispose()
  }, [geometry])

  const stars = useRef<THREE.Points>(null)
  useFrame(() => {
    if (stars.current) {
      orientStarfield(stars.current, useStore.getState().timestamp ?? Date.now())
    }
  })

  return (
    <points
      ref={stars}
      onBeforeRender={(_renderer, _scene, camera) =>
        stars.current && centreStarfieldOn(stars.current, camera)
      }
      frustumCulled={false}
      scale={[radius, radius, radius]}
    >
      <primitive
        attach="geometry"
        object={geometry}
      />
      <pointsMaterial
        size={size}
        sizeAttenuation={false}
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={false}
      />
    </points>
  )
}
