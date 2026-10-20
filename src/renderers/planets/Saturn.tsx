// Saturn (tides-kzj.2.11). Textures: Solar System Scope, CC BY 4.0
// (credited by PlanetAttribution),
// https://www.solarsystemscope.com/textures/download/2k_saturn.jpg and
// https://www.solarsystemscope.com/textures/download/2k_saturn_ring_alpha.png
import { PLANETS } from '../../planets'
import {
  PlanetRings,
  PlanetSurface,
  type RingProfile,
} from '../PlanetRenderer'
import saturnTexture from '../../assets/saturn-2k.jpg'
import ringTexture from '../../assets/saturn-ring-2k.png'

const SATURN = PLANETS.saturn

const EQUATORIAL_RADIUS_KM = 60_268

// The ring strip runs inner to outer and is linear in radius. Fitting its
// features to their radii (C ring inner edge 74 658 km, B ring 92 000,
// Cassini Division 117 580, Encke Gap 133 590, A ring outer edge 136 775,
// F ring 140 180) puts its ends at these radii, within ~5 px. Like the
// catalog's ring radii, they're over the equatorial radius.
const RING_STRIP_INNER_KM = 69_460
const RING_STRIP_OUTER_KM = 140_960

const RINGS: RingProfile = {
  inner: RING_STRIP_INNER_KM / EQUATORIAL_RADIUS_KM,
  outer: RING_STRIP_OUTER_KM / EQUATORIAL_RADIUS_KM,
  texture: ringTexture,
}

// The strip's colours are dark for this lighting: at 2030-01-01 (Sun ~23°
// from the ring plane) albedo 3 brings the B ring's lit face to ~75% of
// the globe's brightness, as in telescope images, with the Cassini
// Division still near black. Thick particle layers (Lommel–Seeliger)
// stay bright under a low Sun when seen, as from the Earth, from near the
// ring plane. The B ring is too thick for much light to get through, so
// its unlit face is far darker: 0.1 keeps it as dark as before the boost.
const RING_ALBEDO = 3
const RING_UNLIT_FACE = 0.1

export function Saturn() {
  return (
    <>
      {/* Hazier than Jupiter's, the cloud tops darken just as gently. */}
      <PlanetSurface
        planet={SATURN}
        texture={saturnTexture}
        limbDarkening={1.1}
        ringShadow={RINGS}
      />
      <PlanetRings
        planet={SATURN}
        {...RINGS}
        law="lommel-seeliger"
        albedo={RING_ALBEDO}
        unlitFace={RING_UNLIT_FACE}
      />
    </>
  )
}
