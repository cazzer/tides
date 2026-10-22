// The system view's spatial aids (tides-2hv), each in its own file and owned
// by its own bead, so they can be built in parallel. SolarSystem mounts this
// beside the planets, in the orbital views only.
import { Suspense } from 'react'
import { useStore } from '../store'
import { BodyLabels } from './BodyLabels'
import { Belts } from './Belts'
import { EclipticGrid } from './EclipticGrid'
import { OrbitGuides } from './OrbitGuides'
import { ScaleProbe } from './ScaleProbe'
import { Trails } from './Trails'
import type { SystemAidProps } from './types'

export function SystemAids({ distanceScale, ship }: SystemAidProps) {
  const aids = useStore((s) => s.systemAids)
  const props = { distanceScale, ship }
  // One Suspense each, so an aid that loads (a font, a texture) never blanks
  // the others.
  return (
    <>
      {aids.orbits && (
        <Suspense fallback={null}>
          <OrbitGuides {...props} />
        </Suspense>
      )}
      {aids.grid && (
        <Suspense fallback={null}>
          <EclipticGrid {...props} />
        </Suspense>
      )}
      {aids.labels && (
        <Suspense fallback={null}>
          <BodyLabels {...props} />
        </Suspense>
      )}
      {aids.belts && (
        <Suspense fallback={null}>
          <Belts {...props} />
        </Suspense>
      )}
      {aids.trails && (
        <Suspense fallback={null}>
          <Trails {...props} />
        </Suspense>
      )}
      {/* The readout lives in the main Panel, which ship mode unmounts. */}
      {aids.scale && !ship && (
        <Suspense fallback={null}>
          <ScaleProbe {...props} />
        </Suspense>
      )}
    </>
  )
}
