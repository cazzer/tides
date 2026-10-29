// The tides demo's field aid (tides-zec.4), main view only: the sea's
// equilibrium shape as a translucent shell over the globe, its heights drawn
// TIDE_EXAGGERATION times, its outline in the Moon's orbit plane drawn
// bright over a dashed circle at mean sea level, and a ring of arrows in
// that plane at the limb showing the Moon's tidal pull (violet), the Sun's
// (gold) and their sum (white), with small discs past the ring toward the
// Moon and the Sun; the sums are tides-field.ts. With aids.tidesSun off, the
// shell, the outline and the arrows are the Moon's alone, and the Sun's
// arrows, the sum and the Sun's disc are hidden. It is in an inertial frame centred on
// Earth, moved with it each frame like MoonOrbitTilt: the bulges point at
// the Moon and Sun, not with the spin.
// Everything is rebuilt in place only when the clock has moved or the Sun
// has been turned on or off.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { positionsFor } from '../flight-scale'
import { CLOUD_UNDER_AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { useStore } from '../store'
import { useDemoAid } from './demo-aids'
import {
  ARROW_POINTS,
  arrowLength,
  OUTLINE_POINTS,
  outlineVertices,
  ringArrows,
  ringFrame,
  ringPoint,
  shellVertices,
  TIDES_MOON_COLOR,
  TIDES_SUN_COLOR,
} from './tides-field'
import { moonAlone, sceneTideDirections, tidePulls } from './tides'

// Sizes are × Earth's radius.
const SHELL_COLOR = '#2F8CFF'
const SHELL_OPACITY = 0.28 // [TUNE]
const SHELL_SEGMENTS: [number, number] = [128, 64]
const SHELL_BOUND = 1.35

const THIN_WIDTH = 0.015
const SUM_WIDTH = 0.03
const HEAD_WIDTH = 2.5 // × the shaft's
const THIN_HEAD = 0.07
const SUM_HEAD = 0.1
const HEAD_SHARE = 0.6 // of the arrow, at most
const MIN_ARROW = 1e-4
// The mean sea level's dashed circle.
const RING_WIDTH = 0.012
const RING_DASHES = 60
const RING_OPACITY = 0.45 // [TUNE]
const OUTLINE_WIDTH = 0.02
const OUTLINE_COLOR = '#7CC4FF'
const MARKER_SIZE = 0.05
// Past the ring, clear of the marked spot's halo on the globe's edge and of
// the sea's outline, which reaches ~1.3 at the king tide; the arrows draw
// over them.
const MARKER_LIFT = 1.4 // [TUNE]

const SUM_COLOR = '#FFFFFF'

// Over the globe's additive air, aurora and cloud shells, under the labels.
// The Moon's and Sun's arrows draw over the white sum, so a colour still
// shows where one lies along it.
const SHELL_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.5
const RING_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.6
const OUTLINE_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.62
const SUM_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.7
const MOON_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.8
const SUN_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.9

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

function noRaycast() {}

// Drawn over the globe: arrows pointing in lie inside it. The flat marker
// discs are seen from either side.
function overlayMaterial(color: string, opacity = 1, side: THREE.Side = THREE.FrontSide) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    toneMapped: false,
    depthWrite: false,
    depthTest: false,
    side,
  })
}

interface ArrowSet {
  shaft: THREE.InstancedMesh
  head: THREE.InstancedMesh
  width: number
  headLength: number
}

interface Field {
  shell: THREE.BufferGeometry
  /** The shell's unit vertex directions. */
  directions: Float32Array
  shellMaterial: THREE.MeshBasicMaterial
  ring: THREE.BufferGeometry
  outline: THREE.BufferGeometry
  marker: THREE.CircleGeometry
  shaftGeometry: THREE.CylinderGeometry
  headGeometry: THREE.ConeGeometry
  materials: Record<'ring' | 'outline' | 'moon' | 'sun' | 'sum' | 'moonMarker' | 'sunMarker', THREE.MeshBasicMaterial>
  arrows: { moon: ArrowSet; sun: ArrowSet; sum: ArrowSet }
  /** Sim time the field was last built for, and whether with the Sun. */
  builtAt: number
  builtSun: boolean
}

// A flat circle of `dashes` dashes `width` wide about +Z, its outer edge at
// `radius`.
function dashedRing(radius: number, width: number, dashes: number): THREE.BufferGeometry {
  const steps = 4
  const positions: number[] = []
  const index: number[] = []
  for (let d = 0; d < dashes; d++) {
    const base = positions.length / 3
    for (let k = 0; k <= steps; k++) {
      const a = ((d + (0.5 * k) / steps) / dashes) * 2 * Math.PI
      for (const r of [radius - width, radius]) positions.push(Math.cos(a) * r, Math.sin(a) * r, 0)
    }
    for (let k = 0; k < steps; k++) {
      const i = base + 2 * k
      index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2)
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)).setIndex(index)
}

// A ribbon of OUTLINE_POINTS (inner, outer) pairs, closed; outlineVertices
// fills it.
function outlineRibbon(): THREE.BufferGeometry {
  const position = new THREE.BufferAttribute(new Float32Array(OUTLINE_POINTS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage)
  const index: number[] = []
  for (let j = 0; j < OUTLINE_POINTS; j++) {
    const i = 2 * j
    const n = (2 * (j + 1)) % (2 * OUTLINE_POINTS)
    index.push(i, i + 1, n, i + 1, n + 1, n)
  }
  return new THREE.BufferGeometry().setAttribute('position', position).setIndex(index)
}

function arrowSet(field: Pick<Field, 'shaftGeometry' | 'headGeometry'>, material: THREE.Material, width: number, headLength: number, order: number): ArrowSet {
  const shaft = new THREE.InstancedMesh(field.shaftGeometry, material, ARROW_POINTS)
  const head = new THREE.InstancedMesh(field.headGeometry, material, ARROW_POINTS)
  for (const mesh of [shaft, head]) {
    mesh.renderOrder = order
    mesh.frustumCulled = false
    mesh.raycast = noRaycast
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }
  return { shaft, head, width, headLength }
}

function createField(radius: number): Field {
  const shell = new THREE.SphereGeometry(1, ...SHELL_SEGMENTS)
  const directions = Float32Array.from((shell.getAttribute('position') as THREE.BufferAttribute).array)
  ;(shell.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
  // White, with the fade in alpha: three reads a 4-wide colour's alpha.
  const colors = new THREE.BufferAttribute(new Float32Array((directions.length / 3) * 4), 4)
  shell.setAttribute('color', colors.setUsage(THREE.DynamicDrawUsage))
  shell.deleteAttribute('normal')
  shell.deleteAttribute('uv')
  shell.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHELL_BOUND * radius)
  // A unit cylinder and cone standing on the origin, up +Y.
  const shaftGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1).translate(0, 0.5, 0)
  const headGeometry = new THREE.ConeGeometry(0.5, 1, 12, 1).translate(0, 0.5, 0)
  const materials = {
    ring: overlayMaterial('#FFFFFF', RING_OPACITY, THREE.DoubleSide),
    outline: overlayMaterial(OUTLINE_COLOR, 1, THREE.DoubleSide),
    moon: overlayMaterial(TIDES_MOON_COLOR),
    sun: overlayMaterial(TIDES_SUN_COLOR),
    sum: overlayMaterial(SUM_COLOR),
    moonMarker: overlayMaterial(TIDES_MOON_COLOR, 1, THREE.DoubleSide),
    sunMarker: overlayMaterial(TIDES_SUN_COLOR, 1, THREE.DoubleSide),
  }
  const parts = { shaftGeometry, headGeometry }
  return {
    shell,
    directions,
    shellMaterial: new THREE.MeshBasicMaterial({
      color: SHELL_COLOR,
      transparent: true,
      opacity: SHELL_OPACITY,
      toneMapped: false,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
    }),
    ring: dashedRing(radius, RING_WIDTH * radius, RING_DASHES),
    outline: outlineRibbon(),
    marker: new THREE.CircleGeometry(MARKER_SIZE * radius, 24),
    ...parts,
    materials,
    arrows: {
      moon: arrowSet(parts, materials.moon, THIN_WIDTH * radius, THIN_HEAD * radius, MOON_ORDER),
      sun: arrowSet(parts, materials.sun, THIN_WIDTH * radius, THIN_HEAD * radius, SUN_ORDER),
      sum: arrowSet(parts, materials.sum, SUM_WIDTH * radius, SUM_HEAD * radius, SUM_ORDER),
    },
    builtAt: NaN,
    builtSun: false,
  }
}

function disposeField(field: Field) {
  for (const geometry of [field.shell, field.ring, field.outline, field.marker, field.shaftGeometry, field.headGeometry])
    geometry.dispose()
  field.shellMaterial.dispose()
  for (const material of Object.values(field.materials)) material.dispose()
  for (const set of Object.values(field.arrows)) {
    set.shaft.dispose()
    set.head.dispose()
  }
}

const _moon = new THREE.Vector3()
const _sun = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _side = new THREE.Vector3()
const _point = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _sum = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _at = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _turn = new THREE.Quaternion()
const _matrix = new THREE.Matrix4()
const _up = new THREE.Vector3(0, 1, 0)
const _z = new THREE.Vector3(0, 0, 1)
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0)

function placeArrow(set: ArrowSet, i: number, base: THREE.Vector3, vector: THREE.Vector3, radius: number) {
  const length = arrowLength(vector, radius)
  if (length < MIN_ARROW * radius) {
    set.shaft.setMatrixAt(i, _hidden)
    set.head.setMatrixAt(i, _hidden)
    return
  }
  _dir.copy(vector).normalize()
  _turn.setFromUnitVectors(_up, _dir)
  const head = Math.min(set.headLength, HEAD_SHARE * length)
  const headWidth = HEAD_WIDTH * set.width
  _scale.set(set.width, length - head, set.width)
  set.shaft.setMatrixAt(i, _matrix.compose(base, _turn, _scale))
  _at.copy(base).addScaledVector(_dir, length - head)
  _scale.set(headWidth, head, headWidth)
  set.head.setMatrixAt(i, _matrix.compose(_at, _turn, _scale))
}

// Module level, so the memoised field is mutated outside the hook.
function build(field: Field, objects: FieldObjects, t: number, radius: number, withSun: boolean) {
  const pulls = withSun ? tidePulls(t) : moonAlone(tidePulls(t))
  sceneTideDirections(t, _moon, _sun)

  const position = field.shell.getAttribute('position') as THREE.BufferAttribute
  const color = field.shell.getAttribute('color') as THREE.BufferAttribute
  shellVertices(field.directions, _moon, _sun, pulls, radius, position.array as Float32Array, color.array as Float32Array)
  position.needsUpdate = true
  color.needsUpdate = true

  // The ring in the Moon's orbit plane, through the Moon's direction.
  ringFrame(t, _moon, _normal, _side)
  const normal = _normal
  const outline = field.outline.getAttribute('position') as THREE.BufferAttribute
  outlineVertices(_moon, _side, _sun, pulls, radius, OUTLINE_WIDTH * radius, outline.array as Float32Array)
  outline.needsUpdate = true
  const { moon, sun, sum } = field.arrows
  for (let j = 0; j < ARROW_POINTS; j++) {
    ringPoint(j, _moon, _side, _point)
    ringArrows(_point, _moon, _sun, pulls, _a, _b, _sum)
    _point.multiplyScalar(radius)
    placeArrow(moon, j, _point, _a, radius)
    placeArrow(sun, j, _point, _b, radius)
    placeArrow(sum, j, _point, _sum, radius)
  }
  for (const set of [moon, sun, sum]) {
    set.shaft.instanceMatrix.needsUpdate = true
    set.head.instanceMatrix.needsUpdate = true
  }
  // The Moon's arrows alone are its sum.
  for (const mesh of [sun.shaft, sun.head, sum.shaft, sum.head]) mesh.visible = withSun
  if (objects.sunMarker) objects.sunMarker.visible = withSun

  if (objects.ring) objects.ring.quaternion.setFromUnitVectors(_z, normal)
  if (objects.moonMarker) placeMarker(objects.moonMarker, _moon, normal, radius)
  // The Sun's direction laid into the plane.
  _dir.copy(_sun).addScaledVector(normal, -_sun.dot(normal)).normalize()
  if (objects.sunMarker) placeMarker(objects.sunMarker, _dir, normal, radius)
  field.builtAt = t
  field.builtSun = withSun
}

// A disc just past the ring, lying in the plane.
function placeMarker(marker: THREE.Mesh, direction: THREE.Vector3, normal: THREE.Vector3, radius: number) {
  marker.position.copy(direction).multiplyScalar(MARKER_LIFT * radius)
  marker.quaternion.setFromUnitVectors(_z, normal)
}

interface FieldObjects {
  ring: THREE.Mesh | null
  moonMarker: THREE.Mesh | null
  sunMarker: THREE.Mesh | null
}

function follow(field: Field, group: THREE.Group | null, objects: FieldObjects, t: number, radius: number, withSun: boolean) {
  if (!group) return
  group.position.fromArray(positionsFor('system').positionAt.earth(t))
  if (t !== field.builtAt || withSun !== field.builtSun) build(field, objects, t, radius, withSun)
}

export function TidesField({ radius }: { radius: number }) {
  const field = useMemo(() => createField(radius), [radius])
  const withSun = useDemoAid('tidesSun')
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const moonMarker = useRef<THREE.Mesh>(null)
  const sunMarker = useRef<THREE.Mesh>(null)
  // The refs themselves hold their meshes; built once, read each frame.
  const objects = useMemo<FieldObjects>(
    () => ({
      get ring() {
        return ring.current
      },
      get moonMarker() {
        return moonMarker.current
      },
      get sunMarker() {
        return sunMarker.current
      },
    }),
    []
  )

  useEffect(() => () => disposeField(field), [field])

  useFrame(() => follow(field, group.current, objects, simTime(), radius, withSun))

  const { moon, sun, sum } = field.arrows
  return (
    <group ref={group}>
      <mesh
        renderOrder={SHELL_ORDER}
        frustumCulled={false}
        geometry={field.shell}
        material={field.shellMaterial}
        raycast={noRaycast}
      />
      <mesh ref={ring} renderOrder={RING_ORDER} geometry={field.ring} material={field.materials.ring} raycast={noRaycast} />
      <mesh
        renderOrder={OUTLINE_ORDER}
        frustumCulled={false}
        geometry={field.outline}
        material={field.materials.outline}
        raycast={noRaycast}
      />
      <mesh
        ref={moonMarker}
        renderOrder={RING_ORDER}
        geometry={field.marker}
        material={field.materials.moonMarker}
        raycast={noRaycast}
      />
      <mesh
        ref={sunMarker}
        renderOrder={RING_ORDER}
        geometry={field.marker}
        material={field.materials.sunMarker}
        raycast={noRaycast}
      />
      <primitive object={sum.shaft} />
      <primitive object={sum.head} />
      <primitive object={moon.shaft} />
      <primitive object={moon.head} />
      <primitive object={sun.shaft} />
      <primitive object={sun.head} />
    </group>
  )
}
