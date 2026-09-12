import { describe, expect, test } from "bun:test";
import { formatCompactSummary } from "../prompt.js";

/**
 * 2.1.268 alignment (official `wws` fix): the <summary> replacement must use
 * a REPLACER FUNCTION, not a replacement string. Model-written summaries
 * routinely contain `$` patterns ($&, $', $`, $1, $$, $99); with a replacement
 * string, String.prototype.replace expands them against the match and
 * corrupts the summary. A replacer function's return value is used verbatim.
 *
 * Official (byte-verified from the 2.1.268 linux-x64 ELF):
 *   n.replace(/<summary>([\s\S]*?)<\/summary>/,(r,o)=>`Summary:\n${o.trim()}`)
 */
describe("formatCompactSummary $-pattern safety (2.1.268)", () => {
  test("$& passes through literally instead of expanding to the whole match", () => {
    const input = "<summary>cost is $& here</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\ncost is $& here");
  });

  test("$' passes through literally instead of expanding to the after-match text", () => {
    const input = "PRE <summary>a $' b</summary> POST";
    expect(formatCompactSummary(input)).toBe("PRE Summary:\na $' b POST");
  });

  test("$` passes through literally instead of expanding to the before-match text", () => {
    const input = "PRE <summary>uses $` pattern</summary>";
    expect(formatCompactSummary(input)).toBe("PRE Summary:\nuses $` pattern");
  });

  test("$1 passes through literally (capture group 1 text is not re-expanded)", () => {
    const input = "<summary>group $1 test</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\ngroup $1 test");
  });

  test("$$ passes through literally instead of collapsing to a single $", () => {
    const input = "<summary>price $$ USD</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\nprice $$ USD");
  });

  test("$99 passes through literally", () => {
    const input = "<summary>issue $99</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\nissue $99");
  });

  test("combined $ patterns in one summary all survive verbatim", () => {
    const input = "<summary>$& $' $` $1 $$ $99</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\n$& $' $` $1 $$ $99");
  });

  test("<analysis> block is still stripped", () => {
    const input =
      "<analysis>scratch $& pad</analysis>\n<summary>kept $' content</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\nkept $' content");
  });

  test("summary content is trimmed and prefixed with the exact Summary:\\n header", () => {
    const input = "<summary>\n  line1\n  line2\n</summary>";
    expect(formatCompactSummary(input)).toBe("Summary:\nline1\n  line2");
  });

  test("input without a <summary> tag is unchanged (apart from final trim)", () => {
    const input = "plain text, no tags here $& $$";
    expect(formatCompactSummary(input)).toBe(input);
  });
});
