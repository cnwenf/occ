import { describe, expect, test } from "bun:test";
import { substituteArguments } from "../argumentSubstitution";
import { MalformedCommandError } from "../errors";
import { addArgumentsToPrompt } from "../hooks/hookHelpers";

/**
 * CC 2.1.301 (occ160 WP-E) — two changelog entries, one mechanism (official
 * binary `bNe` @226104224, constants `var _pr=4e6,mSo=64,gSo=64` @226103760;
 * byte-verified ABSENT from the 2.1.300 `MLe` @225198782):
 *
 * 1. "Fixed skills and commands with very many or very long argument names
 *    stalling for seconds when invoked; only the first 64 names, each up to
 *    64 characters, are now filled in"
 *    - binary filter: `.filter((Q)=>Boolean(Q.name)&&Q.name.length<=gSo)`
 *      (@226104774) → names LONGER than 64 chars are SKIPPED (not truncated)
 *    - binary slice: `.slice(0,mSo)` BEFORE the longest-first sort → the
 *      first 64 surviving names in frontmatter DECLARATION order
 *
 * 2. "Fixed skills, commands and hooks using very large amounts of memory
 *    when their arguments fill many placeholders"
 *    - binary running budget `y`: starts at sanitized template length
 *      (`let y=e.length` @226104380), each insertValue adds the transformed
 *      value length; over `_pr` (4,000,000) throws `nT` (@216473037) with
 *      the message recovered @226104475. `nT` maps to `tool_malformed_command`
 *      in the official tool-error classifier (@228188773) → OCC throws
 *      MalformedCommandError. The hooks surface shares the same chokepoint
 *      (addArgumentsToPrompt → substituteArguments), so entry 2's "and hooks"
 *      is covered by the same budget.
 */

describe("substituteArguments — 2.1.301 named-arg count cap (mSo=64)", () => {
	test("only the first 64 declared names are filled; name 65 stays verbatim", () => {
		const names = Array.from({ length: 65 }, (_, i) => `arg${i}`);
		const args = names.map((_, i) => `v${i}`).join(" ");
		const template = names.map((n) => `$${n}`).join(" ");

		const out = substituteArguments(template, args, true, names);

		// First 64 substituted (declaration order → positional mapping intact).
		expect(out).toContain("v0");
		expect(out).toContain("v63");
		// Name #65 (index 64) is over the cap → placeholder NOT filled, and
		// its value never appears.
		expect(out).toContain("$arg64");
		expect(out).not.toContain("v64");
	});

	test("exactly 64 names: all filled (boundary, no regression)", () => {
		const names = Array.from({ length: 64 }, (_, i) => `n${i}`);
		const args = names.map((_, i) => `x${i}`).join(" ");
		const template = names.map((n) => `$${n}`).join(" ");

		const out = substituteArguments(template, args, true, names);

		for (let i = 0; i < 64; i++) {
			expect(out).toContain(`x${i}`);
		}
		expect(out).not.toMatch(/\$n\d/);
	});

	test("a skipped over-long name does not shift later names' positions", () => {
		// Binary maps name→index BEFORE filtering (`.map((Q,ye)=>({name:Q,i:ye}))`),
		// so name at position 1 still binds parsedArgs[1] even when position 0
		// was skipped for exceeding 64 chars.
		const longName = "L".repeat(65);
		const names = [longName, "ok"];
		const out = substituteArguments(
			`$${longName} $ok`,
			"first second",
			false,
			names,
		);
		expect(out).toContain(`$${longName}`); // skipped, verbatim
		expect(out).toContain("second"); // 'ok' → parsedArgs[1], unshifted
		expect(out).not.toContain("first");
	});

	test("bounded work: 2000 long names + 2000-placeholder body completes fast", () => {
		// The 2.1.300 code built one escape-pass alternation regex containing
		// EVERY declared name and ran one global replace pass per name —
		// seconds of stall with very many/very long names. With the cap the
		// alternation holds <=64 short names and at most 64 replace passes run.
		const names = Array.from({ length: 2000 }, (_, i) => `name${i}${"p".repeat(80)}`);
		const template = names.map((n) => `$${n}`).join("\n");
		const args = "a";

		const started = Date.now();
		const out = substituteArguments(template, args, false, names);
		const elapsed = Date.now() - started;

		// All 2000 names are >64 chars → none may be filled.
		expect(out).toContain(`$name0${"p".repeat(80)}`);
		// Timing sanity (generous bound; uncapped 2.1.300 behavior stalls far
		// longer building the 2000-branch alternation regex + 2000 passes).
		expect(elapsed).toBeLessThan(2000);
	});
});

describe("substituteArguments — 2.1.301 per-name length cap (gSo=64)", () => {
	test("a 64-char name is still filled (boundary)", () => {
		const name = "a".repeat(64);
		const out = substituteArguments(`$${name}`, "val", false, [name]);
		expect(out).toBe("val");
	});

	test("a 65-char name is SKIPPED, not truncated (binary name.length<=gSo)", () => {
		const name = "a".repeat(65);
		const out = substituteArguments(`hi $${name}`, "val", false, [name]);
		// Placeholder preserved verbatim; the official filter drops the name
		// entirely rather than filling a truncated 64-char prefix.
		expect(out).toBe(`hi $${name}`);
	});

	test("over-long name skipped while sibling short name still fills", () => {
		const longName = "b".repeat(100);
		const out = substituteArguments(
			`$short and $${longName}`,
			"one two",
			false,
			["short", longName],
		);
		expect(out).toBe(`one and $${longName}`);
	});
});

describe("substituteArguments — 2.1.301 expansion budget (_pr=4,000,000)", () => {
	test("many placeholders × huge args throws MalformedCommandError", () => {
		// 5 $ARGUMENTS placeholders × ~1M-char value → running budget passes
		// 4,000,000 mid-expansion. Official message recovered @226104475.
		const big = "x".repeat(1_000_000);
		const template = "$ARGUMENTS $ARGUMENTS $ARGUMENTS $ARGUMENTS $ARGUMENTS";

		expect(() => substituteArguments(template, big, false)).toThrow(
			MalformedCommandError,
		);
		expect(() => substituteArguments(template, big, false)).toThrow(
			"This skill, command or hook and the arguments filled into it add up to more than 4,000,000 characters. Use shorter arguments or fewer placeholders such as $ARGUMENTS.",
		);
	});

	test("budget covers named-arg values too", () => {
		// Two ~1.1M-char shell tokens (under the parser's ~1.2M single-token
		// ceiling) bound to two declared names; 4 fills × 1.1M > 4M budget.
		const big = "y".repeat(1_100_000);
		const args = `${big} ${big}`;
		expect(() =>
			substituteArguments("$a $b $a $b", args, false, ["a", "b"]),
		).toThrow(MalformedCommandError);
	});

	test("under budget: large-but-legal expansion succeeds (boundary)", () => {
		// 2 × 1.5M = 3M < 4M → no throw.
		const big = "z".repeat(1_500_000);
		const out = substituteArguments("$ARGUMENTS|$ARGUMENTS", big, false);
		expect(out.length).toBe(1_500_000 * 2 + 1);
	});

	test("normal-size expansion unchanged (no regression)", () => {
		expect(substituteArguments("do $0 with $ARGUMENTS", "the thing")).toBe(
			"do the with the thing",
		);
		expect(substituteArguments("run: $ARGUMENTS", "a b c")).toBe("run: a b c");
	});

	test("hooks surface (addArgumentsToPrompt) shares the budget — entry 2 'and hooks'", () => {
		// Official hooks expansion is the same chokepoint; a huge hook-input
		// JSON filling several placeholders is bounded the same way. Payload
		// sized under the shell parser's ~1.2M single-token ceiling.
		const hugeJson = JSON.stringify({ payload: "h".repeat(1_100_000) });
		const prompt =
			"Judge: $ARGUMENTS\nAgain: $ARGUMENTS\nThird: $ARGUMENTS\nFourth: $ARGUMENTS";
		expect(() => addArgumentsToPrompt(prompt, hugeJson)).toThrow(
			MalformedCommandError,
		);
		// And a normal hook prompt still works.
		expect(addArgumentsToPrompt("Judge: $ARGUMENTS", '{"a":1}')).toBe(
			'Judge: {"a":1}',
		);
	});
});
