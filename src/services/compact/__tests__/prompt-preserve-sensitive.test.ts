import { describe, expect, test } from "bun:test";
import { getCompactPrompt, getPartialCompactPrompt } from "../prompt.js";

// 2.1.139 (J15): the compaction prompt must contain a preserve-sensitive
// directive so security-relevant user instructions/constraints survive
// compaction verbatim and continue to apply afterwards.
const PRESERVE_SENSITIVE_DIRECTIVE =
  "Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.";

describe("compaction preserve-sensitive directive (J15)", () => {
  test("getCompactPrompt contains the preserve-sensitive directive", () => {
    // Arrange — the base (full-conversation) compaction prompt

    // Act
    const prompt = getCompactPrompt();

    // Assert
    expect(prompt).toContain(PRESERVE_SENSITIVE_DIRECTIVE);
  });

  test("getPartialCompactPrompt contains the preserve-sensitive directive", () => {
    // Arrange — the partial (recent-messages) compaction prompt

    // Act
    const prompt = getPartialCompactPrompt();

    // Assert
    expect(prompt).toContain(PRESERVE_SENSITIVE_DIRECTIVE);
  });
});
