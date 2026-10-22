// Moon orbit lines (tides-2hv.9), mounted by SystemAids.tsx while
// systemAids.orbits is on: Earth's Moon and every moon in moons.ts.
//
// One LineSegments per parent holds all its moons' loops, built relative to
// the parent's centre (orbit-guides.ts) and moved to the parent's live
// position each frame, so the lines need no rebuild to follow the planet.
// A set is rebuilt in place only when its orbits' planes may have drifted
// (ORBIT_GUIDE_REFRESH_DAYS), never per frame, and fades out once it is too
// small on screen to read: zoomed out to the whole system, Mars' and
// Jupiter's moons would only thicken their planet's dot.
//
// Ship mode shows them too, round the planets at flight spacing: the moons
// keep their parent-relative orbits at both scales, so the same lines serve,
// and the fade measures them through the perspective camera.
import { createRef, useEffect, useMemo, type FC, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { DistanceScale } from '../distance-scale'
import { positionsFor } from '../flight-scale'
import { useStore } from '../store'
import {
  GUIDE_PARENTS,
  MOON_ORBIT_SEGMENTS,
  guideExtent,
  guideLoopCount,
  loopIndices,
  orbitGuideFade,
  orbitGuideIsStale,
  writeGuidePaths,
  type GuideParent,
} from './orbit-guides'
import { worldUnitsPerPixel } from './pixel-scale'
import type { SystemAidProps } from './types'

/** The planet orbits' lilac (planet-orbits.tsx). */
const MOON_ORBIT_COLOR = '#BFBBDA'
/**
 * Moon orbit opacity at full strength. [TUNE] Under the planet orbits' 0.2,
 * so a planet's own path still reads first through its moons' rings.
 */
export const MOON_ORBIT_OPACITY = 0.14 // [TUNE]

// Unset until SimClock's first frame, which starts from Date.now().
function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

interface Guide {
  parent: GuideParent
  geometry: THREE.BufferGeometry
  material: THREE.LineBasicMaterial
  /** Sim time the lines were last built for. */
  pathT: number
}

function createGuide(parent: GuideParent, t: number): Guide {
  const loops = guideLoopCount(parent)
  const positions = new Float32Array(loops * MOON_ORBIT_SEGMENTS * 3)
  writeGuidePaths(parent, t, MOON_ORBIT_SEGMENTS, positions)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(loopIndices(loops, MOON_ORBIT_SEGMENTS), 1))
  geometry.computeBoundingSphere()
  const material = new THREE.LineBasicMaterial({
    color: MOON_ORBIT_COLOR,
    transparent: true,
    opacity: MOON_ORBIT_OPACITY,
    depthWrite: false,
  })
  return { parent, geometry, material, pathT: t }
}

function rebuild(guide: Guide, t: number) {
  const position = guide.geometry.getAttribute('position') as THREE.BufferAttribute
  writeGuidePaths(guide.parent, t, MOON_ORBIT_SEGMENTS, position.array as Float32Array)
  position.needsUpdate = true
  guide.geometry.computeBoundingSphere()
  guide.pathT = t
}

// Module level, so the memoised guides are mutated outside the hook: each set
// follows its parent, rebuilds if stale and fades by its size on screen.
function updateGuides(
  guides: readonly Guide[],
  lines: readonly RefObject<THREE.LineSegments | null>[],
  t: number,
  scale: DistanceScale,
  camera: THREE.Camera,
  heightPx: number
) {
  const { positionAt } = positionsFor(scale)
  for (let i = 0; i < guides.length; i++) {
    const guide = guides[i]
    const line = lines[i].current
    if (!line) continue
    line.position.fromArray(positionAt[guide.parent](t))
    const extentPx = guideExtent(guide.parent) / worldUnitsPerPixel(camera, line.position, heightPx)
    const strength = orbitGuideFade(extentPx)
    line.visible = strength > 0
    guide.material.opacity = MOON_ORBIT_OPACITY * strength
    // A hidden set catches up when it next shows.
    if (line.visible && orbitGuideIsStale(guide.parent, guide.pathT, t)) rebuild(guide, t)
  }
}

function noRaycast() {}

export const OrbitGuides: FC<SystemAidProps> = ({ distanceScale }) => {
  const guides = useMemo(() => {
    const t = simTime()
    return GUIDE_PARENTS.map((parent) => createGuide(parent, t))
  }, [])
  const lines = useMemo(() => GUIDE_PARENTS.map(() => createRef<THREE.LineSegments>()), [])

  useEffect(
    () => () => {
      for (const { geometry, material } of guides) {
        geometry.dispose()
        material.dispose()
      }
    },
    [guides]
  )

  useFrame(({ camera, size }) =>
    updateGuides(guides, lines, simTime(), distanceScale, camera, size.height)
  )

  return (
    <>
      {guides.map(({ parent, geometry, material }, i) => (
        <lineSegments
          key={parent}
          ref={lines[i]}
          geometry={geometry}
          material={material}
          raycast={noRaycast}
        />
      ))}
    </>
  )
}
