// A cloud map's drawn alpha (its G), one byte per texel in the map's order,
// which falling precipitation reads on the CPU (../ship/falling-precip.ts
// cloudCoverAt) once the map's own pixels are dropped (tides-0oi.11). Pure,
// for the cloud worker (./cloudPipeline.ts) and the main thread alike.

export interface CloudCover {
  data: Uint8Array
  width: number
  height: number
}

/** The G of an RGBA image, one byte per texel in the same order. */
export function alphaBytes(rgba: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(rgba.length / 4)
  for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i + 1]
  return data
}

/** An RGBA map's cover. */
export function coverOf(rgba: ArrayLike<number>, width: number, height: number): CloudCover {
  return { data: alphaBytes(rgba), width, height }
}
