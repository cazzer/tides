// Northern and southern lights (tides-qe5): a thin shell above the clouds,
// ray-marched in the fragment shader. The ovals follow the geomagnetic poles
// and Kp (see ../aurora.ts); with Real weather, Kp comes from NOAA SWPC (the
// last week observed, the next ~3 days forecast) or the CelesTrak archive for
// the sim time (see ../aurora-kp.ts), and near the present the ovals' extent
// and brightness follow SWPC's OVATION nowcast (see ../aurora-ovation.ts).
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  DEFAULT_KP,
  geomagneticAxis,
  OVAL_TABLE_HOURS,
  ovalTable,
  steadyGeomagneticAxis,
  sunDirectionLocal,
  swayVisibility,
} from '../aurora'
import { blendOvalTable, ovationWeight, type OvationFit } from '../aurora-ovation'
import { kpFeed } from './kpFeed'
import { ovationFeed } from './ovationFeed'
import { AURORA_GAIN } from '../lighting'
import { isLowQuality } from '../quality'
import shellVertex from '../shaders/shell/vertex.glsl'
import auroraFragment from '../shaders/aurora/fragment.frag'
import { AURORA_SHELL_OUTER } from './earth-shells'

// Shell heights as fractions of the Earth's radius. Real aurora spans ~100 to
// ~300+ km (1.6-5%); the base sits just above the cloud layer (1.02) and the
// displaced terrain, which this scene exaggerates.
const SHELL_INNER = 1.024
const SHELL_OUTER = AURORA_SHELL_OUTER
// Down to 18° latitude: rays grazing the shell enter it up to ~17° from where
// they meet a storm-time oval (≥ ~38° geographic).
const CAP_THETA = (72 * Math.PI) / 180
/** Seconds for the shown Kp to close most of the gap to a new value. */
const KP_EASE_S = 1.2
/** Seconds for the oval's daily sway to fade in or out with the time speed. */
const SWAY_EASE_S = 0.3

/** Fraction of the way to close toward a target this frame. */
function ease(delta: number, seconds: number) {
  return 1 - Math.exp(-Math.min(delta, 0.25) / seconds)
}

const noRaycast = () => null

const LOW_QUALITY = isLowQuality()

interface AuroraRendererProps {
  /** The Earth sphere's radius in scene units. */
  radius: number
}

export default function AuroraRenderer({ radius }: AuroraRendererProps) {
  const real = useStore((s) => s.weatherSource) === 'real'
  const low = LOW_QUALITY
  const kp = useRef(DEFAULT_KP)
  const tableKp = useRef(Number.NaN)
  /** The nowcast last seen, kept while its weight fades out. */
  const fit = useRef<OvationFit | null>(null)
  const nowcast = useRef(0)
  const tableFit = useRef<OvationFit | null>(null)
  const tableNowcast = useRef(Number.NaN)
  const table = useRef(new Float32Array(OVAL_TABLE_HOURS * 4))
  const lastTimestamp = useRef<number | null>(null)
  const sway = useRef(1)
  const pole = useMemo(() => new THREE.Vector3(), [])
  // Uniforms are updated through the mesh, not the memoised material.
  const mesh = useRef<THREE.Mesh>(null)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: auroraFragment,
        defines: { STEPS: low ? 10 : 24 },
        uniforms: {
          uInner: { value: 0 },
          uOuter: { value: 0 },
          uPole: { value: new THREE.Vector3(0, 1, 0) },
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uOval: {
            value: Array.from({ length: OVAL_TABLE_HOURS }, () => new THREE.Vector4()),
          },
          uKp: { value: DEFAULT_KP },
          uTime: { value: 0 },
          uGain: { value: AURORA_GAIN },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        // ACES would wash the bright folds toward white; the shader's own
        // shoulder keeps them in range.
        toneMapped: false,
      }),
    [low]
  )

  const [north, south] = useMemo(() => {
    const r = radius * SHELL_OUTER
    return [
      new THREE.SphereGeometry(r, 96, 32, 0, Math.PI * 2, 0, CAP_THETA),
      new THREE.SphereGeometry(r, 96, 32, 0, Math.PI * 2, Math.PI - CAP_THETA, CAP_THETA),
    ]
  }, [radius])

  useEffect(() => () => material.dispose(), [material])
  useEffect(
    () => () => {
      north.dispose()
      south.dispose()
    },
    [north, south]
  )
  useEffect(() => {
    if (!real) {
      kpFeed.deactivate()
      ovationFeed.deactivate()
    }
  }, [real])

  useFrame((state, delta) => {
    const { timestamp, jumpDate } = useStore.getState()
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (timestamp == null || !shader) return
    const u = shader.uniforms

    let target = DEFAULT_KP
    let nowcastTarget = 0
    if (real) {
      const jumpTo = jumpDate?.getTime() ?? null
      const wall = performance.now()
      const now = Date.now()
      target = kpFeed.tick(timestamp, jumpTo, wall, now) ?? DEFAULT_KP
      fit.current = ovationFeed.tick(timestamp, jumpTo, wall, now) ?? fit.current
      if (fit.current) nowcastTarget = ovationWeight(fit.current, jumpTo ?? timestamp)
    }
    kp.current += (target - kp.current) * ease(delta, KP_EASE_S)
    nowcast.current += (nowcastTarget - nowcast.current) * ease(delta, KP_EASE_S)
    if (nowcast.current < 0.001 && nowcastTarget === 0) nowcast.current = 0
    if (
      !(Math.abs(kp.current - tableKp.current) < 0.005) ||
      !(Math.abs(nowcast.current - tableNowcast.current) < 0.005) ||
      tableFit.current !== fit.current
    ) {
      tableKp.current = kp.current
      tableNowcast.current = nowcast.current
      tableFit.current = fit.current
      ovalTable(kp.current, table.current)
      if (fit.current && nowcast.current > 0) {
        blendOvalTable(table.current, fit.current, nowcast.current)
      }
      ;(u.uOval.value as THREE.Vector4[]).forEach((v, i) => v.fromArray(table.current, i * 4))
    }

    u.uInner.value = radius * SHELL_INNER
    u.uOuter.value = radius * SHELL_OUTER
    // Storm cues (red tops, folding) follow the nowcast's activity too.
    u.uKp.value = fit.current
      ? kp.current + nowcast.current * (fit.current.kp - kp.current)
      : kp.current
    // Wall-clock, so the shimmer runs at the same pace at any time speed.
    u.uTime.value = state.clock.elapsedTime
    sunDirectionLocal(timestamp, u.uSun.value)
    // Ease the daily sway out (and back) over a few frames rather than
    // popping when the speed changes.
    const step = lastTimestamp.current == null ? 0 : timestamp - lastTimestamp.current
    lastTimestamp.current = timestamp
    sway.current += (swayVisibility(step) - sway.current) * ease(delta, SWAY_EASE_S)
    steadyGeomagneticAxis(geomagneticAxis(timestamp, pole), sway.current, u.uPole.value)
  })

  return (
    <group>
      <mesh
        ref={mesh}
        geometry={north}
        material={material}
        renderOrder={2}
        raycast={noRaycast}
      />
      <mesh geometry={south} material={material} renderOrder={2} raycast={noRaycast} />
    </group>
  )
}
