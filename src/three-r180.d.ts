// three r180's reversed depth buffer (tides-zmw.9.3), which @types/three
// 0.167 predates. Drop this once @types/three catches up.
import 'three'

declare module 'three/src/renderers/WebGLRenderer.js' {
  interface WebGLRendererParameters {
    /** Reversed-Z, where the context has EXT_clip_control; standard depth otherwise. */
    reversedDepthBuffer?: boolean | undefined
  }
}

declare module 'three/src/renderers/webgl/WebGLCapabilities.js' {
  interface WebGLCapabilities {
    /** True when reversedDepthBuffer was asked for and EXT_clip_control is there. */
    readonly reversedDepthBuffer: boolean
  }
}

declare module 'three/src/renderers/webgl/WebGLState.js' {
  interface WebGLDepthBuffer {
    getReversed(): boolean
  }
}

declare module 'three/src/cameras/Camera.js' {
  interface Camera {
    /** Set by WebGLRenderer on a reversed-depth context's first draw. */
    readonly reversedDepth: boolean
  }
}
