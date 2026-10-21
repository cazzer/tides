import { describe, expect, test } from 'vitest'
import * as THREE from 'three'

import art from './assets/constellation-art.json'
import constellations from './assets/constellations.json'
import { raDecToEQJ } from './constellations'
import { constellationArtGeometry, fitTileToSky } from './constellationArt'

const DEG = 180 / Math.PI

describe('constellation art', () => {
  test('covers the major figures that have art', () => {
    expect(Object.keys(art.figures)).toHaveLength(44)
    for (const id of Object.keys(art.figures)) {
      expect(constellations.figures).toHaveProperty(id)
    }
    for (const id of ['Ori', 'UMa', 'Sco', 'Leo', 'Cas', 'Cru']) {
      expect(art.figures).toHaveProperty(id)
    }
    expect(art.license).toContain('Free Art License')
  })

  // The fit is exact at the anchors: each anchor's tile point lands on its star.
  test('every anchor lands on its star', () => {
    const fit = new THREE.Matrix3()
    const star = [0, 0, 0]
    let worst = 0
    for (const { anchors } of Object.values(art.figures)) {
      fitTileToSky(anchors, fit)
      for (const [u, v, ra, dec] of anchors) {
        const drawn = new THREE.Vector3(u, v, 1).applyMatrix3(fit).normalize()
        raDecToEQJ(ra, dec, star, 0)
        worst = Math.max(worst, drawn.angleTo(new THREE.Vector3().fromArray(star)) * DEG)
      }
    }
    expect(worst).toBeLessThan(1e-4)
  })

  // The grid between the anchors stays on the sphere and around Orion.
  test('the whole tile stays on the sky near its stars', () => {
    const geometry = constellationArtGeometry({ ...art, figures: { Ori: art.figures.Ori } }, 4)
    const position = geometry.getAttribute('position')
    const betelgeuse = [0, 0, 0]
    raDecToEQJ(88.79, 7.41, betelgeuse, 0)
    const towardBetelgeuse = new THREE.Vector3().fromArray(betelgeuse)
    const corner = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) {
      corner.fromBufferAttribute(position, i)
      expect(corner.length()).toBeCloseTo(1, 5)
      expect(corner.angleTo(towardBetelgeuse) * DEG).toBeLessThan(40)
    }
  })
})
