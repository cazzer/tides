// GPU time per frame (tides-nlk) from EXT_disjoint_timer_query_webgl2: one
// TIME_ELAPSED query around each frame's draws, read back a few frames later
// when the GPU has finished them, so reading never stalls the pipeline.

/** Not in lib.dom; the enums the extension object carries. */
interface DisjointTimerQueryWebGL2 {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

export interface GpuFrameTime {
  ms: number
  /** What begin() was given: the pixel ratio the frame was drawn at. */
  tag: number
}

export interface GpuFrameTimer {
  /** Starts timing; skipped while every query awaits its result. */
  begin(tag: number): void
  end(): void
  /** Finished frames, oldest first. */
  poll(): GpuFrameTime[]
  dispose(): void
}

/**
 * Results take 1-3 frames to land; six in flight covers that, and a frame
 * that finds none free just isn't timed.
 */
const POOL_SIZE = 6

interface Timing {
  query: WebGLQuery
  tag: number
}

/** null where the extension is missing (Firefox, Safari, most mobiles). */
export function createGpuFrameTimer(gl: WebGL2RenderingContext): GpuFrameTimer | null {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryWebGL2 | null
  if (!ext) return null
  const free: WebGLQuery[] = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const query = gl.createQuery()
    if (query) free.push(query)
  }
  const pending: Timing[] = []
  let active: Timing | null = null

  return {
    begin(tag) {
      // One TIME_ELAPSED query can be active at a time.
      if (active || gl.isContextLost()) return
      const query = free.pop()
      if (!query) return
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
      active = { query, tag }
    },
    end() {
      if (!active) return
      if (!gl.isContextLost()) gl.endQuery(ext.TIME_ELAPSED_EXT)
      pending.push(active)
      active = null
    },
    poll() {
      if (!pending.length || gl.isContextLost()) return []
      // A disjoint (power state change, another context's work) makes every
      // result in flight meaningless.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        for (const { query } of pending.splice(0)) free.push(query)
        return []
      }
      const results: GpuFrameTime[] = []
      while (pending.length) {
        const { query, tag } = pending[0]
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break
        const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
        pending.shift()
        free.push(query)
        results.push({ ms: ns / 1e6, tag })
      }
      return results
    },
    dispose() {
      if (active && !gl.isContextLost()) gl.endQuery(ext.TIME_ELAPSED_EXT)
      for (const query of [...free, ...pending.map((t) => t.query), ...(active ? [active.query] : [])]) {
        gl.deleteQuery(query)
      }
      free.length = 0
      pending.length = 0
      active = null
    },
  }
}
