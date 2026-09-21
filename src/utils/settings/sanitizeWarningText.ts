/**
 * CWE-117 (log injection) hardening for policy-sanitization warnings
 * (OCC-132 §7 P3-5).
 *
 * Policy-controlled strings (managed-settings.json entries, MDM/remote
 * policy values) are interpolated into sanitizer warning messages that
 * surface in logs and stderr diagnostics. A crafted value carrying CR/LF
 * or other C0 control characters could forge extra log lines. Stripping
 * the control characters at the interpolation sites keeps every warning
 * single-line.
 *
 * Benign policy values never contain C0 control characters (JSON keys,
 * URLs, permission rules, plugin@marketplace strings), so messages for
 * legitimate input stay byte-identical — the transform is a no-op except
 * for crafted control characters. Replacement is '' rather than a visible
 * marker for exactly that reason.
 */

/** C0 control characters (U+0000–U+001F — includes NUL, TAB, CR, LF). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters ARE the strip target (CWE-117 log-injection hardening, OCC-132 §7 P3-5).
const C0_CONTROL_CHARS_RE = /[\u0000-\u001f]/g

/**
 * Strips C0 control characters from a policy-derived string before it is
 * interpolated into a warning/log message.
 */
export function sanitizeForWarningText(text: string): string {
  return text.replace(C0_CONTROL_CHARS_RE, '')
}
