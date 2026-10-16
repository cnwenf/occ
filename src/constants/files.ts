/**
 * Binary file extensions to skip for text-based operations.
 * These files can't be meaningfully compared as text and are often large.
 *
 * CC 2.1.301 (occ160 WP-F): official Read-tool binary-extension Set expanded
 * from 94 → 121 entries — "Fixed the Read tool reading binary files such as
 * .xlsm, .parquet, .epub and .heic as text". Byte-exact from the official
 * 2.1.301 ELF `var be=new Set([...])` (@224955508; 2.1.300 counterpart
 * @224062630 has 94 entries, zero removals in 301). The 27 additions are
 * marked inline below. Consuming gate is unchanged in shape:
 * `if(YPe(H)&&!dJe(H))` (@229305959 region) — extension ∈ Set AND NOT
 * (png/jpg/jpeg/gif/webp or pdf) → refusal with the SAME byte-identical
 * message as 2.1.291/300 (`This tool cannot read binary files. …` — A/B
 * verified literal unchanged between versions). Note .heic/.heif/.avif land on
 * the REFUSAL side: the official native-image whitelist
 * `Wln=new Set(["png","jpg","jpeg","gif","webp"])` + pdf exception (@219232101)
 * is identical in 300 and 301, so HEIC/AVIF are refused as binary, not
 * rendered as images.
 */
export const BINARY_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // CC 2.1.301 (occ160 WP-F): official additions (@224955508) — HEIC/HEIF/AVIF
  // are refused as binary (NOT in the official png/jpg/jpeg/gif/webp native
  // image whitelist).
  '.heic',
  '.heif',
  '.avif',
  // Videos
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // CC 2.1.301 (occ160 WP-F): official additions (@224955508)
  '.zst',
  '.lz4',
  '.whl',
  // Executables/binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // CC 2.1.301 (occ160 WP-F): official additions (@224955508)
  '.dmg',
  '.apk',
  // Documents (PDF is here; FileReadTool excludes it at the call site)
  '.pdf',
  '.doc',
  '.docx',
  // CC 2.1.301 (occ160 WP-F): official additions (@224955508) — Word macro/
  // template formats (.xlsm/.epub/.parquet/.heic per the changelog)
  '.docm',
  '.dotx',
  '.dotm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.xltx',
  '.xltm',
  '.ppt',
  '.pptx',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.potx',
  '.potm',
  '.odt',
  '.ods',
  '.odp',
  '.numbers',
  '.epub',
  // Fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // Bytecode / VM artifacts
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // Database files
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // CC 2.1.301 (occ160 WP-F): official additions (@224955508) — columnar /
  // scientific data formats (official order: directly after .idx)
  '.parquet',
  '.feather',
  '.npy',
  '.npz',
  '.pickle',
  // Design / 3D
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash
  '.swf',
  '.fla',
  // Lock/profiling data
  '.lockb',
  '.dat',
  '.data',
])

/**
 * Check if a file path has a binary extension.
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * Number of bytes to read for binary content detection.
 */
const BINARY_CHECK_SIZE = 8192

/**
 * Check if a buffer contains binary content by looking for null bytes
 * or a high proportion of non-printable characters.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  // Check first BINARY_CHECK_SIZE bytes (or full buffer if smaller)
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)

  let nonPrintable = 0
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    // Null byte is a strong indicator of binary
    if (byte === 0) {
      return true
    }
    // Count non-printable, non-whitespace bytes
    // Printable ASCII is 32-126, plus common whitespace (9, 10, 13)
    if (
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13 // carriage return
    ) {
      nonPrintable++
    }
  }

  // If more than 10% non-printable, likely binary
  return nonPrintable / checkSize > 0.1
}
