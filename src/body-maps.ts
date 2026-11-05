// The planets' and moons' surface maps ship twice (tides-0oi.14): a
// mipmapped UASTC KTX2 (scripts/build-body-maps.sh), which KTX2Loader
// transcodes to a GPU format at a quarter of the JPEG's memory or less, and
// the JPEG it was made from, for browsers without one of those formats and
// for a failed load (renderers/planetTextures.ts).

/**
 * Whether `has` (a WebGL extension check) offers a format KTX2Loader would
 * transcode UASTC to and three uploads as sRGB. It takes ASTC, then BC7,
 * then ETC2, then ETC1, then BC1/BC3: there is no sRGB ETC1, and sRGB
 * BC1/BC3 needs the s3tc_srgb extension, so those keep the JPEG, as does a
 * browser with none (KTX2Loader would decode to uncompressed RGBA).
 */
export function canUseCompressedBodyMaps(has: (extension: string) => boolean): boolean {
  if (
    has('WEBGL_compressed_texture_astc') ||
    has('EXT_texture_compression_bptc') ||
    has('WEBGL_compressed_texture_etc')
  ) {
    return true
  }
  if (has('WEBGL_compressed_texture_etc1')) return false
  return has('WEBGL_compressed_texture_s3tc') && has('WEBGL_compressed_texture_s3tc_srgb')
}
