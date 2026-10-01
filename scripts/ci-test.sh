#!/usr/bin/env bash
# CI per-file test isolation.
#
# Root cause: bun's mock.module() is PERMANENT per-process — there is no
# automatic restore between test files, and mock.restore() does NOT undo
# mock.module() registrations (verified on bun 1.3.14 and 1.4.2). When `bun test` runs
# all files in a single process, a file that calls mock.module() on a shared
# module (auth, analytics, growthbook, config, hooks, etc.) leaks that mock
# to ALL subsequent files, breaking their assertions.
#
# Additionally, several modules memoize state at module scope (settings cache,
# analytics sink registry, credential provider cache, global config cache).
# This state also leaks across files in a shared process.
#
# Fix: run each test file in its OWN bun process. This is what Jest/Vitest do
# by default (default test isolation = per-file process). Each file gets a
# fresh module registry → no mock.module leak → no memoized-state leak.
#
# OCC-129 evaluation (bun 1.4.2): bun's native `bun test --isolate` (fresh
# global object per file, single process) also eliminates the leak class —
# shared-process `bun test src/utils` fails 27 tests, `--isolate` fails 0.
# We keep this per-file-process loop anyway: it gives per-file pass/fail
# reporting in the CI log, maximal isolation (fresh OS process also resets
# module-scope memoized state, env mutations, and timers), and is version-
# independent. `--isolate` is the validated fallback if this loop ever needs
# replacing. Upgrading bun alone does NOT fix the leak (1.3.14 → 1.4.2 both
# leak in a shared process); it is a module-registry design property.
#
# This is a legitimate test-infra change, NOT gate-and-hide.

set -u

# ---------------------------------------------------------------------------
# Provide a dummy ANTHROPIC_API_KEY when one is not already set.
#
# Why (this is the CI-vs-local environment difference, OCC-129 problem 1):
# getAnthropicApiKeyWithSource() in src/utils/auth.ts has a CI/test guard that
# fires when process.env.CI is truthy (GitHub Actions sets CI=true on every job)
# OR NODE_ENV === 'test', and THROWS
#   "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required"
# when no credential is present. That guard is ported faithfully from the
# official binary and is intentionally NOT modified.
#
# Dev machines always export a real ANTHROPIC_API_KEY, so the guard never fires
# and the affected files pass locally. CI has no credential, so the 8 logic/e2e
# files that transitively reach the guard (effort resolution, auth-status --json
# shape, fast-mode watchdog retry, unknown-command parity, prompt-cache TTL,
# hook exit-2 blocking) failed on the throw above. NONE of them make a real API
# call — they only need the credential-presence check to pass.
#
# The fix restores parity with the local environment: ensure a key is present.
# The `:-` default means a real key (dev machine, or a secret injected into CI)
# ALWAYS wins, so this dummy is used only when nothing is set. It is an obvious
# non-secret placeholder, matching the value the prompt-cache-ttl unit test
# already uses. e2e child processes (runOcc -> dist/cli.js) inherit it through
# process.env (see test/e2e/helpers.ts).
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-test-dummy}"

FAIL=0
TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_FAIL=0
FILE_COUNT=0
FAILED_FILES=()

# Collect all test files (sorted for deterministic ordering).
mapfile -t TEST_FILES < <(find src test -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)

echo "Found ${#TEST_FILES[@]} test files"
echo "Running each in a separate bun process (per-file isolation)..."
echo ""

for f in "${TEST_FILES[@]}"; do
  FILE_COUNT=$((FILE_COUNT + 1))
  # --timeout 10000: per-test timeout (CLI flag; bunfig.toml [test] timeout
  # doesn't work in bun 1.3.14, CLI flag is the fallback).
  OUTPUT=$(bun test "$f" --timeout 10000 2>&1)
  EXIT_CODE=$?

  # Extract counts from the last summary line.
  # Bun prints: "  N pass  M fail  K skip" or similar.
  PASS_COUNT=$(echo "$OUTPUT" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
  FAIL_COUNT=$(echo "$OUTPUT" | grep -oE '[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || echo 0)
  SKIP_COUNT=$(echo "$OUTPUT" | grep -oE '[0-9]+ skip' | tail -1 | grep -oE '[0-9]+' || echo 0)

  TOTAL_PASS=$((TOTAL_PASS + PASS_COUNT))
  TOTAL_SKIP=$((TOTAL_SKIP + SKIP_COUNT))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL_COUNT))

  if [ "$EXIT_CODE" -ne 0 ]; then
    FAIL=1
    FAILED_FILES+=("$f")
    echo "FAIL  $f  ($FAIL_COUNT fail, $PASS_COUNT pass, $SKIP_COUNT skip)"
    # Print the failing test output for CI log readability.
    echo "$OUTPUT" | grep -E '^\s*\(fail\)|^\s*✗|error:|Error:' | head -10
    echo ""
  else
    echo "OK    $f  ($PASS_COUNT pass, $SKIP_COUNT skip)"
  fi
done

# ---------------------------------------------------------------------------
# Same-worker mock-leak regression (OCC-103 round-3 re-acceptance, P2).
#
# The per-file isolation above means cross-file mock.module() leaks can NEVER
# manifest in CI — which also means a REGRESSION of the leak-repair pattern
# would ship green. Concretely: src/tools/shared/__tests__/settingSourcesPropagation281.test.ts
# mocks ../../../bootstrap/state.js with the delegation pattern (real getters
# captured by value in beforeAll; a `mockActive` flag flipped to false in
# afterAll so the mocked getters pass through to the REAL implementations for
# every later file in the same process). If someone "simplifies" that afterAll
# back to a plain mock.module(..., () => actualStateModule) spread — or removes
# it — every file that runs AFTER the polluter in one shared process gets
# frozen stub values (getFlagSettingSourcesRaw() → ['user'] etc.), and
# src/cli/handlers/__tests__/mcpGetDynamicScope285.test.ts fails.
#
# So we run the polluter → victim pair in ONE bun process here (polluter first,
# order matters — bun executes the files in the order given). GREEN requires
# the afterAll pass-through to actually serve the real getters; RED is the
# exact round-3 documented failure signature. This step is the CI enforcement
# that per-file isolation structurally cannot provide. Mutation-verified:
# reverting the afterAll to the old spread pattern turns this pair RED.
echo "Same-worker mock-leak regression (polluter -> victim pair, single process)..."
LEAK_PAIR_POLLUTER="src/tools/shared/__tests__/settingSourcesPropagation281.test.ts"
LEAK_PAIR_VICTIM="src/cli/handlers/__tests__/mcpGetDynamicScope285.test.ts"
# bun test treats positional args as FILTERS — a renamed/moved file would
# silently match nothing and the pair would "pass" with only one file run.
# Fail loudly if either side of the pair disappears.
if [ ! -f "$LEAK_PAIR_POLLUTER" ] || [ ! -f "$LEAK_PAIR_VICTIM" ]; then
  FAIL=1
  FAILED_FILES+=("same-worker leak pair (test file missing — update the pair paths)")
  echo "FAIL  same-worker leak pair: polluter or victim file not found"
  echo "      expected: $LEAK_PAIR_POLLUTER"
  echo "                $LEAK_PAIR_VICTIM"
  echo ""
else
LEAK_PAIR_OUTPUT=$(bun test "$LEAK_PAIR_POLLUTER" "$LEAK_PAIR_VICTIM" --timeout 10000 2>&1)
LEAK_PAIR_EXIT=$?
LEAK_PAIR_PASS=$(echo "$LEAK_PAIR_OUTPUT" | grep -oE '[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || echo 0)
LEAK_PAIR_FAIL=$(echo "$LEAK_PAIR_OUTPUT" | grep -oE '[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || echo 0)
LEAK_PAIR_FILES=$(echo "$LEAK_PAIR_OUTPUT" | grep -oE 'across [0-9]+ files?' | tail -1 | grep -oE '[0-9]+' || echo 0)
TOTAL_PASS=$((TOTAL_PASS + LEAK_PAIR_PASS))
TOTAL_FAIL=$((TOTAL_FAIL + LEAK_PAIR_FAIL))
if [ "$LEAK_PAIR_EXIT" -ne 0 ] || [ "$LEAK_PAIR_FAIL" -ne 0 ] || [ "$LEAK_PAIR_FILES" -ne 2 ]; then
  FAIL=1
  FAILED_FILES+=("$LEAK_PAIR_POLLUTER + $LEAK_PAIR_VICTIM (same-worker pair)")
  echo "FAIL  same-worker leak pair  ($LEAK_PAIR_FAIL fail, $LEAK_PAIR_PASS pass, $LEAK_PAIR_FILES files)"
  echo "      A failure here means the bootstrap/state.js mock-leak repair"
  echo "      (settingSourcesPropagation281 afterAll delegation) has regressed."
  echo "$LEAK_PAIR_OUTPUT" | grep -E '^\s*\(fail\)|^\s*✗|error:|Error:' | head -10
  echo ""
else
  echo "OK    same-worker leak pair  ($LEAK_PAIR_PASS pass across $LEAK_PAIR_FILES files)"
fi
fi

echo ""
echo "============================================"
echo "  Total: $TOTAL_PASS pass / $TOTAL_FAIL fail / $TOTAL_SKIP skip"
echo "  Files: $FILE_COUNT checked, ${#FAILED_FILES[@]} failed"
echo "============================================"

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "FAILED FILES:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

exit 0
