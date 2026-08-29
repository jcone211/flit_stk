import { decompress as decompressZstd } from './fzstd.js'
import { snappyUncompress } from './snappy.js'

export const compressors = {
  ZSTD: input => decompressZstd(input),
  SNAPPY: input => snappyUncompress(input),
}
