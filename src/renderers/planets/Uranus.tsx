// Uranus: a pale cyan haze, nearly featureless, with a faint blue-green limb
// and its thin dark rings. Lying on its side (axis ~97.8°) comes from
// bodyOrientation, not from anything here.
//
// Texture: Solar System Scope, CC BY 4.0 (credited by PlanetAttribution),
// https://www.solarsystemscope.com/textures/download/2k_uranus.jpg
import { PLANETS } from '../../planets'
import {
  PlanetAtmosphere,
  PlanetRings,
  PlanetSurface,
  type RingProfile,
} from '../PlanetRenderer'
import uranusTexture from '../../assets/uranus-2k.jpg'

const URANUS = PLANETS.uranus

// The main rings in Uranus radii (25 559 km), from 6 (41 837 km) out to ε
// (51 149 km). Each is at most ~100 km wide, a fraction of a pixel when
// Uranus fills the view, and drawn true to size they shimmer into dashes.
// So the close-set ones merge into one ringlet each (6-5-4 and η-γ-δ), and
// every ringlet is widened to a pixel or two, fainter to make up for it; ε
// stays the densest. The particles are as dark as charcoal (albedo ~0.02),
// hence dim grey.
const RINGS: RingProfile = {
  ...URANUS.rings!,
  bands: [
    { inner: 1.637, outer: 1.668, opacity: 0.25 }, // 6, 5, 4
    { inner: 1.740, outer: 1.760, opacity: 0.35 }, // α
    { inner: 1.780, outer: 1.800, opacity: 0.35 }, // β
    { inner: 1.840, outer: 1.886, opacity: 0.3 }, // η, γ, δ
    { inner: 1.976, outer: 1.996, opacity: 0.7 }, // ε
  ],
  opacity: 0.6,
}

const RING_COLOR = '#5a5a5a'

// The texture is already near white; at full albedo the tone mapping bleaches
// its cyan, so it is dimmed a little. The rings' shadow only reaches the
// globe near the terminator, as faint arcs.

export function Uranus() {
  return (
    <>
      <PlanetSurface
        planet={URANUS}
        texture={uranusTexture}
        albedo={0.8}
        limbDarkening={1.1}
        ringShadow={RINGS}
      />
      <PlanetAtmosphere
        planet={URANUS}
        outer={1.04}
        scaleHeight={0.008}
        sky="#7fe0dc"
        dusk="#4aa5b0"
        gain={0.4}
      />
      <PlanetRings
        planet={URANUS}
        {...RINGS}
        color={RING_COLOR}
      />
    </>
  )
}
