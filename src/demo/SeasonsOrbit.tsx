// The seasons demo's orbit aid (tides-zec.11), main view only: what the wide
// view between stops needs to show the axis holding its direction in space
// while Earth goes round the Sun. There Earth is ~21 CSS px in radius on a
// desktop and ~10 on a phone, and SeasonsGlobe's axis a hair, so this draws
//   - a bold axis through Earth, a fixed width on screen, its north end
//     arrowed, with a simple half-lit stand-in globe over Earth once that
//     would be clearly larger than the globe as drawn (zoomed out further);
//   - a faint stand-in, axis and all, where Earth was at each stop reached;
//   - the orbit's nearest and farthest points, labelled with the distance.
// In world space, not under Earth's OrbitingBody: the stand-ins sit where
// Earth was, and every axis points along Earth's north (northAxis), which
// the spin leaves be. All of it fades out as the eye closes on the globe
// (wideFade), so close-ups show Earth alone. Sizes and fades are seasons.ts.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import { earthTilt, type Vec3 } from '../ephemeris'
import { useStore } from '../store'
import { worldUnitsPerPixel } from '../system-aids/pixel-scale'
import { findDemo } from './demos'
import { AID_RENDER_ORDER } from './SeasonsGlobe'
import {
  SEASONS_APSIDES,
  apsisLabel,
  ghostDates,
  markerRadius,
  northAxis,
  standInFade,
  wideFade,
} from './seasons'

// CSS px on screen. [TUNE]
const AXIS_WIDTH_PX = 2.5
const ARROW_RADIUS_PX = 5
const ARROW_LENGTH_PX = 11
const DOT_PX = 3
const LABEL_PX = { desktop: 12, phone: 11 }
const LABEL_GAP_PX = 6
// A label keeps this far inside the view's edge, or goes the other side. [TUNE]
const EDGE_MARGIN_PX = 8
// A label goes left or right of its dot while the way out from the Sun is at
// least this much sideways on screen (a cosine), else above or below. [TUNE]
const SIDEWAYS = 0.35
const PHONE_VIEW_PX = 600
/** The axis's reach each way, × the stand-in's radius. [TUNE] */
const AXIS_REACH = 2.6
const GHOST_OPACITY = 0.4 // [TUNE]
const DOT_COLOR = '#AEB4C8'
const DOT_OPACITY = 0.85
const LABEL_COLOR = '#AEB4C8'
const LABEL_OPACITY = 0.8
// One for every stop of a tour; past it, the earliest are kept.
const MAX_GHOSTS = 8
// Below this the aid is all but gone: hidden, so its globes write no depth.
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
uniform float opacity;
varying vec3 vNormal;
void main() {
  float lit = smoothstep(-0.12, 0.22, dot(normalize(vNormal), sunDir));
  vec3 night = vec3(0.06, 0.09, 0.16);
  vec3 day = vec3(0.33, 0.6, 0.95);
  gl_FragColor = vec4(mix(night, day, lit), opacity);
}`

interface MarkerMaterials {
  globe: THREE.ShaderMaterial
  axis: THREE.MeshBasicMaterial
}

function createMarkerMaterials(): MarkerMaterials {
  return {
    globe: new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: new THREE.Vector3(1, 0, 0) }, opacity: { value: 1 } },
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

// A stand-in at `position`: globe `globeOpacity`, axis `axisOpacity`, sized
// by the scene units a CSS px spans there; the group's children are the
// globe, the axis and its arrow, in the order Marker renders them.
function placeMarker(
  group: THREE.Object3D,
  materials: MarkerMaterials,
  position: THREE.Vector3,
  upp: number,
  radius: number,
  globeOpacity: number,
  axisOpacity: number
) {
  group.visible = axisOpacity > SHOWN
  if (!group.visible) return
  group.position.copy(position)
  const [globe, axis, arrow] = group.children
  globe.visible = globeOpacity > SHOWN
  globe.scale.setScalar(radius)
  materials.globe.uniforms.opacity.value = globeOpacity
  // The Sun is at the origin.
  ;(materials.globe.uniforms.sunDir.value as THREE.Vector3).copy(position).negate().normalize()
  const reach = AXIS_REACH * radius
  const width = (AXIS_WIDTH_PX / 2) * upp
  axis.scale.set(width, 2 * reach, width)
  arrow.position.y = reach
  arrow.scale.set(ARROW_RADIUS_PX * upp, ARROW_LENGTH_PX * upp, ARROW_RADIUS_PX * upp)
  materials.axis.opacity = axisOpacity
}

// Whether a box centred (x, y) px from the view's centre lies inside it.
function boxFits(x: number, y: number, halfW: number, halfH: number, size: { width: number; height: number }) {
  return (
    Math.abs(x) + halfW <= size.width / 2 - EDGE_MARGIN_PX && Math.abs(y) + halfH <= size.height / 2 - EDGE_MARGIN_PX
  )
}

interface Placed {
  root: THREE.Group | null
  current: THREE.Group | null
  ghosts: (THREE.Group | null)[]
  dots: (THREE.Mesh | null)[]
  labels: (THREE.Group | null)[]
  texts: (TroikaText | null)[]
}

function place(
  placed: Placed,
  camera: THREE.Camera,
  size: { width: number; height: number },
  positionAt: (t: number) => Vec3,
  radius: number,
  current: MarkerMaterials,
  ghostMaterials: readonly MarkerMaterials[],
  ghostAt: readonly THREE.Vector3[],
  dotAt: readonly THREE.Vector3[],
  dotMaterial: THREE.MeshBasicMaterial
) {
  const { root } = placed
  if (!root || !placed.current) return
  // The controls may have moved the camera since it last rendered.
  camera.updateMatrixWorld()
  earthAt.fromArray(positionAt(simTime()))
  const upp = worldUnitsPerPixel(camera, earthAt, size.height)
  const wide = wideFade(radius / upp)
  root.visible = wide > SHOWN
  if (!root.visible) return

  const earthRadius = markerRadius(upp, radius, size.width)
  placeMarker(placed.current, current, earthAt, upp, earthRadius, wide * standInFade(earthRadius / radius), wide)

  for (let i = 0; i < ghostAt.length; i++) {
    const group = placed.ghosts[i]
    if (!group) continue
    const at = ghostAt[i]
    // Earth itself stands there still.
    if (at.distanceTo(earthAt) < 2 * earthRadius) {
      group.visible = false
      continue
    }
    const ghostUpp = worldUnitsPerPixel(camera, at, size.height)
    const opacity = GHOST_OPACITY * wide
    placeMarker(group, ghostMaterials[i], at, ghostUpp, markerRadius(ghostUpp, radius, size.width), opacity, opacity)
  }

  // Each label beside its dot, outward from the Sun as it looks from here,
  // facing the eye so it reads upright and unmirrored.
  dotMaterial.opacity = DOT_OPACITY * wide
  right.setFromMatrixColumn(camera.matrixWorld, 0)
  up.setFromMatrixColumn(camera.matrixWorld, 1)
  eye.setFromMatrixPosition(camera.matrixWorld)
  const fontPx = size.width <= PHONE_VIEW_PX ? LABEL_PX.phone : LABEL_PX.desktop
  for (let i = 0; i < dotAt.length; i++) {
    const at = dotAt[i]
    const dotUpp = worldUnitsPerPixel(camera, at, size.height)
    placed.dots[i]?.scale.setScalar(DOT_PX * dotUpp)
    const label = placed.labels[i]
    const text = placed.texts[i]
    if (!label || !text) continue
    // Beside the dot, on the side away from the Sun as it looks from here:
    // left or right unless that side is nearly straight up or down.
    let dx = at.x * right.x + at.y * right.y + at.z * right.z
    let dy = at.x * up.x + at.y * up.y + at.z * up.z
    const sideways = Math.abs(dx) >= SIDEWAYS * Math.hypot(dx, dy)
    dx = sideways ? Math.sign(dx) || 1 : 0
    dy = sideways ? 0 : Math.sign(dy) || 1
    const bounds = text.textRenderInfo?.blockBounds
    const halfW = bounds ? ((bounds[2] - bounds[0]) / 2) * fontPx : 7 * fontPx
    const halfH = bounds ? ((bounds[3] - bounds[1]) / 2) * fontPx : 0.6 * fontPx
    // Clear of Earth when it passes the dot, as at the last stop.
    const clear = at.distanceTo(earthAt) < 3 * earthRadius ? earthRadius / dotUpp : DOT_PX
    let px = clear + LABEL_GAP_PX + (sideways ? halfW : halfH)
    // The other side if this one runs off the view (px from its centre).
    offset.subVectors(at, eye)
    const sx = offset.dot(right) / dotUpp
    const sy = offset.dot(up) / dotUpp
    if (!boxFits(sx + dx * px, sy + dy * px, halfW, halfH, size) && boxFits(sx - dx * px, sy - dy * px, halfW, halfH, size)) {
      px = -px
    }
    px *= dotUpp
    offset.copy(right).multiplyScalar(dx * px).addScaledVector(up, dy * px)
    label.position.copy(at).add(offset)
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

export function SeasonsOrbit({ positionAt, radius }: { positionAt: (t: number) => Vec3; radius: number }) {
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
      current: createMarkerMaterials(),
      ghosts: Array.from({ length: MAX_GHOSTS }, createMarkerMaterials),
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

  useFrame(({ camera, size }) =>
    place(placed.current, camera, size, positionAt, radius, materials.current, materials.ghosts, ghostAt, dotAt, materials.dot)
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
