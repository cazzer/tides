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
import { earthAngle, monthStartAngles, type Vec3 } from './ephemeris'
import {
  chooseLabelSide,
  emptyRect,
  emptyStrip,
  labelRect,
  rectAsStrip,
  type LabelSide,
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
// system without crowding the clock up close. Each sits on a side of its
// planet clear of the month and clock labels and of the labels placed
// before it.
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
  const rootRef = useRef<THREE.Group>(null)
  const [layout] = useState(() => new PlanetLabelLayout())

  // One pass over all the labels, so each can keep clear of those before it.
  useFrame(({ camera, size }) => {
    if (rootRef.current) layout.update(rootRef.current, camera, size)
  })

  return (
    <group ref={rootRef}>
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
            layout={layout}
          />
        ))}
      </Suspense>
    </group>
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

function PlanetLabel({
  planetKey,
  layout,
}: {
  planetKey: PlanetKey
  layout: PlanetLabelLayout
}) {
  const billboardRef = useRef<THREE.Group>(null)
  const textRef = useRef<TroikaText>(null)
  const { handleFocus } = useCamera()

  useEffect(
    () => layout.attach(planetKey, billboardRef, textRef),
    [layout, planetKey]
  )

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
        {PLANETS[planetKey].name}
      </Text>
    </Billboard>
  )
}

interface LabelSlot {
  key: PlanetKey
  name: string
  /** World units from the planet's centre to clear: globe or rings. */
  extent: number
  positionAt: (t: number) => Vec3
  billboard: RefObject<THREE.Group | null> | null
  text: RefObject<TroikaText | null> | null
  side: LabelSide
  lastT: number | null
}

// The month names and clock as flat strips in the ecliptic (orbit-label.tsx):
// radial from their inner radius, about one em thick. Glyphs average ~0.54 em
// wide (September is ~16.9 units at scale 3.5).
const MONTH_HALF_THICKNESS = MONTH_SCALE / 2
const MONTH_OUTER = MONTHS.map(
  (month) => LABEL_INNER_RADIUS + month.length * 0.54 * MONTH_SCALE
)
const CLOCK_OUTER = CLOCK_INNER_RADIUS + 2 * CLOCK_HALF_WIDTH
// Two lines at scale 2.
const CLOCK_HALF_THICKNESS = 2.4
// The Sun's globe would cut through a depth-tested label beside Mercury.
const SUN_RADIUS = sceneRadius(1392700000)

const OBSTACLE_COUNT = MONTHS.length + 2 + PLANET_KEYS.length

interface ScreenPoint {
  x: number
  y: number
}

/**
 * Writes `world`'s screen position (pixels from the view's centre, y up)
 * into `out`. Projects `world` in place.
 */
function toScreen(
  world: THREE.Vector3,
  camera: THREE.Camera,
  size: { width: number; height: number },
  out: ScreenPoint
): ScreenPoint {
  world.project(camera)
  out.x = (world.x * size.width) / 2
  out.y = (world.y * size.height) / 2
  return out
}

/**
 * Places the planet labels each frame, inner planets first, each clear of
 * the month names, the clock, the Sun and the labels already placed. Every
 * object it works with is allocated here, once.
 */
class PlanetLabelLayout {
  private readonly slots: readonly LabelSlot[] = PLANET_KEYS.map((key) => {
    const { body, name, radius, rings } = PLANETS[key]
    return {
      key,
      name,
      extent: radius * (rings?.outer ?? 1),
      positionAt: planetPosition(body),
      billboard: null,
      text: null,
      side: 'right',
      lastT: null,
    }
  })

  private readonly obstacles: Strip[] = Array.from(
    { length: OBSTACLE_COUNT },
    emptyStrip
  )
  private readonly rect = emptyRect()
  private readonly world = new THREE.Vector3()
  private readonly start: ScreenPoint = { x: 0, y: 0 }
  private readonly end: ScreenPoint = { x: 0, y: 0 }
  private readonly centre: ScreenPoint = { x: 0, y: 0 }
  private readonly monthAngles: number[] = []
  // Sim times [yearStart, yearEnd) that monthAngles is good for.
  private yearStart = Infinity
  private yearEnd = -Infinity
  private clockT: number | null = null
  private clockAngle = 0

  /** Lays out a mounted label until the returned cleanup runs. */
  attach(
    key: PlanetKey,
    billboard: RefObject<THREE.Group | null>,
    text: RefObject<TroikaText | null>
  ): () => void {
    const slot = this.slots[PLANET_KEYS.indexOf(key)]
    slot.billboard = billboard
    slot.text = text
    slot.lastT = null
    return () => {
      slot.billboard = null
      slot.text = null
    }
  }

  update(
    root: THREE.Object3D,
    camera: THREE.Camera,
    size: { width: number; height: number }
  ): void {
    const ortho = camera as THREE.OrthographicCamera
    if (!ortho.isOrthographicCamera) return
    const pxPerUnit = (ortho.zoom * size.height) / (ortho.top - ortho.bottom)
    const t = simTime()
    const { obstacles } = this
    let n = 0

    if (t < this.yearStart || t >= this.yearEnd) {
      const year = new Date(t).getFullYear()
      this.yearStart = new Date(year, 0, 1).getTime()
      this.yearEnd = new Date(year + 1, 0, 1).getTime()
      const angles = monthStartAngles(year)
      for (let m = 0; m < angles.length; m++) this.monthAngles[m] = angles[m]
    }
    for (let m = 0; m < MONTHS.length; m++) {
      this.radialStrip(
        root,
        camera,
        size,
        this.monthAngles[m],
        LABEL_INNER_RADIUS,
        MONTH_OUTER[m],
        MONTH_HALF_THICKNESS * pxPerUnit + LABEL_MARGIN_PX,
        obstacles[n++]
      )
    }
    if (t !== this.clockT) {
      this.clockT = t
      this.clockAngle = earthAngle(t)
    }
    this.radialStrip(
      root,
      camera,
      size,
      this.clockAngle,
      CLOCK_INNER_RADIUS,
      CLOCK_OUTER,
      CLOCK_HALF_THICKNESS * pxPerUnit + LABEL_MARGIN_PX,
      obstacles[n++]
    )
    this.radialStrip(
      root,
      camera,
      size,
      0,
      0,
      0,
      SUN_RADIUS * pxPerUnit + LABEL_MARGIN_PX,
      obstacles[n++]
    )

    // One label unit per screen pixel.
    const unitsPerPx = 1 / pxPerUnit
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]
      const billboard = slot.billboard?.current
      const text = slot.text?.current
      if (!billboard || !text) continue

      if (t !== slot.lastT) {
        slot.lastT = t
        const p = slot.positionAt(t)
        billboard.position.set(p[0], p[1], p[2])
      }
      billboard.scale.setScalar(unitsPerPx)

      const bounds = text.textRenderInfo?.blockBounds
      const width = bounds
        ? bounds[2] - bounds[0]
        : slot.name.length * 0.55 * LABEL_PX
      const height = bounds ? bounds[3] - bounds[1] : 1.2 * LABEL_PX
      const clearance = slot.extent * pxPerUnit + LABEL_GAP_PX
      const centre = toScreen(
        billboard.getWorldPosition(this.world),
        camera,
        size,
        this.centre
      )
      slot.side = chooseLabelSide(
        slot.side,
        centre.x,
        centre.y,
        clearance,
        width,
        height,
        obstacles,
        n
      )

      // The text is anchored at its left-middle point.
      const local = labelRect(slot.side, 0, 0, clearance, width, height, this.rect)
      text.position.set(local.x0, (local.y0 + local.y1) / 2, 0)

      // Later (outer) planets' labels keep clear of this one.
      labelRect(slot.side, centre.x, centre.y, clearance, width, height, this.rect)
      rectAsStrip(this.rect, LABEL_MARGIN_PX, obstacles[n++])
    }
  }

  // A strip along `angle` in the ecliptic, from radius `inner` to `outer`
  // around the root's origin (the Sun), in screen pixels.
  private radialStrip(
    root: THREE.Object3D,
    camera: THREE.Camera,
    size: { width: number; height: number },
    angle: number,
    inner: number,
    outer: number,
    r: number,
    out: Strip
  ): void {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const start = toScreen(
      root.localToWorld(this.world.set(inner * cos, 0, -inner * sin)),
      camera,
      size,
      this.start
    )
    const end = toScreen(
      root.localToWorld(this.world.set(outer * cos, 0, -outer * sin)),
      camera,
      size,
      this.end
    )
    out.ax = start.x
    out.ay = start.y
    out.bx = end.x
    out.by = end.y
    out.r = r
  }
}
