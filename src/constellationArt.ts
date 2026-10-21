import * as THREE from 'three'

import { raDecToEQJ } from './constellations'

/** [u, v, ra, dec]: a point on the figure's tile (0..1 from its top-left)
 * and the J2000 star (degrees) it is drawn on. */
export type ArtAnchor = number[]

export type ConstellationArt = {
  atlas: { columns: number; rows: number }
  figures: Record<string, { tile: number; anchors: ArtAnchor[] }>
}

const tilePoint = new THREE.Matrix3()
const starDirections = new THREE.Matrix3()
const anchorStar = [0, 0, 0]

// Stellarium's fit: the linear map taking each anchor's (u, v, 1) to its
// star's unit vector. Every other tile point maps through it and onto the
// sphere, a gnomonic projection that is exact at the three anchors.
export function fitTileToSky(anchors: ArtAnchor[], target = new THREE.Matrix3()) {
  const [a, b, c] = anchors
  tilePoint.set(a[0], b[0], c[0], a[1], b[1], c[1], 1, 1, 1)
  const columns = [a, b, c].map(([, , ra, dec]) => {
    raDecToEQJ(ra, dec, anchorStar, 0)
    return new THREE.Vector3().fromArray(anchorStar)
  })
  starDirections.set(
    columns[0].x, columns[1].x, columns[2].x,
    columns[0].y, columns[1].y, columns[2].y,
    columns[0].z, columns[1].z, columns[2].z
  )
  return target.multiplyMatrices(starDirections, tilePoint.invert())
}

const fit = new THREE.Matrix3()
const point = new THREE.Vector3()

// One grid of SEGMENTS² quads per figure, its vertices on the unit sphere in
// J2000 equatorial (the stars' frame, see constellations.ts) and its UVs in
// the atlas. A grid rather than a flat quad so the big figures bend with the
// sky.
export function constellationArtGeometry(art: ConstellationArt, segments = 8) {
  const { columns, rows } = art.atlas
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (const { tile, anchors } of Object.values(art.figures)) {
    fitTileToSky(anchors, fit)
    const column = tile % columns
    const row = Math.floor(tile / columns)
    const first = positions.length / 3
    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        const u = i / segments
        const v = j / segments
        point.set(u, v, 1).applyMatrix3(fit).normalize()
        positions.push(point.x, point.y, point.z)
        // Textures load flipped, so the atlas's top row is at UV v = 1.
        uvs.push((column + u) / columns, 1 - (row + v) / rows)
      }
    }
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const at = first + j * (segments + 1) + i
        indices.push(at, at + segments + 1, at + 1, at + 1, at + segments + 1, at + segments + 2)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}
