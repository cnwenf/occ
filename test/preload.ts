/**
 * Test preload: disable ANSI color emission in spawned subprocesses.
 *
 * The Claude Code session exports FORCE_COLOR=1, so e2e tests that spawn
 * `bun -e <script>` or `dist/cli.js` and assert on stdout get ANSI-coded
 * output (e.g. `\x1b[33mtrue\x1b[0m` instead of `true`), breaking string
 * equality. Setting NO_COLOR=1 (per no-color.org, takes precedence) and
 * FORCE_COLOR=0 on the test process propagates to every spawned child via
 * inherited env, so assertions match plain text.
 *
 * No test in this repo asserts on raw ANSI codes (verified via grep), so
 * disabling color globally is safe for both unit and e2e suites.
 */
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
