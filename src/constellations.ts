const DEG = Math.PI / 180

/** Polylines of [ra, dec, ra, dec, ...] in J2000 degrees, per constellation. */
export type ConstellationFigures = Record<string, number[][]>

export function raDecToEQJ(ra: number, dec: number, target: number[], offset: number) {
  const a = ra * DEG
  const d = dec * DEG
  target[offset] = Math.cos(d) * Math.cos(a)
  target[offset + 1] = Math.cos(d) * Math.sin(a)
  target[offset + 2] = Math.sin(d)
}

// Unit J2000 equatorial directions (x toward α = 0h, z north), the frame
// starDirectionsEQJ gives the stars, as LineSegments endpoint pairs.
export function constellationSegmentsEQJ(figures: ConstellationFigures) {
  const positions: number[] = []
  for (const lines of Object.values(figures)) {
    for (const line of lines) {
      for (let i = 2; i < line.length; i += 2) {
        const at = positions.length
        raDecToEQJ(line[i - 2], line[i - 1], positions, at)
        raDecToEQJ(line[i], line[i + 1], positions, at + 3)
      }
    }
  }
  return new Float32Array(positions)
}
