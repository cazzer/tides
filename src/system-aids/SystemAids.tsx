// The system view's spatial aids (tides-2hv), each in its own file and owned
// by its own bead, so they can be built in parallel. SolarSystem mounts this
// beside the planets, in the orbital views only.
import { useStore } from '../store'
import { BodyLabels } from './BodyLabels'
import { Belts } from './Belts'
import { EclipticGrid } from './EclipticGrid'
import { OrbitGuides } from './OrbitGuides'
import { Trails } from './Trails'
import type { SystemAidProps } from './types'

export function SystemAids({ distanceScale, ship }: SystemAidProps) {
  const aids = useStore((s) => s.systemAids)
  const props = { distanceScale, ship }
  return (
    <>
      {aids.orbits && <OrbitGuides {...props} />}
      {aids.grid && <EclipticGrid {...props} />}
      {aids.labels && <BodyLabels {...props} />}
      {aids.belts && <Belts {...props} />}
      {aids.trails && <Trails {...props} />}
    </>
  )
}
