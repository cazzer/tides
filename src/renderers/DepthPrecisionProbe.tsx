import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import {
  collectDepthReport,
  DEPTH_INFO,
  depthPrecision,
  probeDepthPrecision,
  setDepthPrecision,
  setDepthReport,
} from './depth-precision'

/**
 * Probes what the default framebuffer's depth buffer stores (tides-zmw.9.4,
 * depth-precision.ts), once per page, before the first frame: one small
 * draw and readback (a few ms), nothing per frame. Under ?depth=info it also
 * probes the reference render targets for the readout (DepthInfo). The
 * format is a property of the device, so a restored context isn't re-probed.
 * Mount once in the root Canvas, outside the Views.
 */
export function DepthPrecisionProbe() {
  const gl = useThree((s) => s.gl)
  useLayoutEffect(() => {
    if (depthPrecision()) return
    const result = probeDepthPrecision(gl)
    setDepthPrecision(result)
    if (DEPTH_INFO) setDepthReport(collectDepthReport(gl, result))
  }, [gl])
  return null
}
