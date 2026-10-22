// Planet orbit lines in the main view (tides-kzj.2.5), drawn beside Earth's
// month ring while the planets are on, and in ship mode at the flight scale
// with Earth's own orbit in place of the ring (tides-2hv.6). Both follow the
// orbits aid (systemAids.orbits, tides-2hv.9), as the moons' lines do; the
// system view's month ring is the calendar, so it stays.
import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import { Body, PlanetOrbitalPeriod } from 'astronomy-engine'
import {
  PLANETS,
  PLANET_KEYS,
  PLANET_ORBIT_SEGMENTS,
  orbitPathIsStale,
} from './planets'
import { useStore } from './store'
import type { DistanceScale } from './distance-scale'
import { positionsFor, type OrbitKey } from './flight-scale'

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

export const PlanetOrbits: FC<{ distanceScale: DistanceScale }> = ({
  distanceScale,
}) => {
  const orbits = useStore((s) => s.systemAids.orbits)
  if (!orbits) return null
  return (
    <>
      {PLANET_KEYS.map((key) => (
        <BodyOrbit
          key={key}
          orbitKey={key}
          period={PLANETS[key].period}
          distanceScale={distanceScale}
        />
      ))}
    </>
  )
}

/** Sidereal year, days. */
const EARTH_PERIOD = PlanetOrbitalPeriod(Body.Earth)

/**
 * Earth's true orbit, for ship mode: there Earth sits at its heliocentric
 * position (flight-scale.ts), which strays off the system view's circular
 * month ring by up to e·r (~17 units at 1000 per AU).
 */
export const EarthOrbit: FC<{ distanceScale: DistanceScale }> = ({
  distanceScale,
}) => {
  const orbits = useStore((s) => s.systemAids.orbits)
  if (!orbits) return null
  return (
    <BodyOrbit
      orbitKey="earth"
      period={EARTH_PERIOD}
      distanceScale={distanceScale}
    />
  )
}

function BodyOrbit({
  orbitKey,
  period,
  distanceScale,
}: {
  orbitKey: OrbitKey
  /** Sidereal period, days: how often the loop is redrawn. */
  period: number
  distanceScale: DistanceScale
}) {
  const { orbitPath } = positionsFor(distanceScale)
  const [firstT] = useState(simTime)
  const pathT = useRef(firstT)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        orbitPath(orbitKey, firstT, PLANET_ORBIT_SEGMENTS),
        3
      )
    )
    return g
  }, [orbitKey, firstT, orbitPath])

  useEffect(() => () => geometry.dispose(), [geometry])

  // Orbits drift slowly: redraw only once the clock has moved a share of
  // the period (or jumped, e.g. a scrub), straight into the same buffer.
  useFrame(() => {
    const t = simTime()
    if (!orbitPathIsStale(pathT.current, t, period)) return
    pathT.current = t
    const position = geometry.getAttribute('position') as THREE.BufferAttribute
    orbitPath(
      orbitKey,
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
