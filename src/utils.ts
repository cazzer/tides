import _ from 'lodash'

const DIAMETER_MIN_LOG = Math.log(3474800)
const DIAMETER_MAX_LOG = Math.log(1392700000)

export function scaleDiameter(diameter: number): number {
  const logrange = DIAMETER_MAX_LOG - DIAMETER_MIN_LOG
  const logstep = logrange / 4
  return Math.exp(DIAMETER_MIN_LOG + diameter * logstep)
}

export function scaleTime(hours: number, scale: number) {
  return hours * 3600 * scale
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Truncate to 4 decimal places for lat/lon */
export function truncateLatLon(n: number): number {
  return Math.trunc(n * 10000) / 10000
}

export const THREE_FPS = 120

interface OrbitParams {
  radius: number // Radius of the orbit
  period: number // Orbital period (time to complete one full orbit)
  time: number // Time at which to calculate the position
  centerX?: number // X coordinate of the center of the orbit (optional, default is 0)
  centerY?: number // Y coordinate of the center of the orbit (optional, default is 0)
  centerZ?: number // Z coordinate of the center of the orbit (optional, default is 0)
  inclination: number // Orbital inclination in degrees
  orbitOffset?: number // Offset angle for the orbit
}

export interface KeplerOrbitParams {
  semiMajorAxis: number
  eccentricity: number
  inclinationDeg: number
  ascendingNodeDeg: number
  argumentOfPeriapsisDeg: number
  meanAnomalyAtEpochRad: number
  period: number
  timeSinceEpoch: number
  centerX?: number
  centerY?: number
  centerZ?: number
}

function positiveModulo(value: number, divisor: number): number {
  const remainder = value % divisor
  return remainder >= 0 ? remainder : remainder + divisor
}

function solveEccentricAnomaly(
  meanAnomaly: number,
  eccentricity: number,
  iterations: number = 7
) {
  let eccentricAnomaly = meanAnomaly
  for (let i = 0; i < iterations; i += 1) {
    const f =
      eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly
    const fPrime = 1 - eccentricity * Math.cos(eccentricAnomaly)
    eccentricAnomaly -= f / fPrime
  }
  return eccentricAnomaly
}

export function trueAnomalyToMeanAnomaly(
  trueAnomalyRad: number,
  eccentricity: number
) {
  const e = Math.max(0, Math.min(0.9999, eccentricity))
  const eccentricAnomaly =
    2 *
    Math.atan2(
      Math.sqrt(1 - e) * Math.sin(trueAnomalyRad / 2),
      Math.sqrt(1 + e) * Math.cos(trueAnomalyRad / 2)
    )
  return positiveModulo(eccentricAnomaly - e * Math.sin(eccentricAnomaly), Math.PI * 2)
}

export function calculateKeplerOrbitPosition({
  semiMajorAxis,
  eccentricity,
  inclinationDeg,
  ascendingNodeDeg,
  argumentOfPeriapsisDeg,
  meanAnomalyAtEpochRad,
  period,
  timeSinceEpoch,
  centerX = 0,
  centerY = 0,
  centerZ = 0,
}: KeplerOrbitParams): { x: number; y: number; z: number; angle: number } {
  const e = Math.max(0, Math.min(0.9999, eccentricity))
  const inclination = degreesToRadians(inclinationDeg)
  const ascendingNode = degreesToRadians(ascendingNodeDeg)
  const argumentOfPeriapsis = degreesToRadians(argumentOfPeriapsisDeg)

  const meanMotion = (Math.PI * 2) / period
  const meanAnomaly = positiveModulo(
    meanAnomalyAtEpochRad + meanMotion * timeSinceEpoch,
    Math.PI * 2
  )
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, e)

  const trueAnomaly =
    2 *
    Math.atan2(
      Math.sqrt(1 + e) * Math.sin(eccentricAnomaly / 2),
      Math.sqrt(1 - e) * Math.cos(eccentricAnomaly / 2)
    )

  const radius = semiMajorAxis * (1 - e * Math.cos(eccentricAnomaly))

  const xOrbital = radius * Math.cos(trueAnomaly)
  const zOrbital = -radius * Math.sin(trueAnomaly)

  const cosArg = Math.cos(argumentOfPeriapsis)
  const sinArg = Math.sin(argumentOfPeriapsis)
  const xArg = xOrbital * cosArg + zOrbital * sinArg
  const zArg = -xOrbital * sinArg + zOrbital * cosArg

  const cosInc = Math.cos(inclination)
  const sinInc = Math.sin(inclination)
  const xInclined = xArg
  const yInclined = zArg * sinInc
  const zInclined = zArg * cosInc

  const cosNode = Math.cos(ascendingNode)
  const sinNode = Math.sin(ascendingNode)
  const xFinal = xInclined * cosNode + zInclined * sinNode
  const zFinal = -xInclined * sinNode + zInclined * cosNode

  return {
    x: centerX + xFinal,
    y: centerY + yInclined,
    z: centerZ + zFinal,
    angle: trueAnomaly,
  }
}

export function calculateOrbitPosition({
  radius,
  period,
  time,
  centerX = 0,
  centerY = 0,
  centerZ = 0,
  inclination,
  orbitOffset = 0,
}: OrbitParams): { x: number; y: number; z: number; angle: number } {
  // Convert inclination to radians
  const inclinationRad = (inclination * Math.PI) / 180

  const phase = positiveModulo(time, period) / period
  const angle = phase * Math.PI * 2 - orbitOffset

  // Calculate x, y, and z coordinates with inclination
  const x = centerX + radius * Math.cos(angle)
  const y = centerY + radius * Math.sin(angle) * Math.sin(inclinationRad)
  const z = centerZ + radius * -Math.sin(angle) * Math.cos(inclinationRad)

  return { x, y, z, angle }
}

export function calculateRotation(
  rotationPeriod: number,
  time: number,
  offset: number = 0
) {
  const phase = positiveModulo(time, rotationPeriod) / rotationPeriod
  return phase * Math.PI * 2 + offset
}

export function calculateLocationAndRotationForLatLng(
  lat: number,
  lng: number,
  radius: number
) {
  const latRad = (lat * Math.PI) / 180
  const lngRad = (-lng * Math.PI) / 180

  const x = radius * Math.cos(latRad) * Math.cos(lngRad)
  const y = radius * Math.sin(latRad)
  const z = radius * Math.cos(latRad) * Math.sin(lngRad)

  // calculate the rotation as an Euler angle
  const rotationY = (lng * Math.PI) / 180 - Math.PI / 2
  // const rotationX = latRad * -Math.sin(lngRad)
  // const rotationZ = latRad * Math.cos(lngRad)
  const rotationX = 0
  const rotationZ = 0

  return {
    position: { x, y, z },
    rotation: { x: rotationX, y: rotationY, z: rotationZ },
  }
}

export function interpolateValue(
  start: number,
  end: number,
  x: number,
  easingFunction: (x: number) => number
): number {
  const easedProgress = easingFunction(x)
  return start + (end - start) * easedProgress
}
