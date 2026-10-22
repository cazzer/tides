// Planet orbit lines in the main view (tides-kzj.2.5), drawn beside Earth's
// month ring while the planets are on.
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  PLANETS,
  PLANET_KEYS,
  PLANET_ORBIT_SEGMENTS,
  orbitPathIsStale,
  planetOrbitPath,
  type PlanetKey,
} from './planets'
import { useStore } from './store'
import type { DistanceScale } from './distance-scale'

// Earth's orbit ring style (orbit-label.tsx).
const orbitMaterial = new THREE.LineBasicMaterial({
  color: '#BFBBDA',
  transparent: true,
  opacity: 0.2,
})

// Unset until SimClock's first frame, which starts from Date.now().
function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

export function PlanetOrbits(
  // Inert until tides-2hv.6 adds the 'flight' orbit paths.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _props: { distanceScale: DistanceScale }
) {
  return (
    <>
      {PLANET_KEYS.map((key) => (
        <PlanetOrbit
          key={key}
          planetKey={key}
        />
      ))}
    </>
  )
}

function PlanetOrbit({ planetKey }: { planetKey: PlanetKey }) {
  const { body, period } = PLANETS[planetKey]
  const [firstT] = useState(simTime)
  const pathT = useRef(firstT)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        planetOrbitPath(body, firstT, PLANET_ORBIT_SEGMENTS),
        3
      )
    )
    return g
  }, [body, firstT])

  useEffect(() => () => geometry.dispose(), [geometry])

  // Orbits drift slowly: redraw only once the clock has moved a share of
  // the period (or jumped, e.g. a scrub), straight into the same buffer.
  useFrame(() => {
    const t = simTime()
    if (!orbitPathIsStale(pathT.current, t, period)) return
    pathT.current = t
    const position = geometry.getAttribute('position') as THREE.BufferAttribute
    planetOrbitPath(
      body,
      t,
      PLANET_ORBIT_SEGMENTS,
      position.array as Float32Array
    )
    position.needsUpdate = true
    geometry.computeBoundingSphere()
  })

  return (
    <lineLoop
      geometry={geometry}
      material={orbitMaterial}
    />
  )
}
