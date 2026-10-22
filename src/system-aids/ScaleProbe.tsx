// Measures the main view's camera each frame and publishes it to scaleProbe
// (scale-probe.ts) for ScaleReadout, a DOM overlay that can't see the camera
// (tides-2hv.10). Mounted by SystemAids.tsx while systemAids.scale is on,
// outside ship mode.
import { useEffect, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import { measureScale, resetScaleProbe } from './scale-probe'
import type { SystemAidProps } from './types'

export const ScaleProbe: FC<SystemAidProps> = () => {
  useEffect(() => resetScaleProbe, [])
  useFrame(({ camera, size }) => measureScale(camera, size.height))
  return null
}
