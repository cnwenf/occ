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

	test("$ARGUMENTS[N] unmatched mid-sentence is preserved; all-miss appends args (2.1.233)", () => {
		// Official 2.1.233 sCt: the placeholder is preserved verbatim AND the
		// append gate is the substitution flag, so an all-miss template still
		// gets "\nARGUMENTS: <args>" appended (single \n).
		expect(substituteArguments("a $ARGUMENTS[1] b", "foo")).toBe(
			"a $ARGUMENTS[1] b\nARGUMENTS: foo",
		);
	});

	test("all $ARGUMENTS[N] unmatched: preserved, args appended (2.1.233)", () => {
		// Official appends on all-miss (binary sCt `if (!c && r && t)`); the
		// pinned pre-233 expectation ("$ARGUMENTS[1]" alone) was the old
		// string-equality gate behavior.
		expect(substituteArguments("$ARGUMENTS[1]", "foo")).toBe(
			"$ARGUMENTS[1]\nARGUMENTS: foo",
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

// 2.1.233 (OCC-95): the official sCt security rework — substituted values are
// sentinel-shielded so later passes cannot re-expand $-markers inside them,
// sentinel chars in user input are sanitized against forgery, the \$ escape is
// scoped to marker lookahead, named args are regex-escaped and substituted
// longest-first, and the append gate is the substitution flag. Every expected
// value below was verified against a byte-faithful reconstruction of the
// official 2.1.233 sCt.
describe("substituteArguments - 2.1.233 sCt security rework", () => {
	// Sentinel chars built from char codes to keep this file pure ASCII.
	const SHIELDED_DOLLAR = String.fromCharCode(0xffff);
	const VALUE_BOUNDARY = String.fromCharCode(0xfffe);
	const SENTINEL_REPLACEMENT = String.fromCharCode(0xfffd);

	test("a value containing $0 is NOT re-expanded by the $n pass", () => {
		// named arg msg -> "hi$0bye"; the $0 inside the value stays literal.
		expect(substituteArguments("Say $msg", "hi$0bye extra", true, ["msg"])).toBe(
			"Say hi$0bye",
		);
	});

	test("a value containing $ARGUMENTS stays literal", () => {
		expect(
			substituteArguments("A $msg B", "x$ARGUMENTSx", true, ["msg"]),
		).toBe("A x$ARGUMENTSx B");
	});

	test("a value containing a declared $name stays literal", () => {
		expect(substituteArguments("A $msg B", "x$msgx", true, ["msg"])).toBe(
			"A x$msgx B",
		);
	});

	test("a value with a shell-escaped $0 (\\$0 -> $0) stays literal", () => {
		// parseArguments unescapes \$ to $ (shell semantics), so sCt receives
		// the value "a$0b"; the $0 inside must NOT be re-expanded to the arg
		// itself. Without the 2.1.233 shielding this would recurse into the
		// value's own content.
		expect(substituteArguments("A $0 B", "a\\$0b", true)).toBe("A a$0b B");
	});

	test("named args are regex-escaped (a dot in the name is literal)", () => {
		// Without escapeRegExp, /$a.b/ with . as wildcard would also match $aXb.
		expect(substituteArguments("$a.b $aXb", "x", true, ["a.b"])).toBe(
			"x $aXb",
		);
	});

	test("named args substitute longest name first", () => {
		// names [a, ab]: ab -> index 1, a -> index 0; longest first avoids
		// $a swallowing the $ab placeholder.
		expect(substituteArguments("$ab $a", "x y", true, ["a", "ab"])).toBe(
			"y x",
		);
	});

	test("\\$ before a named marker escapes it", () => {
		expect(substituteArguments("\\$foo $foo", "v", true, ["foo"])).toBe(
			"$foo v",
		);
	});

	test("\\\\$0 (double backslash) keeps the marker live", () => {
		// Escape-pass lookbehind: the \$ is preceded by a backslash, so it is
		// NOT shielded and $0 still substitutes; both backslashes survive.
		expect(substituteArguments("\\\\$0", "foo")).toBe("\\\\foo");
	});

	test("sentinel chars in the template are sanitized, not honored", () => {
		// Forged U+FFFF/U+FFFE in user content become U+FFFD and cannot
		// smuggle a fake shielded $ or fake value boundary through.
		expect(
			substituteArguments(`${SHIELDED_DOLLAR} $0 ${VALUE_BOUNDARY}`, "foo"),
		).toBe(`${SENTINEL_REPLACEMENT} foo ${SENTINEL_REPLACEMENT}`);
	});

	test("sentinel chars in the args value are sanitized, not honored", () => {
		expect(
			substituteArguments("v=$0", `a${SHIELDED_DOLLAR}b${VALUE_BOUNDARY}c`),
		).toBe(`v=a${SENTINEL_REPLACEMENT}b${SENTINEL_REPLACEMENT}c`);
	});

	test("all-miss template appends args with a single newline", () => {
		expect(substituteArguments("no markers", "foo")).toBe(
			"no markers\nARGUMENTS: foo",
		);
	});

	test("all-miss append is suppressed when appendIfNoPlaceholder=false", () => {
		expect(substituteArguments("a $ARGUMENTS[1] b", "foo", false)).toBe(
			"a $ARGUMENTS[1] b",
		);
	});

	test("empty args never append", () => {
		expect(substituteArguments("no markers", "")).toBe("no markers");
	});

	test("appended args are themselves shielded from re-expansion", () => {
		// The appended value goes through insertValue too: $0 inside stays.
		expect(substituteArguments("no markers", "x$0y")).toBe(
			"no markers\nARGUMENTS: x$0y",
		);
	});
});
