import { forwardRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { calculateLocationAndRotationForLatLng } from './utils'

const thumbtackUrl = new URL('./assets/Thumbtack.glb', import.meta.url).href

/** Layer for the location pin; only the main "Three Body System" camera enables it. */
export const PIN_LAYER = 2

interface LocationPinProps {
  lat: number
  lon: number
  diameter: number
  scale?: number
}

export const LocationPin = forwardRef<THREE.Group, LocationPinProps>(
  function LocationPin({ lat, lon, diameter, scale = 0.6 }, ref) {
    const { scene } = useGLTF(thumbtackUrl)

    const { clone, tipOffset } = useMemo(() => {
      const c = scene.clone()
      c.traverse((child) => child.layers.set(PIN_LAYER))
      c.updateWorldMatrix(true, true)
      const bbox = new THREE.Box3().setFromObject(c)
      const center = new THREE.Vector3()
      bbox.getCenter(center)
      c.position.sub(center)
      const tipOffset = center.y - bbox.min.y
      return { clone: c, tipOffset }
    }, [scene])

    useFrame(() => {
      if (!ref || typeof ref === 'function' || !ref.current) return
      const { position: pos } = calculateLocationAndRotationForLatLng(
        lat,
        lon,
        diameter
      )
      const dir = new THREE.Vector3(pos.x, pos.y, pos.z).normalize()
      ref.current.position
        .copy(dir)
        .multiplyScalar(tipOffset * scale * 0.75)
        .add(pos)
      ref.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      ;(
        ref.current as THREE.Object3D & { userData: { focus?: string } }
      ).userData.focus = 'location'
      ref.current.layers.set(PIN_LAYER)
    })

    return (
      <group
        ref={ref}
        scale={[scale, scale, scale]}
        layers={PIN_LAYER}
      >
        <primitive object={clone} />
      </group>
    )
  }
)
