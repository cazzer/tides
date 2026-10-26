// The streamed tiles' features (tides-zmw.9.16 composer, tile-material.ts),
// in EarthRenderer's composePatches order for the globe's ground: eclipse,
// cloud shadows, night (city lights, night fill, GIBS night), colour (sky
// fill, groundDetail; source grading), terrain shadows (groundShadow), the
// glint (Phong's specular, which the globe takes from its map), and the haze
// last. The composer applies them in this order, so text injected at a
// shared anchor lands as on the globe. Each slot is its own module, owned by
// one bead: tides-zmw.9.16 eclipse, 9.12 clouds, 9.13 night, 9.11 colour,
// 9.15 shadow, 9.14 glint; the haze is tides-zmw.9.7's.
//
// Within a slot, keep the globe's order too: the night slot applies
// nightLightsPatch's code before the GIBS night patch's (both inject after
// emissivemap_fragment, so the later lands first in the text, as on the
// globe, where gibsNightPatch comes after nightLightsPatch).
import type { TileFeatureSlot } from './tile-material'
import { tileClouds } from './tile-clouds'
import { tileColour } from './tile-colour'
import { tileEclipse } from './tile-eclipse'
import { tileGlint } from './tile-glint'
import { tileHaze } from './tile-haze'
import { tileNight } from './tile-night'
import { tileShadow } from './tile-shadow'

export const TILE_FEATURES: readonly TileFeatureSlot[] = [
  { name: 'eclipse', adapter: tileEclipse },
  { name: 'clouds', adapter: tileClouds },
  { name: 'night', adapter: tileNight },
  { name: 'colour', adapter: tileColour },
  { name: 'shadow', adapter: tileShadow },
  { name: 'glint', adapter: tileGlint },
  { name: 'haze', adapter: tileHaze },
]
