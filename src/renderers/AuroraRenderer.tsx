// Northern and southern lights (tides-qe5): a thin shell above the clouds,
// ray-marched in the fragment shader. The ovals follow the geomagnetic poles
// and Kp (see ../aurora.ts); with Real weather, Kp comes from NOAA SWPC or the
// CelesTrak archive for the sim time (see ../aurora-kp.ts).
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  DEFAULT_KP,
  geomagneticAxis,
  OVAL_TABLE_HOURS,
  ovalTable,
  sunDirectionLocal,
} from '../aurora'
import { kpFeed } from './kpFeed'
import shellVertex from '../shaders/shell/vertex.glsl'
import auroraFragment from '../shaders/aurora/fragment.frag'

// Shell heights as fractions of the Earth's radius. Real aurora spans ~100 to
// ~300+ km (1.6-5%); the base sits just above the cloud layer (1.02) and the
// displaced terrain, which this scene exaggerates.
const SHELL_INNER = 1.024
const SHELL_OUTER = 1.07
// Down to 18° latitude: rays grazing the shell enter it up to ~17° from where
// they meet a storm-time oval (≥ ~38° geographic).
const CAP_THETA = (72 * Math.PI) / 180
/** Seconds for the shown Kp to close most of the gap to a new value. */
const KP_EASE_S = 1.2

function useLowQuality() {
  return useMemo(() => {
    if (typeof window === 'undefined') return false
    const q = new URLSearchParams(window.location.search).get('quality')
    if (q === 'low') return true
    if (q === 'high') return false
    return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  }, [])
}

const noRaycast = () => null

interface AuroraRendererProps {
  /** The Earth sphere's radius in scene units. */
  radius: number
}

export default function AuroraRenderer({ radius }: AuroraRendererProps) {
  const real = useStore((s) => s.weatherSource) === 'real'
  const low = useLowQuality()
  const kp = useRef(DEFAULT_KP)
  const tableKp = useRef(Number.NaN)
  const table = useRef(new Float32Array(OVAL_TABLE_HOURS * 4))
  // Uniforms are updated through the mesh, not the memoised material.
  const mesh = useRef<THREE.Mesh>(null)

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: auroraFragment,
        defines: { STEPS: low ? 8 : 16 },
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
          uGain: { value: 3 },
          uVeil: { value: 1.8 },
        },
        transparent: true,
        depthWrite: false,
        // Premultiplied "over": see the end of the fragment shader.
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
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
    if (!real) kpFeed.deactivate()
  }, [real])

  useFrame((state, delta) => {
    const { timestamp, jumpDate } = useStore.getState()
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (timestamp == null || !shader) return
    const u = shader.uniforms

    let target = DEFAULT_KP
    if (real) {
      target =
        kpFeed.tick(timestamp, jumpDate?.getTime() ?? null, performance.now(), Date.now()) ??
        DEFAULT_KP
    }
    kp.current += (target - kp.current) * (1 - Math.exp(-Math.min(delta, 0.25) / KP_EASE_S))
    if (!(Math.abs(kp.current - tableKp.current) < 0.005)) {
      tableKp.current = kp.current
      ovalTable(kp.current, table.current)
      ;(u.uOval.value as THREE.Vector4[]).forEach((v, i) => v.fromArray(table.current, i * 4))
    }

    u.uInner.value = radius * SHELL_INNER
    u.uOuter.value = radius * SHELL_OUTER
    u.uKp.value = kp.current
    u.uTime.value = state.clock.elapsedTime
    sunDirectionLocal(timestamp, u.uSun.value)
    geomagneticAxis(timestamp, u.uPole.value)
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
