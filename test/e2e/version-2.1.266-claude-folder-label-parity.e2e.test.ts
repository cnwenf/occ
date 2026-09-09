import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

const readSrc = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8");

/**
 * OCC-81 alignment pin — `.claude` folder permission-option label parity with
 * official claude-code 2.1.266. Byte-level forensics on the official linux-x64
 * ELF recovered the label logic verbatim (function `rBo`, renderLabel region):
 *
 *   function rBo(w,P,ee){let ce=eBo(w),ge=tBo(w);if((ce||ge)&&P!=="read"){
 *     let Xe=ge?gRt:mRt, ...
 *     return ge
 *       ? "Yes, and allow Claude to edit files in its ~/.claude folder for this session"
 *       : "Yes, and allow Claude to edit files in this project's .claude folder for this session"
 *   }});
 *   return st===null?null:{row:st,value:"yes-claude-folder"}
 *
 * with paired rule-pattern constants gRt="~/.claude/**" (global) and
 * mRt="/.claude/**" (project) — matching OCC's existing
 * GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN / CLAUDE_FOLDER_PERMISSION_PATTERN.
 *
 * String counts across official binaries: the stale 2.1.263 static label
 * "Yes, and allow Claude to edit its own settings for this session" appears
 * 263=2 / 266=0; the two new 266 labels appear 263=0 / 266=3;
 * `value:"yes-claude-folder"` is identical in both versions. OCC carried the
 * 263 static label — this test pins the official 266 strings and forbids the
 * stale variant from returning. Behavioral coverage (real
 * getFilePermissionOptions() calls) lives in
 * src/components/permissions/FilePermissionDialog/__tests__/claudeFolderLabel266.test.ts.
 */
describe("OCC-81: .claude folder permission option matches official 2.1.266", () => {
  test("project branch renders the official project-folder label", () => {
    const src = readSrc("src/components/permissions/FilePermissionDialog/permissionOptions.tsx");
    expect(src).toContain(
      "Yes, and allow Claude to edit files in this project's .claude folder for this session",
    );
  });

  test("global branch renders the official ~/.claude-folder label", () => {
    const src = readSrc("src/components/permissions/FilePermissionDialog/permissionOptions.tsx");
    expect(src).toContain(
      "Yes, and allow Claude to edit files in its ~/.claude folder for this session",
    );
  });

  test("stale pre-2.1.266 static label must not return", () => {
    const src = readSrc("src/components/permissions/FilePermissionDialog/permissionOptions.tsx");
    expect(src).not.toContain("edit its own settings for this session");
  });
});
