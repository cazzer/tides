import { useEffect, useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'

import starsBinUrl from '../assets/stars.bin?url'
import starsMeta from '../assets/stars.meta.json'

type StarfieldProps = {
  radius?: number
  size?: number
  opacity?: number
}

const DEFAULT_RADIUS = 200
const DEFAULT_SIZE = 1.2

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

    const positions = new Float32Array(starCount * 3)
    const colors = new Float32Array(starCount * 3)

    for (let i = 0; i < starCount; i += 1) {
      const baseIndex = i * stride
      const positionIndex = i * 3
      const x = floatData[baseIndex]
      const y = floatData[baseIndex + 1]
      const z = floatData[baseIndex + 2]
      const r = floatData[baseIndex + 3]
      const g = floatData[baseIndex + 4]
      const b = floatData[baseIndex + 5]
      const vmag = floatData[baseIndex + 6]

      const brightness = THREE.MathUtils.clamp(1 - (vmag + 1.5) / 8, 0.1, 1)

      positions[positionIndex] = x
      positions[positionIndex + 1] = y
      positions[positionIndex + 2] = z

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

  return (
    <points
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
