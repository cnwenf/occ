/**
 * Fable 5 research-preview consent.
 *
 * Persists the user's consent decision to `~/.claude/fable-consent.json` as
 * `{ consented: boolean, timestamp: number }`. The interactive gate
 * (`ensureFableConsent` in `Fable5ConsentDialog.tsx`) shows a dialog on first
 * use; this module holds the pure I/O + the non-interactive (pipe) gate.
 *
 * Consent is sticky: a recorded `consented: true` never re-prompts, and a
 * recorded `consented: false` falls back to the default model without
 * re-prompting. Delete the file to reset.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'

export interface FableConsent {
  consented: boolean
  timestamp: number
}

const CONSENT_FILENAME = 'fable-consent.json'

function getConsentFilePath(): string {
  return join(getClaudeConfigHomeDir(), CONSENT_FILENAME)
}

function getNoConsent(): FableConsent {
  return { consented: false, timestamp: 0 }
}

/**
 * Read the persisted Fable 5 consent decision. Returns `{ consented: false,
 * timestamp: 0 }` when the file is missing or unreadable.
 */
export function getFableConsent(): FableConsent {
  try {
    const path = getConsentFilePath()
    if (!existsSync(path)) return getNoConsent()
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<FableConsent>
    return {
      consented: parsed.consented === true,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
    }
  } catch {
    return getNoConsent()
  }
}

/** True only when the user has explicitly consented to Fable 5. */
export function hasFableConsent(): boolean {
  return getFableConsent().consented === true
}

/** True when a consent decision has been recorded (file exists). */
export function hasFableConsentRecord(): boolean {
  return existsSync(getConsentFilePath())
}

/** Persist the user's Fable 5 consent decision. Best-effort. */
export function saveFableConsent(consented: boolean): void {
  try {
    const data: FableConsent = { consented, timestamp: Date.now() }
    const path = getConsentFilePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSyncAndFlush_DEPRECATED(path, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch {
    // Best-effort: a failed write just means we may re-prompt next time.
  }
}
