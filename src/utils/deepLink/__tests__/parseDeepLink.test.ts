import { describe, expect, test } from "bun:test";
import { parseDeepLink, buildDeepLink } from "../parseDeepLink";

/**
 * claude-code 2.1.91: multi-line prompts in `claude-cli://open?q=` deep links
 * are supported — encoded newlines (`%0A`) are no longer rejected. CRLF / lone
 * CR are normalized to LF; tabs are allowed; other control chars still reject.
 */

describe("2.1.91 multi-line deep-link queries", () => {
  test("accepts a query with encoded newlines (%0A)", () => {
    const uri = "claude-cli://open?q=line1%0Aline2";
    const action = parseDeepLink(uri);
    expect(action.query).toBe("line1\nline2");
  });

  test("accepts a query with encoded tabs (%09)", () => {
    const uri = "claude-cli://open?q=col1%09col2";
    expect(parseDeepLink(uri).query).toBe("col1\tcol2");
  });

  test("normalizes CRLF (%0D%0A) to LF", () => {
    const uri = "claude-cli://open?q=line1%0D%0Aline2";
    expect(parseDeepLink(uri).query).toBe("line1\nline2");
  });

  test("normalizes a lone CR (%0D) to LF", () => {
    const uri = "claude-cli://open?q=line1%0Dline2";
    expect(parseDeepLink(uri).query).toBe("line1\nline2");
  });

  test("still rejects other control characters (e.g. NUL %00)", () => {
    expect(() => parseDeepLink("claude-cli://open?q=hi%00there")).toThrow(
      /control characters/,
    );
  });

  test("still rejects a vertical tab (%0B) in the query", () => {
    expect(() => parseDeepLink("claude-cli://open?q=hi%0Bthere")).toThrow(
      /control characters/,
    );
  });

  test("cwd still rejects newlines (strict — no allowNewlineAndTab)", () => {
    expect(() =>
      parseDeepLink("claude-cli://open?cwd=/foo%0Abar"),
    ).toThrow(/control characters/);
  });
});

describe("parseDeepLink: basic shape (regression)", () => {
  test("parses a simple query", () => {
    expect(parseDeepLink("claude-cli://open?q=hello").query).toBe("hello");
  });
  test("parses cwd + repo", () => {
    const a = parseDeepLink("claude-cli://open?cwd=/x/y&repo=o/r");
    expect(a.cwd).toBe("/x/y");
    expect(a.repo).toBe("o/r");
  });
  test("buildDeepLink round-trips a multi-line query", () => {
    const uri = buildDeepLink({ query: "line1\nline2" });
    expect(parseDeepLink(uri).query).toBe("line1\nline2");
  });
});
