import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Vector3, type Object3D } from 'three'
import { useStore } from '../store'
import {
  createExitWatch,
  geoPose,
  loadExitReport,
  navigationType,
  sessionStore,
  watchedCamera,
  type ExitSnapshot,
} from '../exit-watch'

interface PerformanceMemory {
  usedJSHeapSize: number
  jsHeapSizeLimit: number
}

const MB = 1024 * 1024
const eye = new Vector3()
const look = new Vector3()

/**
 * The unclean-exit heartbeat (tides-8h7.4, exit-watch.ts): the pose of the
 * watched camera, the dpr, the canvas and GL memory every 2 s while the page
 * is visible. Mount once in the root Canvas.
 */
export function ExitWatch() {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    // Before this load's first heartbeat overwrites the last load's.
    loadExitReport()
    const snapshot = (): ExitSnapshot => {
      const state = useStore.getState()
      const camera = watchedCamera()
      const earth = state.earth?.current as Object3D | null | undefined
      const pose =
        camera && earth && state.earthRadius != null
          ? geoPose(camera.getWorldPosition(eye), camera.getWorldDirection(look), earth, state.earthRadius)
          : null
      const memory = (performance as Performance & { memory?: PerformanceMemory }).memory
      const canvas = gl.domElement
      return {
        view: {
          focus: state.cameraFocus,
          closeZoom: state.closeZoom,
          closeZoomTiles: state.closeZoomTiles,
          ship: state.shipMode,
          demo: state.demo?.id ?? null,
        },
        pose,
        dpr: gl.getPixelRatio(),
        canvas: [canvas.width, canvas.height],
        mem: {
          textures: gl.info.memory.textures,
          geometries: gl.info.memory.geometries,
          programs: gl.info.programs?.length ?? 0,
          ...(memory && {
            jsHeapMB: Math.round(memory.usedJSHeapSize / MB),
            jsLimitMB: Math.round(memory.jsHeapSizeLimit / MB),
          }),
        },
        ctxLost: gl.getContext().isContextLost(),
      }
    }
    return createExitWatch({
      storage: sessionStore(),
      doc: document,
      win: window,
      now: Date.now,
      snapshot,
      sha: __BUILD_SHA__,
      navType: navigationType(),
    })
  }, [gl])

  return null
}
