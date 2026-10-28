// The Sun through Earth's air, from an eye inside it (tides-34q.4): the
// plain extinction along each pixel's ray, so a low Sun's disc dims and
// reddens toward the horizon, its lower limb the most, instead of standing
// white over a sunset. Mirrors cloud-layer.ts sunDiscTint() (its air mass,
// sunbeamAirMass(), and SUNLIGHT_EXTINCTION): change one, change the other.
// uAirUp: the eye's up in the includer's frame; uAirKm: its height over
// the sea, km (EYE_AIRLESS_KM, far over any air, when it looks through none).
uniform vec3 uAirUp;
uniform float uAirKm;

#define AIR_EXTINCTION vec3(0.045, 0.1, 0.22)
#define AIR_SCALE_KM 8.0
#define AIR_EARTH_KM 6371.0

// Kasten & Young's air mass at mu, the horizon's below it.
float airMass(float mu) {
  float zenith = min(90.0, degrees(acos(clamp(mu, -1.0, 1.0))));
  return 1.0 / (cos(radians(zenith)) + 0.50572 * pow(96.07995 - zenith, -1.6364));
}

float airThin(float km) {
  return exp(-max(km, 0.0) / AIR_SCALE_KM);
}

// The transmittance along unit dir from the eye, white with the Sun
// overhead (the air masses past the overhead one).
vec3 sunAir(vec3 dir) {
  float mu = dot(dir, uAirUp);
  float h = max(uAirKm, 0.0);
  float m;
  if (mu >= 0.0) {
    m = (airMass(mu) - 1.0) * airThin(h);
  } else {
    // Past the eye's horizon the ray grazes lower and crosses the dense air
    // either side of its lowest point.
    float tangent = (AIR_EARTH_KM + h) * sqrt(1.0 - mu * mu) - AIR_EARTH_KM;
    m = (airMass(0.0) - 1.0) * airThin(tangent) * (2.0 - airThin(h - tangent));
  }
  return exp(-AIR_EXTINCTION * m);
}
