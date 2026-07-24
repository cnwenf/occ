/**
 * OCC-21 Gap-2a: `--plugin-url <url>` (2.1.218 --help alignment).
 *
 * Fetches a plugin `.zip` from a URL into a session-local temp file so the
 * existing inline-plugin path (`setInlinePlugins` → `loadSessionOnlyPlugins`
 * → `createPluginFromPath`, which already handles `.zip` extraction) can
 * load it for the session.
 *
 * Security posture (OCC hardening over the official, which accepts any URL):
 * - HTTPS only. `http:`/`file:`/`ftp:` etc. are rejected — a plaintext or
 *   local-file plugin URL is a tampering/SSRF footgun and OCC's ethos is
 *   "safe, auditable". This is a deliberate, documented divergence.
 * - Size-capped streaming write (default 100 MiB) so a hostile URL cannot
 *   exhaust disk / memory.
 * - `redirect: 'error'` forbids redirects so a same-host https URL cannot
 *   bounce to an insecure or unintended host; plugin zips are served from a
 *   single static host.
 *
 * The downloaded `.zip` is extracted by `createPluginFromPath`, which
 * already guards path traversal for OCC's existing `.zip` plugin cache.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAX_PLUGIN_ZIP_BYTES = 100 * 1024 * 1024 // 100 MiB

export type FetchedPluginZip = {
  path: string
  url: string
}

/**
 * Validate a `--plugin-url` value. Returns the parsed URL, or throws on
 * non-HTTPS / unparseable input. Extracted for unit testing.
 */
export function validatePluginZipUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      `--plugin-url: invalid URL "${raw}". Expected an https:// URL to a plugin .zip.`,
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `--plugin-url: only https:// URLs are accepted (got "${parsed.protocol}"). OCC fetches plugin zips over HTTPS only.`,
    )
  }
  return parsed
}

type ChunkWriter = {
  write: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

async function openForWrite(path: string): Promise<ChunkWriter> {
  const handle = await open(path, 'w')
  return {
    write: async (chunk: Uint8Array) => {
      await handle.writeFile(chunk)
    },
    close: async () => {
      await handle.close()
    },
  }
}

/**
 * Fetch a plugin .zip from an https URL to a session-local temp file.
 * Throws on non-HTTPS, non-2xx, oversize, empty body, or write failure.
 */
export async function fetchPluginZipFromUrl(
  rawUrl: string,
  options: { fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<FetchedPluginZip> {
  const url = validatePluginZipUrl(rawUrl)
  const maxBytes = options.maxBytes ?? MAX_PLUGIN_ZIP_BYTES
  const doFetch = options.fetchImpl ?? fetch

  const response = await doFetch(url, {
    method: 'GET',
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(
      `--plugin-url: fetch "${rawUrl}" failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    )
  }
  if (response.body === null) {
    throw new Error(`--plugin-url: response from "${rawUrl}" has no body`)
  }

  const sessionTmp = join(tmpdir(), `occ-plugin-url-${randomUUID()}`)
  await mkdir(sessionTmp, { recursive: true })
  const zipPath = join(sessionTmp, 'plugin.zip')

  const reader = response.body.getReader()
  const writer = await openForWrite(zipPath)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > maxBytes) {
        throw new Error(
          `--plugin-url: zip from "${rawUrl}" exceeds the ${maxBytes}-byte limit (received >= ${received} bytes).`,
        )
      }
      await writer.write(value)
    }
  } finally {
    await writer.close()
  }

  if (received === 0) {
    throw new Error(`--plugin-url: response from "${rawUrl}" was empty`)
  }

  return { path: zipPath, url: rawUrl }
}
