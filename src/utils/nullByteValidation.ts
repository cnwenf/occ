import type { ValidationResult } from '../Tool.js'

/**
 * CC 2.1.281 changelog #040 (security) — shared null-byte path validator.
 *
 * Byte-verified against the official v2.1.281 linux-x64 ELF `fy(e,n)`
 * @201072355:
 *
 *   function fy(e,n){let r=n.find(([,s])=>s?.includes("\x00"));
 *     if(r)return{result:!1,message:
 *       `${e} ${r[0]} cannot contain null bytes (\\0). Remove the null byte and try again.`,
 *       errorCode:2};return null}
 *
 * In v280 the identical helper (`l8()` @198504766) existed but was wired
 * ONLY into Glob/Grep. v281 wires it into the four file tools' validateInput
 * BEFORE any expandPath call:
 * - Write       `fy(vn,[["file_path",g]])`  @201120196
 * - Read        `fy(lt,[["file_path",g]])`  @201304178 (check runs FIRST,
 *               before the pages validation)
 * - Edit        `fy(Pt,[["file_path",g]])`  @203959556
 * - NotebookEdit`fy(lc,[["notebook_path",n]])` @203972885 (check first, then
 *               expandPath `Qe(n)`, then the `.ipynb` extension check)
 *
 * Why it matters: without this, a `\0` inside a path input reaches
 * `expandPath` (utils/path.ts), which THROWS — and an exception out of
 * validateInput ends the whole turn. The official behavior is a per-call
 * validation error (errorCode 2) so the model can retry with a clean path.
 *
 * Glob/Grep keep their existing inline equivalents (GlobTool.ts:121,
 * GrepTool.ts:265) — identical message format, already at parity.
 */
export function validateNullByteFreeFields(
  toolName: string,
  fields: ReadonlyArray<readonly [string, unknown]>,
): ValidationResult | null {
  const nullByteField = fields.find(
    ([, value]) => typeof value === 'string' && value.includes('\0'),
  )
  if (nullByteField === undefined) {
    return null
  }
  return {
    result: false,
    message: `${toolName} ${nullByteField[0]} cannot contain null bytes (\\0). Remove the null byte and try again.`,
    errorCode: 2,
  }
}
