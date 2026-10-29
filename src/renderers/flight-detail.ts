// Whether a View draws Earth with flight mode's detail (tides-tvr.7.3): the
// GIBS imagery patches and the night flight's eye. In ship mode, as ever; in
// the system view, while close zoom feeds the limb view Earth from this
// View's camera (close-zoom.ts), so the overview panels, whose cameras the
// view wasn't fed for, keep the day's look.
import { useSyncExternalStore } from 'react'
import { useThree } from '@react-three/fiber'
import type * as THREE from 'three'
import { useStore } from '../store'
import { limbBody, limbEye, subscribeLimbBody } from '../ship/limb-detail'

/** The rule: ship mode, or Earth the limb body (`limbKey`) for `camera`. */
export function flightDetail(
  shipMode: boolean,
  limbKey: string | null,
  limbCamera: THREE.Camera | null,
  camera: THREE.Camera
): boolean {
  return shipMode || (limbKey === 'earth' && limbCamera === camera)
}

/** flightDetail() for this View's camera; re-renders when it changes. */
export function useFlightDetail(): boolean {
  const shipMode = useStore((s) => s.shipMode)
  const camera = useThree((s) => s.camera)
  const nearEarth = useSyncExternalStore(subscribeLimbBody, () =>
    flightDetail(false, limbBody(), limbEye(), camera)
  )
  return shipMode || nearEarth
}
