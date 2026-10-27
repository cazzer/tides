/*
 * The Sun's procedural activity: where its sunspot groups, plage and magnetic
 * structures sit, in the Sun's own frame (local +Y is the pole, +X the prime
 * meridian; see ephemeris.ts sunOrientation). Illustrative, not observed:
 * one fixed, seeded layout that turns with the Sun, so scrubbing the date
 * always shows the same Sun, and nothing evolves or erupts. The disc's EUV
 * bake (sun-surface.ts) and the prominences (sun-prominences.ts) both read
 * it, so loops stand over the spots they belong to.
 */

/** Unit vector at solar latitude and longitude (radians). */
export function solarDirection(lat: number, lon: number): [number, number, number] {
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)]
}

/** A small, stable PRNG: the layout must not change between loads. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export interface Sunspot {
  /** Centre, a unit vector in the solar frame. */
  dir: [number, number, number]
  /** Umbra radius, radians of arc on the Sun. */
  umbra: number
  /** Penumbra radius over umbra radius; 1 is a bare pore. */
  penumbra: number
  /** Stretch along the group's axis (1 is round). */
  stretch: number
  /** Seeds the spot's ragged edge and penumbral filaments. */
  seed: number
}

export interface ActiveRegion {
  /** Centre between the group's poles, unit vector. */
  dir: [number, number, number]
  lat: number
  lon: number
  /** Arc from the leading to the following spot, radians. */
  span: number
  /** The bipole axis's tilt from east-west (Joy's law), radians. */
  tilt: number
  /** How strong it is, 0..1: spot size, plage and loop count follow. */
  strength: number
  spots: Sunspot[]
}

const DEG = Math.PI / 180

/**
 * [TUNE] The active regions, as (latitude°, longitude°, strength). Spots
 * live in the two activity belts (5-35° either side of the equator) and a
 * Sun near cycle maximum shows a handful on each hemisphere, unevenly
 * spread in longitude so every side of the Sun has something to show.
 */
const REGIONS: readonly [number, number, number][] = [
  [14, 20, 1.0],
  [-11, 62, 0.55],
  [24, 118, 0.7],
  [-19, 170, 0.9],
  [9, 212, 0.45],
  [-27, 250, 0.6],
  [17, 300, 0.8],
  [-8, 335, 0.4],
  // Small and decaying, so the disc between the big groups isn't bare.
  [21, 75, 0.2],
  [-15, 100, 0.25],
  [6, 150, 0.15],
  [-24, 205, 0.3],
  [12, 255, 0.2],
  [-6, 285, 0.2],
  [28, 350, 0.25],
  [-30, 5, 0.15],
]

/** The fixed active-region layout. */
export function activeRegions(): ActiveRegion[] {
  const random = seededRandom(0x5a17c0de)
  return REGIONS.map(([latDeg, lonDeg, strength]) => {
    const lat = latDeg * DEG
    const lon = lonDeg * DEG
    // Joy's law: the leading (western, +lon) spot sits nearer the equator.
    const tilt = Math.sign(lat) * (4 + 0.5 * Math.abs(latDeg)) * DEG
    const span = (3 + 7 * strength) * DEG
    const spots: Sunspot[] = []
    const along = (s: number, across: number): [number, number, number] => {
      const dLon = (s * Math.cos(tilt) - across * Math.sin(tilt)) / Math.cos(lat)
      const dLat = s * Math.sin(tilt) + across * Math.cos(tilt)
      return solarDirection(lat + dLat, lon + dLon)
    }
    // The leader: the biggest and roundest spot.
    spots.push({
      dir: along(span / 2, 0),
      umbra: (0.45 + 0.75 * strength) * DEG,
      penumbra: 2.1 + 0.4 * random(),
      stretch: 1 + 0.15 * random(),
      seed: random() * 100,
    })
    // The follower: smaller, more ragged, often broken in two.
    const followers = strength > 0.65 ? 2 : 1
    for (let i = 0; i < followers; i++) {
      spots.push({
        dir: along(-span / 2 + (i - (followers - 1) / 2) * 0.9 * DEG, (random() - 0.5) * 1.2 * DEG),
        umbra: (0.3 + 0.45 * strength) * DEG * (1 - 0.25 * i),
        penumbra: 1.8 + 0.6 * random(),
        stretch: 1.1 + 0.4 * random(),
        seed: random() * 100,
      })
    }
    // Pores scattered between and around the poles.
    const pores = Math.round(2 + 4 * strength)
    for (let i = 0; i < pores; i++) {
      spots.push({
        dir: along((random() - 0.5) * span * 1.2, (random() - 0.5) * span * 0.5),
        umbra: (0.08 + 0.12 * random()) * DEG,
        penumbra: random() < 0.4 ? 1.7 : 1,
        stretch: 1,
        seed: random() * 100,
      })
    }
    return { dir: solarDirection(lat, lon), lat, lon, span, tilt, strength, spots }
  })
}

/** Every spot of every region, flattened in region order. */
export function allSunspots(regions: ActiveRegion[] = activeRegions()): Sunspot[] {
  return regions.flatMap((r) => r.spots)
}
