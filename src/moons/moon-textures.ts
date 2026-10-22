// Surface maps for the major moons (tides-2hv.17), built by
// scripts/build-moon-textures.py: rolled to longitude 0 at the centre (east
// to the right, IAU north up), gaps filled, and scaled so each map's
// area-weighted mean is the moon's catalog colour (moons.ts), so a textured
// moon reads as the same dot it was untextured. <key>-1k.jpg is 1024 × 512;
// <key>-2k.jpg (2048 × 1024) exists only where the source had the detail.
//
// All public domain (US government works; no credit required):
//   USGS Astrogeology global mosaics, https://planetarymaps.usgs.gov/mosaic/
//     Phobos     Phobos_ME_SRC_Mosaic_Global_16ppd.tif (Mars Express SRC)
//     Io         Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif
//     Europa     Europa_Voyager_GalileoSSI_global_mosaic_500m.tif
//     Ganymede   Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif
//     Callisto   Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif
//     Enceladus  Enceladus_Cassini_mosaic_global_110m.tif
//     Tethys     Tethys_Cassini_mosaic_global_293m.tif
//     Dione      Dione_Cassini_Voyager_mosaic_global_154m.tif
//     Rhea       Rhea_Cassini_Voyager_mosaic_global_417m.tif
//     Titan      Titan_ISS_P19658_Mosaic_Global_4km.tif (938 nm; softened
//                to a faint hint under the haze's orange)
//     Iapetus    Iapetus_Cassini_Voyager_mosaic_global_783m.tif
//     Triton     Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif
//   USGS Astrogeology WMS basemap (NASA/JPL/Space Science Institute),
//     https://asc-pds-services.s3.us-west-2.amazonaws.com/wms_basemaps/Saturn/Mimas/Cassini/Mimas_PDS_8ppd_dd360.tif
//     Mimas
//   NASA 3D Resources ("free and without copyright"),
//     https://github.com/nasa/NASA-3D-Resources/tree/master/Images%20and%20Textures
//     Deimos, Miranda, Ariel, Umbriel, Titania, Oberon. Voyager 2 saw only
//     the Uranian moons' southern hemispheres; their north is a smooth fill.
import type { MoonKey } from './moon-keys'

const LOW = import.meta.glob<string>('../assets/moons/*-1k.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
})
const HIGH = import.meta.glob<string>('../assets/moons/*-2k.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
})

/** The moon's surface map: the 2k one unless `low` or there is none. */
export function moonTextureUrl(key: MoonKey, low: boolean): string {
  const high = HIGH[`../assets/moons/${key}-2k.jpg`]
  const url = (!low && high) || LOW[`../assets/moons/${key}-1k.jpg`]
  if (!url) throw new Error(`No surface map for ${key}`)
  return url
}
