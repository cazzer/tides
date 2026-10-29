// The seasons demo's orbit aid (tides-zec.11), main view only: what shows the
// axis holding its direction in space while Earth goes round the Sun. It draws
//   - Earth's axis, bold: a fixed width on screen, its north end arrowed,
//     1.6 Earth radii each way close in and 2.6 in the wide view between
//     stops (where Earth is ~21 CSS px in radius on a desktop, ~10 on a
//     phone), with a simple half-lit stand-in globe over Earth once that
//     would be clearly larger than the globe as drawn (zoomed out further);
//   - a faint pale dot with its axis where Earth was at each stop reached;
//   - the orbit's nearest and farthest points, labelled with the distance.
// In world space, not under Earth's OrbitingBody: the ghosts sit where Earth
// was, and every axis points along Earth's north (northAxis), which the spin
// leaves be. All but Earth's axis fade out as the eye closes on the globe
// (wideFade). Sizes, fades and where labels go are seasons.ts. Laid out in
// the view's live size (useViewSize), not r3f's, which lags a layout change.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import { earthTilt, type Vec3 } from '../ephemeris'
import { useStore } from '../store'
import { worldUnitsPerPixel } from '../system-aids/pixel-scale'
import { findDemo } from './demos'
import { AID_RENDER_ORDER } from './SeasonsGlobe'
import type { ViewSize } from '../main-view'
import { PHONE_VIEW_PX } from '../system-aids/label-style'
import { useViewSize } from '../use-view-size'
import {
  SEASONS_APSIDES,
  apsisLabel,
  ghostDates,
  labelSide,
  markerRadius,
  northAxis,
  standInFade,
  wideFade,
  type LabelSideInput,
  type ScreenCircle,
} from './seasons'

// CSS px on screen. [TUNE]
const AXIS_WIDTH_PX = 2.5
const ARROW_RADIUS_PX = 5
const ARROW_LENGTH_PX = 11
const GHOST_PX = 4 // the ghost globe's radius
const GHOST_AXIS_PX = 22 // its axis's reach each way
const DOT_PX = 3
const LABEL_PX = { desktop: 12, phone: 11 }
const LABEL_GAP_PX = 6
// Kept clear round Earth and the Sun by the labels, past their discs.
const OBSTACLE_PAD_PX = 4
/** Earth's axis's reach each way, × its radius: close in, then wide. [TUNE] */
const AXIS_REACH_CLOSE = 1.6
const AXIS_REACH_WIDE = 2.6
const GHOST_OPACITY = 0.4 // [TUNE]
const DOT_COLOR = '#AEB4C8'
const DOT_OPACITY = 0.85
const LABEL_COLOR = '#AEB4C8'
const LABEL_OPACITY = 0.8
// One for every stop of a tour; past it, the earliest are kept.
const MAX_GHOSTS = 8
// Below this a part is all but gone: hidden, so its globe writes no depth.
const SHOWN = 0.004

type TroikaText = THREE.Mesh & {
  fillOpacity: number
  outlineOpacity: number
  /** [minX, minY, maxX, maxY] at font size 1, once troika has laid it out. */
  textRenderInfo?: { blockBounds: readonly number[] }
}

function noRaycast() {}

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

// Lit on the side toward the Sun (sunDir, world space), with a soft
// terminator. The globes write depth, so the axis hides inside them.
const GLOBE_VERTEX = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const GLOBE_FRAGMENT = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 day;
uniform vec3 night;
uniform float opacity;
varying vec3 vNormal;
void main() {
  float lit = smoothstep(-0.12, 0.22, dot(normalize(vNormal), sunDir));
  gl_FragColor = vec4(mix(night, day, lit), opacity);
}`

// Earth's stand-in is a blue globe; a ghost, a pale dot, so it can't be
// taken for another planet.
const EARTH_COLORS = { day: [0.33, 0.6, 0.95], night: [0.06, 0.09, 0.16] } as const
const GHOST_COLORS = { day: [0.95, 0.95, 0.95], night: [0.2, 0.2, 0.22] } as const

interface MarkerMaterials {
  globe: THREE.ShaderMaterial
  axis: THREE.MeshBasicMaterial
}

function createMarkerMaterials(colors: typeof EARTH_COLORS | typeof GHOST_COLORS): MarkerMaterials {
  return {
    globe: new THREE.ShaderMaterial({
      uniforms: {
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        day: { value: new THREE.Vector3(...colors.day) },
        night: { value: new THREE.Vector3(...colors.night) },
        opacity: { value: 1 },
      },
      vertexShader: GLOBE_VERTEX,
      fragmentShader: GLOBE_FRAGMENT,
      transparent: true,
    }),
    axis: new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, toneMapped: false, depthWrite: false }),
  }
}

function createGeometries() {
  const arrow = new THREE.ConeGeometry(1, 1, 16)
  arrow.translate(0, 0.5, 0) // its base on the axis's end
  return {
    globe: new THREE.SphereGeometry(1, 32, 16),
    axis: new THREE.CylinderGeometry(1, 1, 1, 12, 1, true),
    arrow,
  }
}

// Module level, so the meshes behind the refs are moved outside the hook.
const eye = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const earthAt = new THREE.Vector3()
const offset = new THREE.Vector3()
const sunAt = new THREE.Vector3()
const earthDisc: ScreenCircle = { x: 0, y: 0, r: 0 }
const sunDisc: ScreenCircle = { x: 0, y: 0, r: 0 }
const obstacles: readonly ScreenCircle[] = [earthDisc, sunDisc]
const labelAt = { x: 0, y: 0 }
const sideInput: LabelSideInput = {
  dotX: 0,
  dotY: 0,
  outX: 0,
  outY: 0,
  halfW: 0,
  halfH: 0,
  clearPx: DOT_PX + LABEL_GAP_PX,
  viewW: 0,
  viewH: 0,
  obstacles,
}

// `point` on screen, px from the view's centre (y up), into `circle`, with
// a radius of `radius` scene units there.
function toScreen(point: THREE.Vector3, upp: number, radius: number, circle: ScreenCircle) {
  offset.subVectors(point, eye)
  circle.x = offset.dot(right) / upp
  circle.y = offset.dot(up) / upp
  circle.r = radius / upp + OBSTACLE_PAD_PX
}

// A stand-in at `position`, sized by the scene units a CSS px spans there
// (`upp`): its globe `globeRadius` across and `globeOpacity`, its axis
// reaching `reach` each way at `axisOpacity`. The group's children are the
// globe, the axis and its arrow, in the order Marker renders them.
function placeMarker(
  group: THREE.Object3D,
  materials: MarkerMaterials,
  position: THREE.Vector3,
  upp: number,
  globeRadius: number,
  reach: number,
  globeOpacity: number,
  axisOpacity: number
) {
  group.visible = axisOpacity > SHOWN
  if (!group.visible) return
  group.position.copy(position)
  const [globe, axis, arrow] = group.children
  globe.visible = globeOpacity > SHOWN
  globe.scale.setScalar(globeRadius)
  materials.globe.uniforms.opacity.value = globeOpacity
  // The Sun is at the origin.
  ;(materials.globe.uniforms.sunDir.value as THREE.Vector3).copy(position).negate().normalize()
  const width = (AXIS_WIDTH_PX / 2) * upp
  axis.scale.set(width, 2 * reach, width)
  arrow.position.y = reach
  arrow.scale.set(ARROW_RADIUS_PX * upp, ARROW_LENGTH_PX * upp, ARROW_RADIUS_PX * upp)
  materials.axis.opacity = axisOpacity
}

interface Placed {
  root: THREE.Group | null
  current: THREE.Group | null
  ghosts: (THREE.Group | null)[]
  dots: (THREE.Mesh | null)[]
  labels: (THREE.Group | null)[]
  texts: (TroikaText | null)[]
}

interface Bodies {
  positionAt: (t: number) => Vec3
  radius: number
  sunRadius: number
}

function place(
  placed: Placed,
  camera: THREE.Camera,
  size: ViewSize,
  bodies: Bodies,
  current: MarkerMaterials,
  ghostMaterials: readonly MarkerMaterials[],
  ghostAt: readonly THREE.Vector3[],
  dotAt: readonly THREE.Vector3[],
  dotMaterial: THREE.MeshBasicMaterial
) {
  const { root } = placed
  if (!root || !placed.current) return
  const { radius } = bodies
  // The controls may have moved the camera since it last rendered.
  camera.updateMatrixWorld()
  earthAt.fromArray(bodies.positionAt(simTime()))
  const upp = worldUnitsPerPixel(camera, earthAt, size.height)
  const wide = wideFade(radius / upp)

  // Earth's axis shows close in too, as the boldest mark on the globe.
  const earthRadius = markerRadius(upp, radius, size.width)
  const reach = earthRadius * (AXIS_REACH_CLOSE + (AXIS_REACH_WIDE - AXIS_REACH_CLOSE) * wide)
  placeMarker(placed.current, current, earthAt, upp, earthRadius, reach, wide * standInFade(earthRadius / radius), 1)

  const ghostOpacity = GHOST_OPACITY * wide
  for (let i = 0; i < ghostAt.length; i++) {
    const group = placed.ghosts[i]
    if (!group) continue
    const at = ghostAt[i]
    // Earth itself stands there still.
    if (ghostOpacity <= SHOWN || at.distanceTo(earthAt) < 2 * earthRadius) {
      group.visible = false
      continue
    }
    const ghostUpp = worldUnitsPerPixel(camera, at, size.height)
    placeMarker(group, ghostMaterials[i], at, ghostUpp, GHOST_PX * ghostUpp, GHOST_AXIS_PX * ghostUpp, ghostOpacity, ghostOpacity)
  }

  // The apsides' dots and labels, only in the wide view. Each label faces
  // the eye, so it reads upright and unmirrored, beside its dot (labelSide).
  root.visible = true
  const labelsShown = wide > SHOWN
  for (const dot of placed.dots) if (dot) dot.visible = labelsShown
  for (const label of placed.labels) if (label) label.visible = labelsShown
  if (!labelsShown) return
  dotMaterial.opacity = DOT_OPACITY * wide
  right.setFromMatrixColumn(camera.matrixWorld, 0)
  up.setFromMatrixColumn(camera.matrixWorld, 1)
  eye.setFromMatrixPosition(camera.matrixWorld)
  toScreen(earthAt, upp, reach, earthDisc)
  sunAt.set(0, 0, 0)
  toScreen(sunAt, worldUnitsPerPixel(camera, sunAt, size.height), bodies.sunRadius, sunDisc)
  sideInput.viewW = size.width
  sideInput.viewH = size.height
  const fontPx = size.width <= PHONE_VIEW_PX ? LABEL_PX.phone : LABEL_PX.desktop
  for (let i = 0; i < dotAt.length; i++) {
    const at = dotAt[i]
    const dotUpp = worldUnitsPerPixel(camera, at, size.height)
    placed.dots[i]?.scale.setScalar(DOT_PX * dotUpp)
    const label = placed.labels[i]
    const text = placed.texts[i]
    if (!label || !text) continue
    const bounds = text.textRenderInfo?.blockBounds
    offset.subVectors(at, eye)
    sideInput.dotX = offset.dot(right) / dotUpp
    sideInput.dotY = offset.dot(up) / dotUpp
    // The way out from the Sun (the origin).
    sideInput.outX = at.dot(right)
    sideInput.outY = at.dot(up)
    sideInput.halfW = bounds ? ((bounds[2] - bounds[0]) / 2) * fontPx : 7 * fontPx
    sideInput.halfH = bounds ? ((bounds[3] - bounds[1]) / 2) * fontPx : 0.6 * fontPx
    labelSide(sideInput, labelAt)
    label.position
      .copy(at)
      .addScaledVector(right, (labelAt.x - sideInput.dotX) * dotUpp)
      .addScaledVector(up, (labelAt.y - sideInput.dotY) * dotUpp)
    label.quaternion.copy(camera.quaternion)
    label.scale.setScalar(fontPx * dotUpp)
    text.fillOpacity = LABEL_OPACITY * wide
    text.outlineOpacity = LABEL_OPACITY * wide
  }
}

function Marker({
  materials,
  geometries,
  orientation,
  onGroup,
}: {
  materials: MarkerMaterials
  geometries: ReturnType<typeof createGeometries>
  orientation: THREE.Quaternion
  onGroup: (group: THREE.Group | null) => void
}) {
  return (
    <group ref={onGroup} quaternion={orientation} visible={false}>
      <mesh renderOrder={AID_RENDER_ORDER} geometry={geometries.globe} material={materials.globe} raycast={noRaycast} />
      <mesh renderOrder={AID_RENDER_ORDER + 1} geometry={geometries.axis} material={materials.axis} raycast={noRaycast} />
      <mesh renderOrder={AID_RENDER_ORDER + 1} geometry={geometries.arrow} material={materials.axis} raycast={noRaycast} />
    </group>
  )
}

export function SeasonsOrbit({ positionAt, radius, sunRadius }: Bodies) {
  const demoId = useStore((s) => s.demo?.id)
  const step = useStore((s) => s.demo?.step ?? 0)
  const landed = useStore((s) => s.demoTravel === null)

  // Where Earth was at each stop reached; copies, as positionAt may hand
  // back a shared array.
  const ghostAt = useMemo(() => {
    const demo = demoId ? findDemo(demoId) : undefined
    if (!demo) return []
    const dates = demo.steps.map((s) => Date.parse(s.date))
    return ghostDates(dates, step, landed)
      .slice(0, MAX_GHOSTS)
      .map((t) => new THREE.Vector3().fromArray(positionAt(t)))
  }, [demoId, step, landed, positionAt])
  const dotAt = useMemo(() => SEASONS_APSIDES.map(({ t }) => new THREE.Vector3().fromArray(positionAt(t))), [positionAt])
  // Earth's north; it moves 0.0001° a year, so once.
  const orientation = useMemo(() => {
    const [x, y, z] = northAxis(earthTilt(simTime()))
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, y, z))
  }, [])

  const geometries = useMemo(() => createGeometries(), [])
  const materials = useMemo(
    () => ({
      current: createMarkerMaterials(EARTH_COLORS),
      ghosts: Array.from({ length: MAX_GHOSTS }, () => createMarkerMaterials(GHOST_COLORS)),
      dot: new THREE.MeshBasicMaterial({ color: DOT_COLOR, transparent: true, toneMapped: false, depthWrite: false }),
      // Depth-tested so a globe in front hides a label, never written.
      label: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    }),
    []
  )
  useEffect(
    () => () => {
      for (const geometry of Object.values(geometries)) geometry.dispose()
    },
    [geometries]
  )
  useEffect(
    () => () => {
      for (const marker of [materials.current, ...materials.ghosts]) {
        marker.globe.dispose()
        marker.axis.dispose()
      }
      materials.dot.dispose()
      materials.label.dispose()
    },
    [materials]
  )

  const placed = useRef<Placed>({ root: null, current: null, ghosts: [], dots: [], labels: [], texts: [] })

  const viewSize = useViewSize()
  const bodies = useMemo(() => ({ positionAt, radius, sunRadius }), [positionAt, radius, sunRadius])
  useFrame(({ camera, size }) =>
    place(placed.current, camera, viewSize(size), bodies, materials.current, materials.ghosts, ghostAt, dotAt, materials.dot)
  )

  return (
    <group
      ref={(group) => {
        placed.current.root = group
      }}
    >
      <Marker
        materials={materials.current}
        geometries={geometries}
        orientation={orientation}
        onGroup={(group) => {
          placed.current.current = group
        }}
      />
      {ghostAt.map((_, i) => (
        <Marker
          key={i}
          materials={materials.ghosts[i]}
          geometries={geometries}
          orientation={orientation}
          onGroup={(group) => {
            placed.current.ghosts[i] = group
          }}
        />
      ))}
      {SEASONS_APSIDES.map(({ kind, distanceAu }, i) => (
        <group key={kind}>
          <mesh
            ref={(dot) => {
              placed.current.dots[i] = dot
            }}
            position={dotAt[i]}
            renderOrder={AID_RENDER_ORDER}
            geometry={geometries.globe}
            material={materials.dot}
            raycast={noRaycast}
          />
          <group
            ref={(label) => {
              placed.current.labels[i] = label
            }}
          >
            <Text
              ref={(text: TroikaText | null) => {
                placed.current.texts[i] = text
              }}
              material={materials.label}
              color={LABEL_COLOR}
              fontSize={1}
              outlineWidth="8%"
              outlineColor="black"
              anchorX="center"
              anchorY="middle"
              renderOrder={AID_RENDER_ORDER}
              raycast={noRaycast}
            >
              {apsisLabel(kind, distanceAu)}
            </Text>
          </group>
        </group>
      ))}
    </group>
  )
}
