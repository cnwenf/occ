import { describe, expect, test } from "bun:test";
import {
	parseArgumentNames,
	parseArguments,
	substituteArguments,
} from "../argumentSubstitution";

describe("parseArguments", () => {
	test("splits on whitespace", () => {
		expect(parseArguments("foo bar baz")).toEqual(["foo", "bar", "baz"]);
	});

	test("handles quoted strings", () => {
		expect(parseArguments('foo "hello world" baz')).toEqual([
			"foo",
			"hello world",
			"baz",
		]);
	});

	test("empty string yields no args", () => {
		expect(parseArguments("")).toEqual([]);
	});

	test("whitespace-only yields no args", () => {
		expect(parseArguments("   ")).toEqual([]);
	});

	test("quoted empty string is a single empty arg", () => {
		// Distinct from "no args": this is one explicitly-empty positional arg.
		expect(parseArguments("''")).toEqual([""]);
	});
});

describe("parseArgumentNames", () => {
	test("splits a space-separated string", () => {
		expect(parseArgumentNames("foo bar baz")).toEqual(["foo", "bar", "baz"]);
	});

	test("accepts an array", () => {
		expect(parseArgumentNames(["foo", "bar"])).toEqual(["foo", "bar"]);
	});

	test("filters out numeric-only names (they collide with $0/$1 shorthand)", () => {
		expect(parseArgumentNames("foo 1 2bar")).toEqual(["foo", "2bar"]);
	});

	test("returns [] for undefined", () => {
		expect(parseArgumentNames(undefined)).toEqual([]);
	});
});

describe("substituteArguments - matched substitution", () => {
	test("$N shorthand substitutes indexed args", () => {
		expect(substituteArguments("$0 $1", "foo bar")).toBe("foo bar");
	});

	test("$ARGUMENTS[N] substitutes indexed args", () => {
		expect(
			substituteArguments("$ARGUMENTS[0] $ARGUMENTS[1]", "foo bar"),
		).toBe("foo bar");
	});

	test("named args substitute declared names", () => {
		expect(
			substituteArguments("$foo $bar", "foo bar", true, ["foo", "bar"]),
		).toBe("foo bar");
	});

	test("$ARGUMENTS (full) substitutes the whole arg string", () => {
		expect(substituteArguments("args: $ARGUMENTS", "foo bar")).toBe(
			"args: foo bar",
		);
	});
});

// 2.1.210 #15: unmatched positional placeholders ($N, $ARGUMENTS[N]) are
// preserved verbatim instead of silently stripped to ''. This mirrors the
// official binary, which guards each substitution with `s[index] === void 0`
// and returns the matched placeholder text when the index is unset. An
// explicit empty-string arg (parsedArgs[index] === "") is NOT undefined and
// still substitutes to '' — the "empty arg supplied" case is distinct from
// "no arg at that index".
describe("substituteArguments - 2.1.210 unmatched placeholders preserved verbatim", () => {
	test("$N unmatched is preserved (matched $0 still substitutes)", () => {
		// parsedArgs = ["foo"]; $0 -> "foo", $1 -> undefined -> preserved as $1
		expect(substituteArguments("hello $0 $1", "foo")).toBe("hello foo $1");
	});

	test("$N unmatched preserves the original placeholder text, not empty", () => {
		// With appendIfNoPlaceholder=false to isolate the preserve behavior.
		expect(substituteArguments("hello $0 $1", "foo", false)).toBe(
			"hello foo $1",
		);
	});

	test("$ARGUMENTS[N] unmatched is preserved verbatim", () => {
		// $ARGUMENTS[0] -> "foo"; [1] and [2] unmatched -> preserved literally,
		// including the $ARGUMENTS prefix (protected from the $ARGUMENTS
		// replaceAll by the escaped-dollar sentinel).
		expect(
			substituteArguments(
				"$ARGUMENTS[0] $ARGUMENTS[1] $ARGUMENTS[2]",
				"foo",
			),
		).toBe("foo $ARGUMENTS[1] $ARGUMENTS[2]");
	});

	test("$ARGUMENTS[N] unmatched is preserved mid-sentence without extra space", () => {
		expect(substituteArguments("a $ARGUMENTS[1] b", "foo")).toBe(
			"a $ARGUMENTS[1] b",
		);
	});

	test("all $ARGUMENTS[N] unmatched: preserved, no stray $ARGUMENTS expansion", () => {
		expect(substituteArguments("$ARGUMENTS[1]", "foo")).toBe(
			"$ARGUMENTS[1]",
		);
	});

	test("$N unmatched adjacent to text is preserved without added space", () => {
		// parsedArgs = ["foo"]; $1 (index 1) is unmatched -> preserved as $1.
		expect(substituteArguments("a$1b", "foo", false)).toBe("a$1b");
	});

	test("explicit empty-string arg substitutes to '' (distinct from unmatched)", () => {
		// parsedArguments("''") = [""] — index 0 holds the empty string, which
		// is NOT undefined, so $0 substitutes to '' rather than being preserved.
		expect(substituteArguments("$0", "''")).toBe("");
	});

	test("empty raw arg string preserves unmatched $N (no arg supplied at any index)", () => {
		// parseArguments("") = [] — every index is undefined -> preserved.
		expect(substituteArguments("$0", "")).toBe("$0");
	});

	test("undefined args returns content unchanged (early return)", () => {
		expect(substituteArguments("$0", undefined)).toBe("$0");
	});

	test("null args returns content unchanged (early return)", () => {
		expect(substituteArguments("$0", null)).toBe("$0");
	});
});

// 2.1.210 only fixes POSITIONAL placeholders ($N, $ARGUMENTS[N]). The named
// args loop is unchanged in the official binary: a declared-but-unmatched
// named placeholder is still substituted to '' (stripped), matching upstream.
// An UNDECLARED named placeholder (not in argumentNames) is never touched and
// therefore remains verbatim — this was already the case pre-2.1.210.
describe("substituteArguments - named args unchanged by 2.1.210", () => {
	test("declared-but-unmatched named arg is still stripped (regression guard)", () => {
		// $foo -> "foo"; $bar is declared (in names) but index 1 is unset ->
		// stripped to '' (not preserved). Mirrors the official 2.1.210 binary.
		expect(
			substituteArguments("$foo $bar", "foo", true, ["foo", "bar"]),
		).toBe("foo ");
	});

	test("undeclared named placeholder is left verbatim (never matched)", () => {
		// $bar is not in argumentNames, so the named loop never matches it.
		expect(substituteArguments("$foo $bar", "foo", true, ["foo"])).toBe(
			"foo $bar",
		);
	});
});

// 2.1.163 regression guard: \$ escapes a literal $ so \$ARGUMENTS / \$5 are
// not expanded. This must keep working alongside the 2.1.210 preserve fix.
describe("substituteArguments - 2.1.163 \\$ escape (regression guard)", () => {
	test("\\$0 stays a literal $0 while $0 still substitutes", () => {
		expect(substituteArguments("\\$0 $0", "foo")).toBe("$0 foo");
	});
});
