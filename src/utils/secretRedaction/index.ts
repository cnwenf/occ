/**
 * Secret-redaction engine - public API with readable names.
 *
 * Port of the official Claude Code 2.1.286 general-purpose redactor rewrite
 * (changelog bullets #17-#21), upgraded to the official 2.1.296 engine
 * (two-phase plain/escaped assign scanner + redactOnly gating + per-rule
 * prefilter; see engine.ts / assignScanner.ts / rules.ts headers). Internal
 * modules keep the upstream minified
 * identifiers verbatim (precedent: src/services/mcp/redaction.ts keeps
 * tQn/JGo/ezo) so future version diffs stay mechanical; this barrel is the
 * only surface the rest of OCC should import.
 *
 * Name map (upstream -> readable):
 *   Rs  -> redactSecrets            g4o -> scanSecrets
 *   mQ  -> redactSecretsSequential  fZn -> redactSecretContext
 *   fvn -> redactSecretTokens       mZn -> redactSecretsWithCap
 *   LSe -> redactSecretForDisplay   M4  -> redactJsonValue
 *   D6r -> redactKeyValue           OGt -> redactCredentialKeys
 *   wkn -> redactTranscriptJsonl    zr  -> redactJsonlLines
 *   $qt -> redactJsonStructural
 */

export {
  Rs as redactSecrets,
  g4o as scanSecrets,
  mQ as redactSecretsSequential,
  fZn as redactSecretContext,
  fvn as redactSecretTokens,
  mZn as redactSecretsWithCap,
  LSe as redactSecretForDisplay,
  M4 as redactJsonValue,
  D6r as redactKeyValue,
  OGt as redactCredentialKeys,
} from './engine.js'
export {
  wkn as redactTranscriptJsonl,
  zr as redactJsonlLines,
  $qt as redactJsonStructural,
} from './jsonlRedact.js'
