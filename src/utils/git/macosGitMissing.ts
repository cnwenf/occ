/**
 * Official Claude Code 2.1.309 changelog item 42 — macOS git-missing DORMANT
 * parity module.
 *
 * Source of truth (BIN309, byte-verified via read-only forensics; the official
 * binary was never executed):
 *   module @240801080:
 *     var Lvn="git is not installed on this Mac. To install it, run xcode-select --install, then try again.";
 *     function JNe(n,e){return!1}
 *     export{Lvn,JNe};
 *   spawn guard @240891566:
 *     if(T!==null&&JNe(A,T.env))return{stdout:"",stderr:Lvn,code:127,error:Lvn};
 *
 * STOP-ON-AMBIGUOUS / NO-INVENTION: in the official linux-x64 build the
 * predicate `JNe` is a FALSE STUB (@240801245 `function JNe(n,e){return!1}`).
 * There is NO darwin git-detection logic present in this binary to recover, so
 * NONE is invented here. OCC ports (1) the verbatim user-facing message and
 * (2) a faithful false-stub predicate, and reproduces (3) the guard SHAPE
 * (exit code 127 + the Lvn message) on the git-spawn path in
 * `execFileNoThrow.ts` so the branch EXISTS and is unreachable exactly as in the
 * official linux build. If a future official darwin build ships a real `JNe`,
 * that logic — not a guess — is what should replace the stub below.
 */

/** Official `Lvn` @240801142 — byte-verbatim user-facing message. */
export const GIT_MISSING_MACOS_MESSAGE =
  'git is not installed on this Mac. To install it, run xcode-select --install, then try again.'

/** Official exit code paired with the message by the guard @240891566. */
export const GIT_MISSING_MACOS_EXIT_CODE = 127

/**
 * Official `JNe` @240801245 — the macOS git-missing predicate, a faithful FALSE
 * STUB. The recovered linux-x64 binary returns `!1` unconditionally regardless
 * of the file/env arguments, so the 127/Lvn guard never fires. Signature mirrors
 * the official `(file, env)` arity; both parameters are intentionally unused.
 */
export function isGitMissingOnMacos(
  _file: string,
  _env: Record<string, string | undefined> | undefined,
): boolean {
  return false
}
