// Stub for tides-zmw.9.8 until tides-zmw.9.4 merges: that bead's file (which
// probes what the default framebuffer's depth buffer stores) replaces this
// one whole. Until then nothing counts as float depth, so the ship keeps the
// standard-depth clearance.

/** Whether the renderer runs reversed-Z on a float depth buffer: never, in this stub. */
export function reversedFloatDepth(gl: { capabilities: { reversedDepthBuffer: boolean } }): boolean {
  void gl
  return false
}
