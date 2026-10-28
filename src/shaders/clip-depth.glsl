// The gl_FragDepth of a clip-space point, perspective or orthographic: for
// a surface found along the ray rather than rasterised (the Sun's traced
// limb). As depth.glsl (tides-zmw.9.3): under reversed-Z window depth is
// NDC z itself, on the standard buffer 0.5 + 0.5 · NDC z. Its own file, so
// the programs that include depth.glsl keep their text.
#ifdef USE_REVERSED_DEPTH_BUFFER
float fragDepthOfClip(vec4 clip) {
  return clip.z / clip.w;
}
#else
float fragDepthOfClip(vec4 clip) {
  return 0.5 + 0.5 * clip.z / clip.w;
}
#endif
