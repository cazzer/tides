// Planet orbit lines and name labels in the main view (tides-kzj.2.5), drawn
// beside Earth's month ring while the planets are on.
import * as THREE from 'three'
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import { useCamera } from './camera'
import { earthAngle, monthStartAngles } from './ephemeris'
import {
  chooseLabelSide,
  labelRect,
  type Strip,
} from './label-placement'
import {
  CLOCK_HALF_WIDTH,
  CLOCK_INNER_RADIUS,
  LABEL_INNER_RADIUS,
  MONTHS,
  MONTH_SCALE,
  labelMaterial,
} from './orbit-label'
import {
  PLANETS,
  PLANET_KEYS,
  PLANET_ORBIT_SEGMENTS,
  orbitPathIsStale,
  planetOrbitPath,
  planetPosition,
  sceneRadius,
  type PlanetKey,
} from './planets'
import { useStore } from './store'

// Earth's orbit ring style (orbit-label.tsx).
const orbitMaterial = new THREE.LineBasicMaterial({
  color: '#BFBBDA',
  transparent: true,
  opacity: 0.2,
})

// Labels keep one on-screen size at every zoom, small next to the month
// names (35 px at the default zoom), so they read zoomed out to the whole
// system without crowding the clock up close. Each sits on whichever side
// of its planet is clear of the month and clock labels.
const LABEL_PX = 13
const LABEL_GAP_PX = 6
// Breathing room kept between a planet label and the labels it avoids.
const LABEL_MARGIN_PX = 6
const LABEL_COLOR = '#9C98B8'

type TroikaText = THREE.Mesh & {
  textRenderInfo?: { blockBounds: [number, number, number, number] }
}

// Unset until SimClock's first frame, which starts from Date.now().
function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

export function PlanetOrbits() {
  const strips = useOrbitLabelStrips()
  return (
    <>
      {PLANET_KEYS.map((key) => (
        <PlanetOrbit
          key={key}
          planetKey={key}
        />
      ))}
      {/* Text suspends on its font; the lines must not wait for it. */}
      <Suspense fallback={null}>
        {PLANET_KEYS.map((key) => (
          <PlanetLabel
            key={key}
            planetKey={key}
            strips={strips}
          />
        ))}
      </Suspense>
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
  // the period (or jumped, e.g. a scrub), into the same buffer.
  useFrame(() => {
    const t = simTime()
    if (!orbitPathIsStale(pathT.current, t, period)) return
    pathT.current = t
    const position = geometry.getAttribute('position') as THREE.BufferAttribute
    position.copyArray(planetOrbitPath(body, t, PLANET_ORBIT_SEGMENTS))
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

function PlanetLabel({
  planetKey,
  strips,
}: {
  planetKey: PlanetKey
  strips: RefObject<Strip[]>
}) {
  const { body, name, radius, rings } = PLANETS[planetKey]
  // Clear of Saturn's and Uranus' rings as well as the globe.
  const extent = radius * (rings?.outer ?? 1)
  const positionAt = useMemo(() => planetPosition(body), [body])
  const billboardRef = useRef<THREE.Group>(null)
  const textRef = useRef<TroikaText>(null)
  const lastT = useRef<number | null>(null)
  const { handleFocus } = useCamera()

  useFrame(({ camera, size }) => {
    const billboard = billboardRef.current
    const text = textRef.current
    if (!billboard || !text) return

    const t = simTime()
    if (t !== lastT.current) {
      lastT.current = t
      billboard.position.set(...positionAt(t))
    }

    // One label unit per screen pixel.
    const ortho = camera as THREE.OrthographicCamera
    if (!ortho.isOrthographicCamera) return
    const unitsPerPx = (ortho.top - ortho.bottom) / (ortho.zoom * size.height)
    billboard.scale.setScalar(unitsPerPx)

    const bounds = text.textRenderInfo?.blockBounds
    const width = bounds ? bounds[2] - bounds[0] : name.length * 0.55 * LABEL_PX
    const height = bounds ? bounds[3] - bounds[1] : 1.2 * LABEL_PX
    const clearance = extent / unitsPerPx + LABEL_GAP_PX
    const centre = toScreen(billboard.position, camera, size)
    const side = chooseLabelSide(
      centre.x,
      centre.y,
      clearance,
      width,
      height,
      strips.current
    )
    // The text is anchored at its left-middle point.
    const rect = labelRect(side, 0, 0, clearance, width, height)
    text.position.set(rect.x0, (rect.y0 + rect.y1) / 2, 0)
  })

  return (
    <Billboard ref={billboardRef}>
      <Text
        ref={textRef}
        userData-focus={planetKey}
        onClick={handleFocus}
        material={labelMaterial}
        fontSize={LABEL_PX}
        color={LABEL_COLOR}
        outlineWidth="8%"
        outlineColor="black"
        anchorX="left"
        anchorY="middle"
      >
        {name}
      </Text>
    </Billboard>
  )
}

const projected = new THREE.Vector3()

/** Screen pixels from the view's centre, y up. */
function toScreen(
  world: THREE.Vector3,
  camera: THREE.Camera,
  size: { width: number; height: number }
): { x: number; y: number } {
  projected.copy(world).project(camera)
  return {
    x: (projected.x * size.width) / 2,
    y: (projected.y * size.height) / 2,
  }
}

// The month names and clock as flat strips in the ecliptic (orbit-label.tsx):
// radial from their inner radius, about one em thick. Glyphs average ~0.54 em
// wide (September is ~16.9 units at scale 3.5).
const MONTH_HALF_THICKNESS = MONTH_SCALE / 2
const MONTH_EM_PER_CHAR = 0.54
// Two lines at scale 2.
const CLOCK_HALF_THICKNESS = 2.4
interface RadialStrip {
  angle: number
  inner: number
  outer: number
  halfThickness: number
}

// The Sun's globe would cut through a depth-tested label beside Mercury.
const SUN_STRIP: RadialStrip = {
  angle: 0,
  inner: 0,
  outer: 0,
  halfThickness: sceneRadius(1392700000),
}

const stripEnd = new THREE.Vector3()

function radialPoint(angle: number, r: number): THREE.Vector3 {
  return stripEnd.set(r * Math.cos(angle), 0, -r * Math.sin(angle))
}

/**
 * The month and clock labels' screen strips, and the Sun's disc, refreshed
 * every frame for the planet labels to keep clear of (read a frame late,
 * which is invisible).
 */
function useOrbitLabelStrips(): RefObject<Strip[]> {
  const strips = useRef<Strip[]>([])
  const months = useRef<{ year: number; strips: RadialStrip[] } | null>(null)

  useFrame(({ camera, size }) => {
    const ortho = camera as THREE.OrthographicCamera
    if (!ortho.isOrthographicCamera) return
    const t = simTime()
    const year = new Date(t).getFullYear()
    if (months.current?.year !== year) {
      const angles = monthStartAngles(year)
      months.current = {
        year,
        strips: MONTHS.map((month, m) => ({
          angle: angles[m],
          inner: LABEL_INNER_RADIUS,
          outer:
            LABEL_INNER_RADIUS + month.length * MONTH_EM_PER_CHAR * MONTH_SCALE,
          halfThickness: MONTH_HALF_THICKNESS,
        })),
      }
    }
    const clock: RadialStrip = {
      angle: earthAngle(t),
      inner: CLOCK_INNER_RADIUS,
      outer: CLOCK_INNER_RADIUS + 2 * CLOCK_HALF_WIDTH,
      halfThickness: CLOCK_HALF_THICKNESS,
    }
    const pxPerUnit = (ortho.zoom * size.height) / (ortho.top - ortho.bottom)
    strips.current = [...months.current.strips, clock, SUN_STRIP].map((s) => {
      const start = toScreen(radialPoint(s.angle, s.inner), camera, size)
      const end = toScreen(radialPoint(s.angle, s.outer), camera, size)
      return {
        ax: start.x,
        ay: start.y,
        bx: end.x,
        by: end.y,
        r: s.halfThickness * pxPerUnit + LABEL_MARGIN_PX,
      }
    })
  })

  return strips
}
