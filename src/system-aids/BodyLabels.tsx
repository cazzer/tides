// Names for the Sun, Earth, the Moon, the planets and their major moons in
// the system view (tides-2hv.10). Mounted by SystemAids.tsx while
// systemAids.labels is on.
//
// Each name is troika text (drei's <Text>, the month names' font) a fixed
// size on screen, facing the camera, beside its body on the side away from
// what the body orbits: outward from the Sun for Earth and the planets,
// clear of the clock and the month names inside Earth's orbit, and outward
// from the planet for its moons. The Sun, orbiting nothing, has its name
// above it. When each name shows is label-visibility.ts: labelOpacity for
// the zoom, resolveLabels for where it fits (another side of its body if
// the first would run off screen or cover a name, a globe, the clock or an
// AU ring's label; faded out if none fits).
//
// Off in ship mode: its perspective camera would need names sized by depth,
// and the HUD's target marker already names what the ship is pointed at.
//
// One useFrame places and fades all of them through refs; React renders the
// labels once (again only if the view crosses the phone width). Their
// per-frame state is module level, so one BodyLabels is mounted at a time:
// SystemAids mounts it in the main view only (ship mode draws none).
import { useRef, type FC } from 'react'
import { Text } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore, type CameraFocus } from '../store'
import { positionsFor, type ScalePositions } from '../flight-scale'
import type { DistanceScale } from '../distance-scale'
import { CLOCK_HALF_WIDTH, CLOCK_INNER_RADIUS, labelMaterial } from '../orbit-label'
import { earthAngle } from '../ephemeris'
import { MOONS, isMoonKey, moonOffsetInto } from '../moons/moons'
import { bodyName } from '../ship/ship-distances'
import { AU_RINGS, ringLabelLayout } from './ecliptic-grid'
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
  LABEL_KEYS,
  MIN_NAME_OPACITY,
  bodyRadius,
  bodyReach,
  createLabelLayout,
  focusBody,
  isLabelMoon,
  labelDirection,
  labelOpacity,
  resolveLabels,
  type LabelFrame,
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
// edge-on. What a name may cover is resolveLabels' call instead.
const nameMaterial = labelMaterial.clone()
nameMaterial.depthTest = false

// What each body orbits, for which side its name goes on.
function parentOf(key: LabelKey): LabelKey | null {
  if (key === 'sun') return null
  if (key === 'moon') return 'earth'
  if (isMoonKey(key)) return MOONS[key].parent
  return 'sun'
}

const n = LABEL_KEYS.length
const PARENT_INDEX = LABEL_KEYS.map((key) => {
  const parent = parentOf(key)
  return parent ? LABEL_KEYS.indexOf(parent) : -1
})
const SUN_INDEX = LABEL_KEYS.indexOf('sun')

// The Sun's, Earth's and the Moon's names outrank the AU rings' labels;
// every other name keeps off them.
const RING_LABEL_RANK = LABEL_KEYS.indexOf('moon')

// Names never take a tap: the bodies and the clock beside them do, and 29
// troika meshes would otherwise be raycast on every pointer move.
const noRaycast = () => {}

// The clock's text (orbit-label.tsx) as a row of discs every name keeps
// off: it rides the Sun–Earth line from CLOCK_INNER_RADIUS, two lines at
// scale 2 (~4.8 units tall) and ~2 · CLOCK_HALF_WIDTH long. Discs, as the
// text lies flat on the ecliptic and is foreshortened as the view tilts.
const CLOCK_HALF_HEIGHT = 2.4
const CLOCK_DISCS = 4
const CLOCK_Y = 0.5

const layout = createLabelLayout(n, AU_RINGS.length, CLOCK_DISCS)
// Each body's scene position this frame, xyz per name.
const bodyAt = new Float64Array(n * 3)

const position = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const back = new THREE.Vector3()
const eyeAt = new THREE.Vector3()
const anchor = new THREE.Vector3()
const direction: ScreenDirection = { x: 0, y: 1 }
const pole = new THREE.Vector3()
const along = new THREE.Vector3()

let upp = 1

// Cosine between the screen direction (x, y) and a ringed planet's pole (its
// mesh's local +Y, axisOrientation), so the name clears the rings as they
// look from here; 0, the whole ring, before the planet has registered.
function ringPoleAlong(key: LabelKey, x: number, y: number): number {
  if (key !== 'saturn' && key !== 'uranus') return 0
  const body = useStore.getState()[key]?.current
  if (!body) return 0
  pole.set(0, 1, 0).applyQuaternion(body.quaternion)
  return along.copy(right).multiplyScalar(x).addScaledVector(up, y).dot(pole)
}

const frame: LabelFrame = {
  focus: -1,
  obstacleRank: RING_LABEL_RANK,
  left: 0,
  right: 0,
  bottom: 0,
  top: 0,
  delta: 0,
  gapPx: LABEL_GAP_PX,
  reach: (i, x, y) => bodyReach(LABEL_KEYS[i], ringPoleAlong(LABEL_KEYS[i], x, y)) / upp,
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

// Whether body i's globe reaches into the view at all.
function onScreen(i: number): boolean {
  const { discX, discY, discR } = layout
  return (
    discX[i] + discR[i] > frame.left &&
    discX[i] - discR[i] < frame.right &&
    discY[i] + discR[i] > frame.bottom &&
    discY[i] - discR[i] < frame.top
  )
}

function placeClock(t: number) {
  const angle = earthAngle(t)
  const length = 2 * CLOCK_HALF_WIDTH - 2 * CLOCK_HALF_HEIGHT
  for (let k = 0; k < CLOCK_DISCS; k++) {
    const r = CLOCK_INNER_RADIUS + CLOCK_HALF_HEIGHT + (length * k) / (CLOCK_DISCS - 1)
    anchor.set(r * Math.cos(angle), CLOCK_Y, -r * Math.sin(angle))
    layout.blockerX[k] = anchor.dot(right) / upp
    layout.blockerY[k] = anchor.dot(up) / upp
    layout.blockerR[k] = CLOCK_HALF_HEIGHT / upp
  }
  layout.blockerCount = CLOCK_DISCS
}

// The AU rings' labels, as EclipticGrid publishes them, as obstacles; one
// clipped by the near or far plane (see inView) is left out.
function placeRingLabels(eye: number, near: number, far: number) {
  const { count, emPx, anchors, bounds } = ringLabelLayout
  layout.obstacleCount = 0
  for (let r = 0; r < count; r++) {
    if (Number.isNaN(bounds[r * 4])) continue
    anchor.fromArray(anchors, r * 3)
    const depth = eye - anchor.dot(back)
    if (depth < near || depth > far) continue
    const k = layout.obstacleCount++
    const minX = bounds[r * 4]
    const minY = bounds[r * 4 + 1]
    const maxX = bounds[r * 4 + 2]
    const maxY = bounds[r * 4 + 3]
    layout.obstacleX[k] = anchor.dot(right) / upp + ((minX + maxX) / 2) * emPx
    layout.obstacleY[k] = anchor.dot(up) / upp + ((minY + maxY) / 2) * emPx
    layout.obstacleHalfW[k] = ((maxX - minX) / 2) * emPx
    layout.obstacleHalfH[k] = ((maxY - minY) / 2) * emPx
  }
}

// Module level, so the troika meshes behind the refs aren't mutated in a hook.
function placeLabels(
  texts: readonly (TroikaText | null)[],
  camera: THREE.OrthographicCamera,
  heightPx: number,
  t: number,
  scale: DistanceScale,
  focus: CameraFocus,
  phone: boolean,
  delta: number
) {
  upp = orthoUnitsPerPixel(camera.top, camera.bottom, camera.zoom, heightPx)
  const { positionAt } = positionsFor(scale)
  // The camera's screen axes in world space (the scene's root is unrotated).
  right.setFromMatrixColumn(camera.matrixWorld, 0)
  up.setFromMatrixColumn(camera.matrixWorld, 1)
  back.setFromMatrixColumn(camera.matrixWorld, 2)
  eyeAt.setFromMatrixPosition(camera.matrixWorld)
  const eye = eyeAt.dot(back)
  frame.left = eyeAt.dot(right) / upp + camera.left / camera.zoom / upp
  frame.right = eyeAt.dot(right) / upp + camera.right / camera.zoom / upp
  frame.bottom = eyeAt.dot(up) / upp + camera.bottom / camera.zoom / upp
  frame.top = eyeAt.dot(up) / upp + camera.top / camera.zoom / upp
  frame.focus = LABEL_KEYS.indexOf(focusBody(focus))
  frame.delta = delta
  const shrink = phone ? PHONE_LABEL_SHRINK_PX : 0
  const { discX, discY, discR, nearness, inView, wanted, halfW, halfH, dirX, dirY } = layout

  // Every body: where it is on screen, and whether the near and far planes
  // let it through. The main view's near plane moves with the zoom
  // (main-view.ts' planetsNear), so close in, a body behind the eye (the Sun
  // behind Saturn, say) is clipped: it has no name and hides none.
  for (let i = 0; i < n; i++) {
    bodyPositionInto(LABEL_KEYS[i], t, positionAt, position)
    position.toArray(bodyAt, i * 3)
    discX[i] = position.dot(right) / upp
    discY[i] = position.dot(up) / upp
    // Globes only: a ring covers far less than its circle unless face-on.
    discR[i] = bodyRadius(LABEL_KEYS[i]) / upp
    nearness[i] = position.dot(back)
    const depth = eye - nearness[i]
    inView[i] = depth >= camera.near && depth <= camera.far ? 1 : 0
  }

  // Each wanted name's size and default side. A moon is named only with its
  // planet in sight, so a lone moon at the edge doesn't read as a stray.
  for (let i = 0; i < n; i++) {
    const key = LABEL_KEYS[i]
    const text = texts[i]
    const bounds = text?.textRenderInfo?.blockBounds
    const parent = PARENT_INDEX[i]
    const parentSeen = !isLabelMoon(key) || (inView[parent] === 1 && onScreen(parent))
    wanted[i] = text && bounds && inView[i] && parentSeen ? labelOpacity(key, upp, focus) : 0
    if (!text || !bounds || wanted[i] < MIN_NAME_OPACITY) continue
    if (parent >= 0) labelDirection(discX[i] - discX[parent], discY[i] - discY[parent], direction)
    else labelDirection(0, 0, direction)
    dirX[i] = direction.x
    dirY[i] = direction.y
    if (key === 'moon') {
      // Away from the Sun at the Moon, so its name never heads for the clock.
      layout.steer[i] = 1
      labelDirection(discX[i] - discX[SUN_INDEX], discY[i] - discY[SUN_INDEX], direction)
      layout.awayX[i] = direction.x
      layout.awayY[i] = direction.y
    }
    const fontPx = (isLabelMoon(key) ? MOON_LABEL_PX : BODY_LABEL_PX) - shrink
    halfW[i] = ((bounds[2] - bounds[0]) / 2) * fontPx
    halfH[i] = ((bounds[3] - bounds[1]) / 2) * fontPx
    text.quaternion.copy(camera.quaternion)
    text.scale.setScalar(fontPx * upp)
  }

  placeRingLabels(eye, camera.near, camera.far)
  placeClock(t)
  resolveLabels(layout, frame)

  for (let i = 0; i < n; i++) {
    const text = texts[i]
    if (!text) continue
    const opacity = wanted[i] * layout.shown[i]
    text.visible = opacity >= MIN_NAME_OPACITY
    if (!text.visible) continue
    text.fillOpacity = opacity
    text.outlineOpacity = opacity
    const distance = layout.distance[i] * upp
    text.position
      .fromArray(bodyAt, i * 3)
      .addScaledVector(right, layout.outX[i] * distance)
      .addScaledVector(up, layout.outY[i] * distance)
  }
}

export const BodyLabels: FC<SystemAidProps> = ({ distanceScale, ship }) =>
  ship ? null : <Labels distanceScale={distanceScale} />

function Labels({ distanceScale }: { distanceScale: DistanceScale }) {
  const texts = useRef<(TroikaText | null)[]>([])
  // A boolean, so resizing re-renders only on crossing the phone width.
  const phone = useThree((state) => state.size.width <= PHONE_VIEW_PX)

  useFrame(({ camera, size }, delta) => {
    const { timestamp, cameraFocus } = useStore.getState()
    const ortho = camera as THREE.OrthographicCamera
    if (timestamp == null || !ortho.isOrthographicCamera) return
    placeLabels(texts.current, ortho, size.height, timestamp, distanceScale, cameraFocus, phone, delta)
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
