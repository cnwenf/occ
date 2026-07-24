/**
 * The public executable name from package.json's sole `bin` entry.
 *
 * Production builds inject this through MACRO.BINARY_NAME. The fallback keeps
 * source-level tests and `bun run dev` aligned with the published OCC binary.
 */
export const CLI_BINARY_NAME =
  (
    globalThis as typeof globalThis & {
      MACRO?: { BINARY_NAME?: string }
    }
  ).MACRO?.BINARY_NAME ?? 'occ'
