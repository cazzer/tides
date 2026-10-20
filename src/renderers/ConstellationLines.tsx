import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// Stick figures of the 46 major constellations, from d3-celestial
// (Copyright (c) 2015, Olaf Frohn, BSD 3-Clause; built by
// scripts/convertConstellations.mjs, which keeps the notice in the JSON).
import constellations from '../assets/constellations.json'
import { DEFAULT_RADIUS, centreStarfieldOn, orientStarfield } from './Starfield'
import { useStore } from '../store'
import { constellationSegmentsEQJ } from '../constellations'

const LINE_COLOR = '#7f9cc4'
const LINE_OPACITY = 0.35

// Drawn on the starfield's sphere and turned with it, so the figures stay on
// their stars. Only the View from Earth panel mounts it.
export default function ConstellationLines({ radius = DEFAULT_RADIUS }: { radius?: number }) {
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(constellationSegmentsEQJ(constellations.figures), 3)
    )
    return geom
  }, [])

  useEffect(() => {
    return () => geometry.dispose()
  }, [geometry])

  const lines = useRef<THREE.LineSegments>(null)
  useFrame(() => {
    if (lines.current) {
      orientStarfield(lines.current, useStore.getState().timestamp ?? Date.now())
    }
  })

  return (
    <lineSegments
      ref={lines}
      onBeforeRender={(_renderer, _scene, camera) => {
        if (lines.current) centreStarfieldOn(lines.current, camera)
      }}
      frustumCulled={false}
      scale={[radius, radius, radius]}
    >
      <primitive
        attach="geometry"
        object={geometry}
      />
      <lineBasicMaterial
        color={LINE_COLOR}
        transparent
        opacity={LINE_OPACITY}
        depthWrite={false}
      />
    </lineSegments>
  )
}
