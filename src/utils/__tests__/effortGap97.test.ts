import { afterEach, describe, expect, test } from "bun:test";
import {
  getDefaultEffortForModel,
  getDisplayedEffortLevel,
  getEffortLevelDescription,
  getEffortSuffix,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolveAppliedEffort,
  toPersistableEffort,
} from "../effort";
import { modelSupportsAdaptiveThinking } from "../thinking";
import { getModelMaxOutputTokens } from "../context";
import { executeEffort } from "../../commands/effort/effort";
import { SettingsSchema } from "../settings/types";
import { cycleEffortLevel } from "../../components/ModelPicker";

/**
 * OCC-97 (2026-08-18 self-acceptance round) — Gap-97c / Gap-97d fixes.
 *
 * Ground truth: the official 2.1.233 binary (behavioral REPL probes +
 * byte-verified strings and model registry).
 *
 * Gap-97c: xhigh must persist, display verbatim (no model downgrade in the
 * UI), and have its official description texts.
 * Gap-97d: opus-4-7/opus-4-8/sonnet-5/fable-5 carry effort/max_effort/
 * xhigh_effort/adaptive_thinking capabilities and 64k/128k output limits;
 * opus-4-7's default effort is xhigh.
 * Gap-97g: settings + SDK schemas accept the official effort enums
 * (settings: low/medium/high/xhigh — never max; SDK surfaces: all five).
 * Gap-97h: the model picker effort cycle includes xhigh (official `VXm`).
 */

const SAVED_EFFORT_ENV = process.env.CLAUDE_CODE_EFFORT_LEVEL;
afterEach(() => {
  if (SAVED_EFFORT_ENV === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = SAVED_EFFORT_ENV;
  }
});

describe("Gap-97c: xhigh persistence", () => {
  test("toPersistableEffort keeps xhigh (official persists it to settings.json)", () => {
    expect(toPersistableEffort("xhigh")).toBe("xhigh");
  });

  test("toPersistableEffort still drops max for non-ants", () => {
    delete process.env.USER_TYPE;
    expect(toPersistableEffort("max")).toBeUndefined();
  });

  test("toPersistableEffort keeps low/medium/high", () => {
    expect(toPersistableEffort("low")).toBe("low");
    expect(toPersistableEffort("medium")).toBe("medium");
    expect(toPersistableEffort("high")).toBe("high");
  });
});

describe("Gap-97c: display shows the configured effort verbatim", () => {
  test("getDisplayedEffortLevel shows xhigh even on a non-xhigh model", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    // sonnet-4-6 supports effort but NOT xhigh — official still renders the
    // configured xhigh chip verbatim (probe: settings effortLevel=xhigh on a
    // non-xhigh model shows the xhigh chip, not a downgraded high).
    expect(getDisplayedEffortLevel("claude-sonnet-4-6", "xhigh")).toBe("xhigh");
    expect(getDisplayedEffortLevel("claude-opus-4-6", "max")).toBe("max");
    expect(getDisplayedEffortLevel("claude-sonnet-4-6", "low")).toBe("low");
  });

  test("getDisplayedEffortLevel falls back to high when nothing is configured", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(getDisplayedEffortLevel("claude-sonnet-4-6", undefined)).toBe("high");
  });

  test("getEffortSuffix shows the configured level verbatim", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(getEffortSuffix("claude-sonnet-4-6", "xhigh")).toBe(" with xhigh effort");
    expect(getEffortSuffix("claude-sonnet-4-6", "medium")).toBe(" with medium effort");
    expect(getEffortSuffix("claude-sonnet-4-6", undefined)).toBe("");
  });

  test("resolveAppliedEffort (API path) still downgrades xhigh on non-xhigh models", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(resolveAppliedEffort("claude-opus-4-7", "xhigh")).toBe("xhigh");
  });
});

describe("Gap-97c: official effort description texts (byte-verified)", () => {
  test("xhigh description matches the official TU_ table", () => {
    expect(getEffortLevelDescription("xhigh")).toBe(
      "Deeper reasoning than high, just below maximum (Fable 5, Opus 4.7+, Sonnet 5)",
    );
  });

  test("max description matches the official TU_ table", () => {
    expect(getEffortLevelDescription("max")).toBe(
      "Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.",
    );
  });

  test("low/medium/high descriptions are unchanged", () => {
    expect(getEffortLevelDescription("low")).toBe(
      "Quick, straightforward implementation with minimal overhead",
    );
    expect(getEffortLevelDescription("medium")).toBe(
      "Balanced approach with standard implementation and testing",
    );
    expect(getEffortLevelDescription("high")).toBe(
      "Comprehensive implementation with extensive testing and documentation",
    );
  });
});

describe("Gap-97c: /effort argument surface", () => {
  test("invalid argument message lists xhigh in official order", () => {
    // Arrange / Act — invalid args take the side-effect-free path.
    const result = executeEffort("bogus");

    // Assert
    expect(result.message).toBe(
      "Invalid argument: bogus. Valid options are: low, medium, high, xhigh, max, ultracode, auto",
    );
  });
});

describe("Gap-97d: official 2.1.233 model registry capability ports", () => {
  test("modelSupportsEffort covers the registry effort models", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
    ]) {
      expect(modelSupportsEffort(model)).toBe(true);
    }
  });

  test("modelSupportsMaxEffort covers the registry max_effort models", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
    ]) {
      expect(modelSupportsMaxEffort(model)).toBe(true);
    }
  });

  test("modelSupportsXhighEffort covers the registry xhigh_effort models", () => {
    for (const model of [
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
    ]) {
      expect(modelSupportsXhighEffort(model)).toBe(true);
    }
    // sonnet-4-6 / opus-4-6 have no xhigh_effort capability.
    expect(modelSupportsXhighEffort("claude-sonnet-4-6")).toBe(false);
    expect(modelSupportsXhighEffort("claude-opus-4-6")).toBe(false);
  });

  test("modelSupportsAdaptiveThinking covers opus-4-7/opus-4-8/sonnet-5", () => {
    for (const model of ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"]) {
      expect(modelSupportsAdaptiveThinking(model)).toBe(true);
    }
  });

  test("getDefaultEffortForModel returns xhigh for opus-4-7 (registry default_effort)", () => {
    delete process.env.USER_TYPE;
    expect(getDefaultEffortForModel("claude-opus-4-7")).toBe("xhigh");
  });

  test("resolveAppliedEffort sends xhigh by default for opus-4-7", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    delete process.env.USER_TYPE;
    expect(resolveAppliedEffort("claude-opus-4-7", undefined)).toBe("xhigh");
  });
});

describe("Gap-97d: max output tokens match the registry (64k/128k launch models)", () => {
  test("opus-4-7/opus-4-8/opus-5/sonnet-5/fable-5 get 64000/128000", () => {
    for (const model of [
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
    ]) {
      expect(getModelMaxOutputTokens(model)).toEqual({
        default: 64_000,
        upperLimit: 128_000,
      });
    }
  });

  test("sonnet-4-6 keeps its 32000/128000 registry values", () => {
    expect(getModelMaxOutputTokens("claude-sonnet-4-6")).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    });
  });
});

describe("Gap-97g: settings schema accepts the official effort levels", () => {
  test("effortLevel parses low/medium/high/xhigh — the official 2.1.233 enum", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) {
      const parsed = SettingsSchema().safeParse({ effortLevel: level });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.effortLevel).toBe(level);
      }
    }
  });

  test("effortLevel max is dropped — the official schema never persists max", () => {
    // .catch(undefined): parse succeeds, value discarded (matches the binary).
    const parsed = SettingsSchema().safeParse({ effortLevel: "max" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.effortLevel).toBeUndefined();
    }
  });
});

describe("Gap-97h: model picker effort cycle matches the official VXm", () => {
  test("xhigh sits between high and max when the model supports both", () => {
    // Arrange / Act / Assert — full-capability model (e.g. opus-4-7).
    expect(cycleEffortLevel("high", "right", true, true)).toBe("xhigh");
    expect(cycleEffortLevel("xhigh", "right", true, true)).toBe("max");
    expect(cycleEffortLevel("xhigh", "left", true, true)).toBe("high");
    expect(cycleEffortLevel("max", "left", true, true)).toBe("xhigh");
    // wraparound
    expect(cycleEffortLevel("max", "right", true, true)).toBe("low");
    expect(cycleEffortLevel("low", "left", true, true)).toBe("max");
  });

  test("xhigh is skipped when the model lacks xhigh_effort", () => {
    // max-capable but no xhigh (e.g. opus-4-6 / sonnet-4-6).
    expect(cycleEffortLevel("high", "right", true, false)).toBe("max");
    expect(cycleEffortLevel("max", "left", true, false)).toBe("high");
  });

  test("a configured level the model can't take clamps to high", () => {
    // Official clamp: current==='xhigh' && !includeXhigh → 'high' before cycling.
    expect(cycleEffortLevel("xhigh", "right", true, false)).toBe("max");
    expect(cycleEffortLevel("max", "right", false, false)).toBe("low");
  });

  test("clamp applies before cycling on a minimal-capability model", () => {
    // No xhigh, no max (e.g. a base model): xhigh clamps to 'high', then the
    // right step wraps the three-level list to 'low'. The official last-entry
    // fallback (levels.length-1) stays in place for values that survive the
    // clamp without a list slot (e.g. 'ultracode' once that cycles).
    expect(cycleEffortLevel("xhigh", "right", false, false)).toBe("low");
  });
});
