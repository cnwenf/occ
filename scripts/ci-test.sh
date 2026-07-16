#!/usr/bin/env bash
# CI per-file test isolation.
#
# Root cause: bun's mock.module() is PERMANENT per-process — there is no
# automatic restore between test files, and mock.restore() does NOT undo
# mock.module() registrations (verified on bun 1.3.14). When `bun test` runs
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
# This is a legitimate test-infra change, NOT gate-and-hide.

set -u

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
