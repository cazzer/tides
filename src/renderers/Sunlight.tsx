import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { aimSunlight, createSunlight } from '../sunlight'
import { useStore } from '../store'

export default function Sunlight() {
  const light = useMemo(createSunlight, [])

  useEffect(() => () => light.dispose(), [light])

  useFrame(() => {
    const { timestamp } = useStore.getState()
    if (typeof timestamp === 'number') aimSunlight(light, timestamp)
  })

  return (
    <>
      <primitive object={light} />
      {/* The target must be in the scene for its world matrix to update. */}
      <primitive object={light.target} />
    </>
  )
}
