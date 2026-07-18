import { describe, expect, test } from "bun:test";
import { exit2BlockReason } from "../hookExit2Block";

/**
 * S24 (Claude Code 2.1.214): a hook that exits with code 2 MUST block, even
 * when its stdout JSON fails schema validation (malformed / truncated / wrong
 * shape). Previously the validationError branch short-circuited to
 * non_blocking_error (executeHooks) / throw (executeHooksOutsideREPL) before
 * the exit-2 block check — dropping the block. Fail-open on a security hook
 * enforcement path.
 *
 * Red-test checklist (OCC-10 / S24, security reviewer):
 *  1. exit 2 + truncated/malformed JSON → block
 *  2. exit 2 + `{"foo":1}` (valid JSON, schema fail) → block
 *  3. exit 2 + valid block JSON → do NOT synthesize (let the structured path
 *     keep the hook's reason) — regression guard
 *  4. exit 0 + malformed JSON → do NOT block (stay non_blocking_error; do not
 *     reverse-enlarge)
 */

const base = {
  stderr: "boom",
  command: "hook.sh",
};

describe("S24 (2.1.214): exit2BlockReason", () => {
  test("exit 2 + malformed/truncated JSON → block", () => {
    const r = exit2BlockReason({
      ...base,
      status: 2,
      validationError: "Hook JSON output validation failed",
      hasJson: false,
    });
    expect(r).not.toBeNull();
    expect(r?.command).toBe("hook.sh");
    expect(r?.blockingError).toContain("boom");
  });

  test("exit 2 + valid-but-schema-failing JSON ({foo:1}) → block", () => {
    const r = exit2BlockReason({
      ...base,
      status: 2,
      validationError: "Hook JSON output validation failed",
      hasJson: true,
    });
    expect(r).not.toBeNull();
    expect(r?.blockingError).toContain("boom");
  });

  test("exit 2 + VALID block JSON → null (structured path keeps reason)", () => {
    const r = exit2BlockReason({
      ...base,
      status: 2,
      validationError: undefined,
      hasJson: true,
    });
    expect(r).toBeNull();
  });

  test("exit 0 + malformed JSON → null (non_blocking_error, NOT block)", () => {
    const r = exit2BlockReason({
      ...base,
      status: 0,
      validationError: "Hook JSON output validation failed",
      hasJson: false,
    });
    expect(r).toBeNull();
  });

  test("non-2 exit + valid JSON → null", () => {
    const r = exit2BlockReason({
      ...base,
      status: 0,
      validationError: undefined,
      hasJson: true,
    });
    expect(r).toBeNull();
  });

  test("exit 2 + no stderr → fallback reason text", () => {
    const r = exit2BlockReason({
      stderr: "",
      command: "h",
      status: 2,
      validationError: "bad json",
      hasJson: false,
    });
    expect(r).not.toBeNull();
    expect(r?.blockingError).toContain("No stderr output");
  });
});
