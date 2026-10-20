// The twelve tropical signs on a band outside Earth's orbit, each spanning
// the 30° of Earth's angle (the Sun's longitude) it is named for (tides-28u).
import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import {
  SIGN_ANGLE,
  ZODIAC_INNER,
  ZODIAC_SCALE,
  ZODIAC_SIGNS,
  ZODIAC_TEXT_RADIUS,
  ZODIAC_TICK_OUTER,
  zodiacSignIndex,
} from './calendar-rings'
import { earthAngle } from './ephemeris'
import { labelMaterial } from './orbit-label'
import { useStore } from './store'

const ARC_SEGMENTS = 256
// The month names' grey; the planet labels' lilac marks the Sun's sign.
const SIGN_COLOR = '#404040'
const CURRENT_SIGN_COLOR = '#9C98B8'

// Mars orbits through the names' outer half (planets.ts: 69.3–89.7), so with
// planets on they are drawn over it, as the clock is over Mercury and Venus.
const signOverPlanetsMaterial = labelMaterial.clone()
signOverPlanetsMaterial.depthTest = false

type TroikaText = THREE.Mesh & { color: THREE.ColorRepresentation }

// Earth's orbit ring style (orbit-label.tsx), a little fainter.
const lineMaterial = new THREE.LineBasicMaterial({
  color: '#BFBBDA',
  transparent: true,
  opacity: 0.15,
})

function ringPoint(radius: number, angle: number): THREE.Vector3 {
  return new THREE.Vector3(
    radius * Math.cos(angle),
    0,
    -radius * Math.sin(angle)
  )
}

// Unset until SimClock's first frame, which starts from Date.now().
function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

export function ZodiacRing() {
  const signRefs = useRef<(TroikaText | null)[]>([])
  const currentSign = useRef<number | null>(null)
  const showPlanets = useStore((s) => s.showPlanets)

  const arcGeometry = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: ARC_SEGMENTS }, (_, i) =>
          ringPoint(ZODIAC_INNER, (i / ARC_SEGMENTS) * 2 * Math.PI)
        )
      ),
    []
  )
  const tickGeometry = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints(
        ZODIAC_SIGNS.flatMap((_, k) => [
          ringPoint(ZODIAC_INNER, k * SIGN_ANGLE),
          ringPoint(ZODIAC_TICK_OUTER, k * SIGN_ANGLE),
        ])
      ),
    []
  )
  useEffect(
    () => () => {
      arcGeometry.dispose()
      tickGeometry.dispose()
    },
    [arcGeometry, tickGeometry]
  )

  useFrame(() => {
    const sign = zodiacSignIndex(earthAngle(simTime()))
    if (sign === currentSign.current) return
    currentSign.current = sign
    signRefs.current.forEach((text, k) => {
      if (text) text.color = k === sign ? CURRENT_SIGN_COLOR : SIGN_COLOR
    })
  })

  return (
    <group>
      <lineLoop
        geometry={arcGeometry}
        material={lineMaterial}
      />
      <lineSegments
        geometry={tickGeometry}
        material={lineMaterial}
      />
      {ZODIAC_SIGNS.map((sign, k) => {
        const mid = (k + 0.5) * SIGN_ANGLE
        return (
          <Text
            key={sign}
            ref={(text: TroikaText | null) => {
              signRefs.current[k] = text
              // A remount (e.g. the planets toggle) recolours on the next frame.
              currentSign.current = null
            }}
            material={showPlanets ? signOverPlanetsMaterial : labelMaterial}
            renderOrder={showPlanets ? 3 : 0}
            scale={[ZODIAC_SCALE, ZODIAC_SCALE, ZODIAC_SCALE]}
            color={SIGN_COLOR}
            anchorX="left"
            anchorY="middle" // default
            position={ringPoint(ZODIAC_TEXT_RADIUS, mid)}
            rotation={[-Math.PI / 2, 0, mid]}
          >
            {sign}
          </Text>
        )
      })}
    </group>
  )
}
