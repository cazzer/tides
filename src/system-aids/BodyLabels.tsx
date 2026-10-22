// Names for the Sun, Earth, the Moon, the planets and their major moons in
// the system view (tides-2hv.10). Mounted by SystemAids.tsx while
// systemAids.labels is on.
//
// Each name is troika text (drei's <Text>, the month names' font) a fixed
// size on screen, facing the camera, beside its body on the side away from
// what the body orbits: outward from the Sun for Earth and the planets,
// clear of the clock and the month names inside Earth's orbit, and outward
// from the planet for its moons. The Sun, orbiting nothing, has its name
// above it. When each name shows is label-visibility.ts. A name that would
// cover a higher-priority name or body, or an AU ring's label (EclipticGrid),
// tries the body's other sides, and fades out if none is clear.
//
// Off in ship mode: its perspective camera would need names sized by depth,
// and the HUD's target marker already names what the ship is pointed at.
//
// One useFrame places and fades all of them through refs; React renders the
// labels once (again only if the view crosses the phone width). Their
// per-frame state is module level, so one BodyLabels is mounted at a time:
// SystemAids mounts it in the main view only (ship mode draws none).
import { useEffect, useRef, type FC } from 'react'
import { Text } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, type CameraFocus } from '../store'
import { positionsFor, type ScalePositions } from '../flight-scale'
import type { DistanceScale } from '../distance-scale'
import { labelMaterial } from '../orbit-label'
import { MOONS, isMoonKey, moonOffsetInto } from '../moons/moons'
import { PLANET_KEYS } from '../planets'
import type { Vec3 } from '../ephemeris'
import { AU_RINGS, ringLabel, ringLabelAngles, ringLabelPosition } from './ecliptic-grid'
import { RING_LABEL_PX } from './EclipticGrid'
import { bodyName } from '../ship/ship-distances'
import {
  BODY_LABEL_PX,
  LABEL_COLOR,
  LABEL_GAP_PX,
  LABEL_OUTLINE_COLOR,
  LABEL_OUTLINE_WIDTH,
  MOON_LABEL_PX,
  PHONE_LABEL_SHRINK_PX,
  PHONE_VIEW_PX,
} from './label-style'
import {
  LABEL_COLLISION_FADE_S,
  LABEL_COLLISION_PAD_PX,
  LABEL_SPACING_PX,
  MIN_BLOCKING_DISC_PX,
  LABEL_KEYS,
  boxHitsDisc,
  boxesOverlap,
  focusBody,
  isLabelMoon,
  bodyRadius,
  bodyReach,
  labelDirection,
  labelDistancePx,
  labelOpacity,
  steerClearOfSun,
  type LabelKey,
  type ScreenDirection,
} from './label-visibility'
import { orthoUnitsPerPixel } from './pixel-scale'
import type { SystemAidProps } from './types'

type TroikaText = THREE.Mesh & {
  fillOpacity: number
  outlineOpacity: number
  /** Set once troika has laid the text out; [minX, minY, maxX, maxY] at font size 1. */
  textRenderInfo?: { blockBounds: readonly number[] }
}

// Above the clock (renderOrder 3), which is drawn over the planets.
const LABEL_RENDER_ORDER = 4

// The month names' material, but drawn over everything, as the clock is with
// the planets on. Depth-tested, a name sat at its body's depth and a ring or
// globe passing in front cut it: Titan's, behind Saturn's rings seen nearly
// edge-on. What a name may cover is the collision pass's call instead.
const nameMaterial = labelMaterial.clone()
nameMaterial.depthTest = false

// Below this a name is skipped altogether rather than drawn invisible.
const MIN_OPACITY = 0.01

// What each body orbits, for which side its name goes on.
function parentOf(key: LabelKey): LabelKey | null {
  if (key === 'sun') return null
  if (key === 'moon') return 'earth'
  if (isMoonKey(key)) return MOONS[key].parent
  return 'sun'
}

// Names never take a tap: the bodies and the clock beside them do, and 29
// troika meshes would otherwise be raycast on every pointer move.
const noRaycast = () => {}

const position = new THREE.Vector3()
const parentPosition = new THREE.Vector3()
const offset = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const back = new THREE.Vector3()
const eyeAt = new THREE.Vector3()
const direction: ScreenDirection = { x: 0, y: 1 }
const awayFromSun: ScreenDirection = { x: 0, y: 1 }

const pole = new THREE.Vector3()
const along = new THREE.Vector3()

// Cosine between the screen direction `dir` and a ringed planet's pole (its
// mesh's local +Y, axisOrientation), so the name clears the rings as they
// look from here; 0, the whole ring, before the planet has registered.
function ringPoleAlong(key: LabelKey, dir: ScreenDirection): number {
  if (key !== 'saturn' && key !== 'uranus') return 0
  const body = useStore.getState()[key]?.current
  if (!body) return 0
  pole.set(0, 1, 0).applyQuaternion(body.quaternion)
  return along.copy(right).multiplyScalar(dir.x).addScaledVector(up, dir.y).dot(pole)
}

function bodyPositionInto(
  key: LabelKey,
  t: number,
  positionAt: ScalePositions['positionAt'],
  out: THREE.Vector3
): THREE.Vector3 {
  if (!isMoonKey(key)) return out.fromArray(positionAt[key](t))
  const [x, y, z] = positionAt[MOONS[key].parent](t)
  moonOffsetInto(key, t, out)
  out.x += x
  out.y += y
  out.z += z
  return out
}

// Per label, in LABEL_KEYS order, in screen px along the camera's right and
// up axes: the body's disc and scene position, the name's half sizes, the
// side it goes on by default (dirX, dirY), the side it is on (`side`, an
// index into SIDES, and its box centre), the opacity the zoom asks for, and
// how far it is shown past collisions (0 to 1, eased).
const n = LABEL_KEYS.length
const discX = new Float64Array(n)
const discY = new Float64Array(n)
const discR = new Float64Array(n)
// Toward the camera, scene units: larger is nearer.
const nearness = new Float64Array(n)
// Between the camera's near and far planes. The main view's near plane
// moves with the zoom (main-view.ts' planetsNear), so close in, a body
// behind the eye, the Sun behind Saturn say, is clipped: it has no name and
// hides none.
const inView = new Uint8Array(n)
const bodyAt = new Float64Array(n * 3)
const halfW = new Float64Array(n)
const halfH = new Float64Array(n)
const dirX = new Float64Array(n)
const dirY = new Float64Array(n)
const boxX = new Float64Array(n)
const boxY = new Float64Array(n)
const boxDistance = new Float64Array(n)
const side = new Int8Array(n)
const wanted = new Float64Array(n)
const shown = new Float64Array(n)
// The names kept so far this frame, in priority order.
const kept = new Int32Array(n)

// The sides a name tries, in turn, as quarter turns from its default: out
// from what the body orbits, then either way along the orbit, then inward.
// [cos, sin] of each turn.
const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [0, -1],
  [-1, 0],
]

// Put name i on side `s`: its direction from the body's centre (into
// `direction`), and its box.
function placeOnSide(i: number, s: number, key: LabelKey, upp: number) {
  const [c, sn] = SIDES[s]
  direction.x = dirX[i] * c - dirY[i] * sn
  direction.y = dirX[i] * sn + dirY[i] * c
  if (key === 'moon') steerClearOfSun(direction, awayFromSun.x, awayFromSun.y)
  const reach = bodyReach(key, ringPoleAlong(key, direction)) / upp
  const distance = labelDistancePx(direction.x, direction.y, reach, halfW[i], halfH[i], LABEL_GAP_PX)
  boxDistance[i] = distance
  boxX[i] = discX[i] + direction.x * distance
  boxY[i] = discY[i] + direction.y * distance
}

// Whether body i is out of sight behind a higher-priority body's globe; its
// name goes with it.
function eclipsed(i: number): boolean {
  for (let j = 0; j < n; j++) {
    if (
      j !== i &&
      inView[j] &&
      rank(j) < rank(i) &&
      nearness[j] > nearness[i] &&
      Math.hypot(discX[i] - discX[j], discY[i] - discY[j]) < discR[j]
    ) {
      return true
    }
  }
  return false
}

// Whether name i, where it is now, would cover a kept name, an AU ring's
// label it doesn't outrank, or the disc of a body ahead of it in priority,
// growing its box by `pad` px.
function collides(i: number, keptCount: number, pad: number): boolean {
  const w = halfW[i] + pad
  const h = halfH[i] + pad
  // Names keep a space between them, so two never read as one word.
  const spacedW = w + LABEL_SPACING_PX
  const spacedH = h + LABEL_SPACING_PX
  for (let k = 0; k < keptCount; k++) {
    const j = kept[k]
    if (boxesOverlap(boxX[i], boxY[i], spacedW, spacedH, boxX[j], boxY[j], halfW[j], halfH[j])) return true
  }
  if (rank(i) > RING_LABEL_RANK) {
    for (let r = 0; r < ringCount; r++) {
      if (boxesOverlap(boxX[i], boxY[i], spacedW, spacedH, ringX[r], ringY[r], ringHalfW[r], ringHalfH)) {
        return true
      }
    }
  }
  for (let j = 0; j < n; j++) {
    if (
      j !== i &&
      inView[j] &&
      rank(j) < rank(i) &&
      discR[j] >= MIN_BLOCKING_DISC_PX &&
      boxHitsDisc(boxX[i], boxY[i], w, h, discX[j], discY[j], discR[j])
    ) {
      return true
    }
  }
  return false
}

// The AU rings' labels (EclipticGrid, tides-2hv.9) are fixed obstacles:
// the Sun's, Earth's and the Moon's names (and the focused body's) outrank
// them, every other name gives way. Their anchors are worked out as
// EclipticGrid does at mount, and their boxes from its layout: left- and
// bottom-anchored TEXT_OFFSET ems right and up of the anchor, RING_LABEL_PX
// to the em. The width is estimated (~0.6 em a character), as they aren't
// our meshes to measure.
const RING_LABEL_RANK = LABEL_KEYS.indexOf('moon')
const RING_TEXT_OFFSET_EM = [0.35, 0.15] as const
const RING_CHAR_EM = 0.6
const RING_LINE_EM = 1.2
const ringAnchors = AU_RINGS.map(() => new THREE.Vector3())
const ringHalfWEm = AU_RINGS.map((au) => (ringLabel(au).length * RING_CHAR_EM) / 2)
const ringX = new Float64Array(AU_RINGS.length)
const ringY = new Float64Array(AU_RINGS.length)
const ringHalfW = new Float64Array(AU_RINGS.length)
const ringHalfH = (RING_LINE_EM / 2) * RING_LABEL_PX
// 0 while the grid is off.
let ringCount = 0

function setRingLabels(on: boolean, scale: DistanceScale) {
  ringCount = 0
  if (!on) return
  const { distance, positionAt } = positionsFor(scale)
  const t = useStore.getState().timestamp ?? Date.now()
  const bodies = (['earth', ...PLANET_KEYS] as const).map((key): Vec3 => {
    const [x, y, z] = positionAt[key](t)
    return [x, y, z]
  })
  const angles = ringLabelAngles(distance, bodies)
  AU_RINGS.forEach((au, r) => ringAnchors[r].fromArray(ringLabelPosition(distance, au, angles[r])))
  ringCount = AU_RINGS.length
}

// The ring labels' boxes on screen this frame, px.
// A label clipped by the near or far plane (see inView) gets zero width.
function placeRingBoxes(upp: number, eye: number, near: number, far: number) {
  for (let r = 0; r < ringCount; r++) {
    const depth = eye - ringAnchors[r].dot(back)
    ringHalfW[r] = depth >= near && depth <= far ? ringHalfWEm[r] * RING_LABEL_PX : -Infinity
    ringX[r] = ringAnchors[r].dot(right) / upp + (RING_TEXT_OFFSET_EM[0] + ringHalfWEm[r]) * RING_LABEL_PX
    ringY[r] = ringAnchors[r].dot(up) / upp + (RING_TEXT_OFFSET_EM[1] + RING_LINE_EM / 2) * RING_LABEL_PX
  }
}
let focusIndex = -1
// The focused body's name first, then LABEL_KEYS' order.
const rank = (j: number) => (j === focusIndex ? -1 : j)

// Module level, so the troika meshes behind the refs aren't mutated in a hook.
function placeLabels(
  texts: readonly (TroikaText | null)[],
  camera: THREE.Camera,
  upp: number,
  t: number,
  scale: DistanceScale,
  focus: CameraFocus,
  phone: boolean,
  delta: number
) {
  const { positionAt } = positionsFor(scale)
  // The camera's screen axes in world space (the scene's root is unrotated).
  right.setFromMatrixColumn(camera.matrixWorld, 0)
  up.setFromMatrixColumn(camera.matrixWorld, 1)
  back.setFromMatrixColumn(camera.matrixWorld, 2)
  const eye = eyeAt.setFromMatrixPosition(camera.matrixWorld).dot(back)
  const { near, far } = camera as THREE.OrthographicCamera
  const shrink = phone ? PHONE_LABEL_SHRINK_PX : 0

  // Where every body is, and each wanted name's size and default side.
  for (let i = 0; i < n; i++) {
    const key = LABEL_KEYS[i]
    bodyPositionInto(key, t, positionAt, position)
    position.toArray(bodyAt, i * 3)
    discX[i] = position.dot(right) / upp
    discY[i] = position.dot(up) / upp
    // Globes only: a ring covers far less than its circle unless face-on.
    discR[i] = bodyRadius(key) / upp
    nearness[i] = position.dot(back)
    const depth = eye - nearness[i]
    inView[i] = depth >= near && depth <= far ? 1 : 0
    const text = texts[i]
    const bounds = text?.textRenderInfo?.blockBounds
    wanted[i] = text && bounds && inView[i] ? labelOpacity(key, upp, focus) : 0
    if (!text || !bounds || wanted[i] < MIN_OPACITY) continue

    const parent = parentOf(key)
    if (parent) offset.subVectors(position, bodyPositionInto(parent, t, positionAt, parentPosition))
    else offset.set(0, 0, 0)
    labelDirection(offset.dot(right), offset.dot(up), direction)
    dirX[i] = direction.x
    dirY[i] = direction.y
    const fontPx = (isLabelMoon(key) ? MOON_LABEL_PX : BODY_LABEL_PX) - shrink
    halfW[i] = ((bounds[2] - bounds[0]) / 2) * fontPx
    halfH[i] = ((bounds[3] - bounds[1]) / 2) * fontPx
    text.quaternion.copy(camera.quaternion)
    text.scale.setScalar(fontPx * upp)
  }

  // In priority order, each name takes the first clear side (last frame's
  // first, so it doesn't hop while that stays clear), or fades out where it
  // was if none is; the focused body's name shows wherever it lands. Each
  // eases toward shown or hidden.
  placeRingBoxes(upp, eye, near, far)
  focusIndex = LABEL_KEYS.indexOf(focusBody(focus))
  const step = delta / LABEL_COLLISION_FADE_S
  let keptCount = 0
  for (let k = -1; k < n; k++) {
    const i = k < 0 ? focusIndex : k
    if (i < 0 || (k >= 0 && i === focusIndex)) continue
    let target = 0
    const text = texts[i]
    if (text && wanted[i] >= MIN_OPACITY && (i === focusIndex || !eclipsed(i))) {
      const key = LABEL_KEYS[i]
      // The Sun sits at the origin.
      if (key === 'moon') labelDirection(discX[i], discY[i], awayFromSun)
      const pad = shown[i] > 0.5 ? -LABEL_COLLISION_PAD_PX : LABEL_COLLISION_PAD_PX
      const was = side[i]
      let clear = false
      for (let tried = -1; tried < SIDES.length && !clear; tried++) {
        const s = tried < 0 ? was : tried
        if (tried >= 0 && s === was) continue
        placeOnSide(i, s, key, upp)
        if (!collides(i, keptCount, pad)) {
          clear = true
          side[i] = s
        }
      }
      if (!clear) placeOnSide(i, was, key, upp)
      if (clear || i === focusIndex) {
        target = 1
        kept[keptCount++] = i
      }
      const distance = boxDistance[i] * upp
      text.position
        .fromArray(bodyAt, i * 3)
        .addScaledVector(right, direction.x * distance)
        .addScaledVector(up, direction.y * distance)
    }
    shown[i] = target > shown[i] ? Math.min(target, shown[i] + step) : Math.max(target, shown[i] - step)
  }

  for (let i = 0; i < n; i++) {
    const text = texts[i]
    if (!text) continue
    const opacity = wanted[i] * shown[i]
    text.visible = opacity >= MIN_OPACITY
    text.fillOpacity = opacity
    text.outlineOpacity = opacity
  }
}

export const BodyLabels: FC<SystemAidProps> = ({ distanceScale, ship }) =>
  ship ? null : <Labels distanceScale={distanceScale} />

function Labels({ distanceScale }: { distanceScale: DistanceScale }) {
  const texts = useRef<(TroikaText | null)[]>([])
  // A boolean, so resizing re-renders only on crossing the phone width.
  const phone = useThree((state) => state.size.width <= PHONE_VIEW_PX)
  const grid = useStore((s) => s.systemAids.grid)
  useEffect(() => {
    setRingLabels(grid, distanceScale)
    return () => setRingLabels(false, distanceScale)
  }, [grid, distanceScale])

  useFrame(({ camera, size }, delta) => {
    const t = useStore.getState().timestamp
    const ortho = camera as THREE.OrthographicCamera
    if (t == null || !ortho.isOrthographicCamera) return
    const upp = orthoUnitsPerPixel(ortho.top, ortho.bottom, ortho.zoom, size.height)
    const { cameraFocus } = useStore.getState()
    placeLabels(texts.current, camera, upp, t, distanceScale, cameraFocus, phone, delta)
  })

  return (
    <>
      {LABEL_KEYS.map((key, i) => (
        <Text
          key={key}
          ref={(text: TroikaText | null) => {
            texts.current[i] = text
          }}
          material={nameMaterial}
          renderOrder={LABEL_RENDER_ORDER}
          raycast={noRaycast}
          // Placed, faded and sized on the first frame.
          visible={false}
          color={LABEL_COLOR}
          outlineWidth={LABEL_OUTLINE_WIDTH}
          outlineColor={LABEL_OUTLINE_COLOR}
          anchorX="center"
          anchorY="middle"
        >
          {bodyName(key)}
        </Text>
      ))}
    </>
  )
}
