import * as THREE from 'three'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { useCamera } from './camera'
import { useStore } from './store'
import { earthAngle, monthStartAngles } from './ephemeris'

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Clear of the Sun (radius ~10) and its corona's bright inner glow; only the
// faint outer haze reaches this far. September at scale 3.5 is ~16.9 units
// long and the clock ~16.4, so both end by ~37.5, inside the Moon's band.
export const LABEL_INNER_RADIUS = 20
export const CLOCK_INNER_RADIUS = LABEL_INNER_RADIUS + 1
export const MONTH_SCALE = 3.5
// Solid grey reads like the old 25%-opaque white on black, but stays visible
// over the Sun, where translucent white blends into its bright surface.
const MONTH_COLOR = '#404040'
// Roughly half the clock text's width (~16.4 units at scale 2), so the camera
// centres on the text rather than its left-anchored inner end.
export const CLOCK_HALF_WIDTH = 8
const FADE_START = (6 * Math.PI) / 180
const FADE_END = (12 * Math.PI) / 180

// Depth-tested so the Sun, Earth and Moon hide labels behind them, but not
// depth-written so overlapping glyphs and later transparents still blend.
export const labelMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  transparent: true,
  depthWrite: false,
})

// Mercury and Venus orbit through the clock's band (planets.ts), so with
// planets on the clock is drawn over them rather than cut by their globes.
const clockOverPlanetsMaterial = labelMaterial.clone()
clockOverPlanetsMaterial.depthTest = false

type TroikaText = THREE.Mesh & {
  text: string
  fillOpacity: number
  sync(): void
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

function formatClockDate(date: Date): string {
  return `${weekdayFormat.format(date)}, ${dateFormat.format(date)}\n${timeFormat.format(date)}`
}

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Earth's orbit line, with the clock riding it and the month names around it
 * unless `calendar` is false (ship mode), which leaves just the line: no
 * 'clock' focus ref is registered and nothing is clickable.
 */
export function OrbitLabel({
  radius,
  calendar = true,
}: {
  radius: number
  calendar?: boolean
}) {
  const clockRef = useRef<THREE.Object3D>(null)
  const clockTextRef = useRef<TroikaText>(null)
  const monthRefs = useRef<(TroikaText | null)[]>([])
  const { handleFocus } = useCamera()
  const setPlanet = useStore((s) => s.setPlanet)
  const showPlanets = useStore((s) => s.showPlanets)

  useEffect(() => {
    if (calendar) setPlanet('clock', clockRef)
  }, [setPlanet, calendar])

  const lineGeometry = useMemo(() => {
    const eclipsePoints = []
    for (let index = 0; index < 256; index++) {
      const angle = (index / 256) * 2 * Math.PI
      const x = radius * Math.cos(angle)
      const z = radius * Math.sin(angle)
      eclipsePoints.push(new THREE.Vector3(x, 0, z))
    }
    eclipsePoints.push(eclipsePoints[0])
    return new THREE.BufferGeometry().setFromPoints(eclipsePoints)
  }, [radius])

  useEffect(() => () => lineGeometry.dispose(), [lineGeometry])

  const [year, setYear] = useState(() =>
    new Date(useStore.getState().timestamp ?? Date.now()).getFullYear()
  )
  const angles = useMemo(() => monthStartAngles(year), [year])
  const lastSecond = useRef<number | null>(null)

  useFrame(() => {
    if (!calendar) return
    // Unset until SimClock's first frame, which starts from Date.now().
    const timestamp = useStore.getState().timestamp ?? Date.now()
    const angle = earthAngle(timestamp)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const clockCentre = CLOCK_INNER_RADIUS + CLOCK_HALF_WIDTH

    clockRef.current?.position.set(clockCentre * cos, 0.5, -clockCentre * sin)

    for (let m = 0; m < MONTHS.length; m++) {
      const month = monthRefs.current[m]
      if (month) {
        month.fillOpacity = smoothstep(
          Math.abs(wrapToPi(angles[m] - angle)),
          FADE_START,
          FADE_END
        )
      }
    }

    const clock = clockTextRef.current
    if (!clock) return
    clock.position.set(
      CLOCK_INNER_RADIUS * cos,
      0.5,
      -CLOCK_INNER_RADIUS * sin
    )
    clock.rotation.set(-Math.PI / 2, 0, angle)

    const second = Math.floor(timestamp / 1000)
    if (second !== lastSecond.current) {
      lastSecond.current = second
      const date = new Date(timestamp)
      clock.text = formatClockDate(date)
      // troika auto-syncs only in onBeforeRender, which culled meshes skip.
      clock.sync()
      const currentYear = date.getFullYear()
      if (currentYear !== year) setYear(currentYear)
    }
  })

  return (
    <group>
      {/* @ts-ignore */}
      <line geometry={lineGeometry}>
        <lineBasicMaterial
          attach="material"
          color="#BFBBDA"
          linewidth={10}
          transparent
          opacity={0.2}
        />
      </line>
      {calendar && (
        <>
          <object3D
            ref={clockRef}
            userData-focus="clock"
          />
          <Text
            ref={clockTextRef}
            userData-focus="clock"
            onClick={handleFocus}
            material={showPlanets ? clockOverPlanetsMaterial : labelMaterial}
            renderOrder={showPlanets ? 3 : 0}
            scale={[2, 2, 2]}
            color="white" // default
            // Thin white strokes wash out over the Sun without a dark edge.
            outlineWidth="6%"
            outlineColor="black"
            anchorX="left"
            anchorY="middle" // default
            textAlign="left"
          >
            {''}
          </Text>

          {MONTHS.map((month, m) => (
            <Text
              key={month}
              ref={(text: TroikaText | null) => {
                monthRefs.current[m] = text
              }}
              material={labelMaterial}
              scale={[MONTH_SCALE, MONTH_SCALE, MONTH_SCALE]}
              color={MONTH_COLOR}
              anchorX="left"
              anchorY="middle" // default
              position={[
                LABEL_INNER_RADIUS * Math.cos(angles[m]),
                0,
                -LABEL_INNER_RADIUS * Math.sin(angles[m]),
              ]}
              rotation={[-Math.PI / 2, 0, angles[m]]}
            >
              {month}
            </Text>
          ))}
        </>
      )}
    </group>
  )
}
