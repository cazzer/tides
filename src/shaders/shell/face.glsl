// Which face of a double-sided shell draws this ray (tides-01v.8.2). From
// outside, the front face, as with front faces alone; from inside, the back
// face, the only one there is. Also the back face where the near plane clips
// the front one away, just outside the shell. The faceted shell sits inside
// the true sphere, so a front facet is never nearer than the sphere's entry:
// testing the entry against the near plane leaves no gap and no overlap.
// Pairs with shell/vertex.glsl; only double-sided materials compile it.
// It declares the DOUBLE_SIDED varyings itself; callers take the ray's
// direction from vRayDir there (tides-01v.8.11).
#ifdef DOUBLE_SIDED
varying vec3 vRayDir;
varying float vViewDepth;
varying float vNear;

bool shellBackFace(vec3 ro, vec3 rd, float outer) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - outer * outer;
  if (c < 0.0) return true;
  float h = b * b - c;
  if (h <= 0.0) return false;
  float entry = -b - sqrt(h);
  // Depth scales with distance along the ray.
  return entry * vViewDepth / length(vRayDir) < vNear;
}
#endif
