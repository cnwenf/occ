/**
 * CC 2.1.311 item 35 (OCC WP-K) — rewind menu must not offer "Summarize from
 * here" / "Summarize up to here" when DISABLE_COMPACT is set
 * (byte-verified against the official v310/v311 ELF dumps in /tmp/cc-diff-311;
 * see docs/gap-research-311/triage-T2.md Item 35).
 *
 * Official pass-through gate (the fix site):
 *   v310 @273155312: `onSummarize: x.runsNoModelTurn ? void 0 : x.handleSummarize`
 *   v311 @274792948: `onSummarize: x.runsNoModelTurn || Le(process.env.DISABLE_COMPACT) ? void 0 : x.handleSummarize`
 * `Le` @238646027 is the official env-truthy parser:
 *   `function Le(e){if(!e)return!1;if(typeof e==="boolean")return e;
 *     let n=String(e).toLowerCase().trim();return["1","true","yes","on"].includes(n)}`
 * — byte-equivalent to OCC's `isEnvTruthy` (src/utils/envUtils.ts).
 * `runsNoModelTurn` has no OCC analogue (grep → 0 hits), so only the
 * DISABLE_COMPACT half of the guard is portable (declared deviation).
 *
 * Official menu gate (unchanged v310→v311, `UUe`@273140600 ≡ `aWe`@274776200):
 *   `if(Z) zr.push({value:"summarize",label:"Summarize from here",…}),
 *          zr.push({value:"summarize_up_to",label:"Summarize up to here",…})`
 *   (@274778600 dump; Z = destructured onSummarize prop) — both summarize
 *   options are gated on the handler's PRESENCE.
 *
 * OCC port: REPL.tsx:5355 passes the handler through the isEnvTruthy gate;
 * MessageSelector's onSummarize becomes optional and buildRestoreOptions
 * gates both summarize options on its presence (the pre-existing ant-only
 * gate on summarize_up_to is an OCC divergence preserved as-is).
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { isEnvTruthy } from '../../utils/envUtils.js';

const MESSAGE_SELECTOR_PATH = path.join(import.meta.dir, '..', 'MessageSelector.tsx');
const REPL_PATH = path.join(import.meta.dir, '..', '..', 'screens', 'REPL.tsx');
const messageSelectorSource = await Bun.file(MESSAGE_SELECTOR_PATH).text();
const replSource = await Bun.file(REPL_PATH).text();

const { buildRestoreOptions } = await import('../MessageSelector.js');

const SUMMARIZE_INPUT_PROPS = {
  type: 'input' as const,
  placeholder: 'add context (optional)',
  initialValue: '',
  allowEmptySubmitToCancel: true,
  showLabelWithValue: true,
  labelValueSeparator: ': ',
};

function buildOptions(overrides: Record<string, unknown> = {}) {
  return buildRestoreOptions({
    canRestoreCode: true,
    hasSummarizeHandler: true,
    isAntBuild: false,
    summarizeInputProps: SUMMARIZE_INPUT_PROPS,
    onChangeSummarizeFrom: () => {},
    onChangeSummarizeUpTo: () => {},
    ...overrides,
  } as Parameters<typeof buildRestoreOptions>[0]);
}

function optionValues(overrides: Record<string, unknown> = {}): string[] {
  return buildOptions(overrides).map((option: { value: string }) => option.value);
}

describe('Item 35 — buildRestoreOptions summarize gate (official v311 aWe `if(Z)` port)', () => {
  test('onSummarize handler present → "Summarize from here" is offered', () => {
    const options = buildOptions({ hasSummarizeHandler: true });
    const summarize = options.find((option: { value: string }) => option.value === 'summarize');
    expect(summarize).toBeDefined();
    expect((summarize as { label: string }).label).toBe('Summarize from here');
  });

  test('onSummarize handler absent → NO summarize options (the 311 fix)', () => {
    const values = optionValues({ hasSummarizeHandler: false });
    expect(values).not.toContain('summarize');
    expect(values).not.toContain('summarize_up_to');
  });

  test('ant build + handler → both summarize options (official `if(Z)` pushes both)', () => {
    const values = optionValues({ hasSummarizeHandler: true, isAntBuild: true });
    expect(values).toContain('summarize');
    expect(values).toContain('summarize_up_to');
  });

  test('external build + handler → summarize_up_to stays ant-gated (pre-existing OCC divergence)', () => {
    const values = optionValues({ hasSummarizeHandler: true, isAntBuild: false });
    expect(values).toContain('summarize');
    expect(values).not.toContain('summarize_up_to');
  });

  test('restore options still lead and "Never mind" always closes the list', () => {
    expect(optionValues({ canRestoreCode: true, hasSummarizeHandler: false })).toEqual([
      'both',
      'conversation',
      'code',
      'nevermind',
    ]);
    expect(optionValues({ canRestoreCode: false, hasSummarizeHandler: false })).toEqual([
      'conversation',
      'nevermind',
    ]);
    expect(optionValues({ canRestoreCode: true, hasSummarizeHandler: true })).toEqual([
      'both',
      'conversation',
      'code',
      'summarize',
      'nevermind',
    ]);
  });
});

describe('Item 35 — REPL pass-through gate semantics (official v311 `Le(process.env.DISABLE_COMPACT)?void 0:…`)', () => {
  // Mirrors the REPL gate: isEnvTruthy(env) ? undefined : handler, then the
  // menu gate: handler undefined → no summarize options.
  function summarizeOfferedForEnv(value: string | undefined): boolean {
    const onSummarize = isEnvTruthy(value) ? undefined : async () => {};
    return optionValues({ hasSummarizeHandler: onSummarize !== undefined }).includes('summarize');
  }

  test('env-truthy DISABLE_COMPACT values hide the summarize menu', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(summarizeOfferedForEnv(value)).toBe(false);
    }
  });

  test('falsy / unset DISABLE_COMPACT keeps the summarize menu', () => {
    for (const value of ['0', 'false', 'no', 'off', '', '2', undefined]) {
      expect(summarizeOfferedForEnv(value)).toBe(true);
    }
  });
});

describe('Item 35 — source wiring', () => {
  test('MessageSelector onSummarize prop is optional', () => {
    expect(messageSelectorSource).toContain('onSummarize?: (message: UserMessage');
  });

  test('REPL passes onSummarize through the DISABLE_COMPACT env gate', () => {
    expect(replSource).toContain('onSummarize={');
    expect(replSource).toContain(
      'isEnvTruthy(process.env.DISABLE_COMPACT) ? undefined : async (message: UserMessage, feedback?: string, direction: PartialCompactDirection = \'from\') => {',
    );
  });

  test('REPL no longer passes onSummarize unconditionally', () => {
    expect(replSource).not.toContain('onSummarize={async (message: UserMessage');
  });
});
