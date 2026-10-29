// The lunar eclipse demo's shadow aid (tides-zec.13), main view only: Earth's
// umbra and penumbra as two faint circles at the Moon, square to the Sun line,
// with the Moon's dotted track across them and marks at the umbral contacts,
// so "into the shadow" shows where the shadow is and that the Moon's own orbit
// carries it through. Optionally the full Moons before and after, which miss
// it. Not a cone from Earth: in this squeezed scene every full Moon would sit
// inside one. Built once from the eclipse nearest the clock (earth-shadow.ts);
// each frame only moves and turns the group to the shadow's frame at the Moon.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, type RootState } from '@react-three/fiber'
import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { positionsFor } from '../flight-scale'
import { useStore } from '../store'
import {
  circlePoints,
  createShadowFrame,
  lunarEclipseTrack,
  shadowFrame,
  shadowRadii,
  type ShadowFrame,
} from './earth-shadow'

/** Ring width, CSS pixels. [TUNE] */
const RING_WIDTH = 1.5 // [TUNE]
const RING_SEGMENTS = 128
const UMBRA_COLOR = '#D9946A'
const UMBRA_OPACITY = 0.6 // [TUNE]
const PENUMBRA_COLOR = '#BFBBDA'
const PENUMBRA_OPACITY = 0.35 // [TUNE]
const GHOST_COLOR = '#FFFFFF'
const GHOST_OPACITY = 0.3 // [TUNE]
/** Point sizes: at most these CSS pixels, and at most these shares of the
 * drawn Moon's diameter, so far out (a phone's wide view, the Moon a few
 * pixels) they shrink with it rather than burying it, and the 5-minute dots
 * stay apart. [TUNE] */
const TRACK_SIZE = 2.5 // [TUNE]
const TRACK_SHARE = 0.06 // [TUNE]
const TRACK_COLOR = '#FFFFFF'
const TRACK_OPACITY = 0.5 // [TUNE]
const TICK_SIZE = 6 // [TUNE]
const TICK_SHARE = 0.25 // [TUNE]
const TICK_COLOR = '#E8C25A'
const TICK_OPACITY = 0.9 // [TUNE]

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

function ringMaterial(color: string, opacity: number): LineMaterial {
  return new LineMaterial({
    color,
    linewidth: RING_WIDTH,
    transparent: true,
    opacity,
    depthWrite: false,
    // One endless dash, as Trails.tsx: drops the round caps, which overlap at
    // every join and read as beads at this opacity.
    dashed: true,
    dashSize: 1e9,
    gapSize: 0,
  })
}

// Round: PointsMaterial draws squares, which read as blocks at the ticks' size.
function roundPoints(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <clipping_planes_fragment>',
    '#include <clipping_planes_fragment>\nif (length(gl_PointCoord - 0.5) > 0.5) discard;'
  )
}

function pointsMaterial(color: string, opacity: number): THREE.PointsMaterial {
  const material = new THREE.PointsMaterial({
    color,
    transparent: true,
    opacity,
    sizeAttenuation: false,
    depthWrite: false,
  })
  material.onBeforeCompile = roundPoints
  material.customProgramCacheKey = () => 'earth-shadow-round-point'
  return material
}

function noRaycast() {}

function ring(geometry: LineGeometry, material: LineMaterial, x = 0, y = 0): Line2 {
  const line = new Line2(geometry, material)
  line.computeLineDistances()
  line.position.set(x, y, 0)
  line.raycast = noRaycast
  return line
}

function points(positions: Float32Array, material: THREE.PointsMaterial): THREE.Points {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const object = new THREE.Points(geometry, material)
  object.raycast = noRaycast
  return object
}

interface Shadow {
  frame: ShadowFrame
  rings: Line2[]
  ghosts: Line2[]
  track: THREE.Points | null
  ticks: THREE.Points | null
  geometries: THREE.BufferGeometry[]
  lineMaterials: LineMaterial[]
  pointMaterials: THREE.PointsMaterial[]
  /** Sim time the group was last placed for. */
  placedT: number | null
}

function createShadow(t: number): Shadow {
  const { umbra, penumbra } = shadowRadii(t)
  const eclipse = lunarEclipseTrack(t)
  const umbraGeometry = new LineGeometry().setPositions(circlePoints(umbra, RING_SEGMENTS))
  const penumbraGeometry = new LineGeometry().setPositions(circlePoints(penumbra, RING_SEGMENTS))
  const moonGeometry = new LineGeometry().setPositions(circlePoints(1, RING_SEGMENTS))
  const lineMaterials = [
    ringMaterial(UMBRA_COLOR, UMBRA_OPACITY),
    ringMaterial(PENUMBRA_COLOR, PENUMBRA_OPACITY),
    ringMaterial(GHOST_COLOR, GHOST_OPACITY),
  ]
  const pointMaterials = [
    pointsMaterial(TRACK_COLOR, TRACK_OPACITY),
    pointsMaterial(TICK_COLOR, TICK_OPACITY),
  ]
  const track = eclipse && points(eclipse.track, pointMaterials[0])
  const ticks = eclipse && points(eclipse.ticks, pointMaterials[1])
  return {
    frame: createShadowFrame(),
    rings: [ring(umbraGeometry, lineMaterials[0]), ring(penumbraGeometry, lineMaterials[1])],
    ghosts: (eclipse?.ghosts ?? []).map(([x, y]) => ring(moonGeometry, lineMaterials[2], x, y)),
    track,
    ticks,
    geometries: [
      umbraGeometry,
      penumbraGeometry,
      moonGeometry,
      ...[track, ticks].flatMap((p) => (p ? [p.geometry] : [])),
    ],
    lineMaterials,
    pointMaterials,
    placedT: null,
  }
}

const basis = new THREE.Matrix4()
const moonAt = new THREE.Vector3()

// Module level, so the memoised shadow is mutated outside the hook.
function follow(shadow: Shadow, group: THREE.Group | null, t: number, state: RootState) {
  if (!group) return
  const system = positionsFor('system')
  moonAt.fromArray(system.positionAt.moon(t))
  // The Sun line and the Moon only move with the clock (paused steps too).
  if (shadow.placedT !== t) {
    const { axis, north, east, centre } = shadowFrame(t, shadow.frame)
    group.position.copy(moonAt).add(centre)
    group.quaternion.setFromRotationMatrix(basis.makeBasis(east, north, axis))
    shadow.placedT = t
  }
  // PointsMaterial sizes are device pixels.
  const pixelRatio = state.gl.getPixelRatio()
  const camera = state.camera as THREE.PerspectiveCamera
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2)
  const moonDiameter =
    (system.radius.moon / (camera.position.distanceTo(moonAt) * Math.tan(halfFov))) *
    state.size.height *
    pixelRatio
  shadow.pointMaterials[0].size = Math.min(TRACK_SIZE * pixelRatio, TRACK_SHARE * moonDiameter)
  shadow.pointMaterials[1].size = Math.min(TICK_SIZE * pixelRatio, TICK_SHARE * moonDiameter)
}

interface EarthShadowProps {
  /** Also the full Moons before and after the eclipse, beside the shadow. */
  ghosts: boolean
}

export function EarthShadow({ ghosts }: EarthShadowProps) {
  const shadow = useMemo(() => createShadow(simTime()), [])
  const group = useRef<THREE.Group>(null)

  useEffect(
    () => () => {
      for (const geometry of shadow.geometries) geometry.dispose()
      for (const material of [...shadow.lineMaterials, ...shadow.pointMaterials]) material.dispose()
    },
    [shadow]
  )

  useFrame((state) => follow(shadow, group.current, simTime(), state))

  return (
    <group ref={group}>
      {shadow.rings.map((line) => (
        <primitive key={line.id} object={line} />
      ))}
      {ghosts &&
        shadow.ghosts.map((line) => (
          <primitive key={line.id} object={line} />
        ))}
      {shadow.track && <primitive object={shadow.track} />}
      {shadow.ticks && <primitive object={shadow.ticks} />}
    </group>
  )
}
