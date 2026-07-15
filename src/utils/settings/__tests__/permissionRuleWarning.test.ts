import { describe, expect, test } from "bun:test";
import { validatePermissionRule } from "../permissionValidation";

describe("validatePermissionRule: Write/Glob startup warning (2.1.210 #2)", () => {
  describe("Write(path) rules produce warning", () => {
    test("Write(./src/app.ts) warns to use Edit(path)", () => {
      const result = validatePermissionRule("Write(./src/app.ts)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("Write(./src/app.ts)");
      expect(result.warning).toContain("Edit(path)");
      expect(result.warning).toContain("Use Edit(./src/app.ts) instead");
      expect(result.warning).toContain("file-editing tools");
    });

    test("Write(config.json) warns", () => {
      const result = validatePermissionRule("Write(config.json)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("Edit(config.json)");
    });
  });

  describe("NotebookEdit(path) rules produce warning", () => {
    test("NotebookEdit(notebook.ipynb) warns to use Edit(path)", () => {
      const result = validatePermissionRule("NotebookEdit(notebook.ipynb)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("NotebookEdit(notebook.ipynb)");
      expect(result.warning).toContain("Edit(path)");
      expect(result.warning).toContain("Use Edit(notebook.ipynb) instead");
    });
  });

  describe("MultiEdit(path) rules produce warning", () => {
    test("MultiEdit(file.ts) warns to use Edit(path)", () => {
      const result = validatePermissionRule("MultiEdit(file.ts)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("MultiEdit(file.ts)");
      expect(result.warning).toContain("Edit(path)");
    });
  });

  describe("Glob(path) rules produce warning", () => {
    test("Glob(**/*.ts) warns to use Read(path)", () => {
      const result = validatePermissionRule("Glob(**/*.ts)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("Glob(**/*.ts)");
      expect(result.warning).toContain("Read(path)");
      expect(result.warning).toContain("Use Read(**/*.ts) instead");
      expect(result.warning).toContain("file-reading tools");
    });

    test("Glob(src/**) warns to use Read(path)", () => {
      const result = validatePermissionRule("Glob(src/**)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("Read(src/**) instead");
    });
  });

  describe("Edit and Read rules do NOT produce warning", () => {
    test("Edit(./src/app.ts) is valid with no warning", () => {
      const result = validatePermissionRule("Edit(./src/app.ts)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    test("Read(./src/app.ts) is valid with no warning", () => {
      const result = validatePermissionRule("Read(./src/app.ts)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("Bash and other tools do NOT produce warning", () => {
    test("Bash(npm install) is valid with no warning", () => {
      const result = validatePermissionRule("Bash(npm install)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    test("Bash(npm:*) is valid with no warning", () => {
      const result = validatePermissionRule("Bash(npm:*)");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("rules with :* content do NOT produce warning", () => {
    test("Write(./src:*) produces an error (not warning) because :* is invalid for file tools", () => {
      const result = validatePermissionRule("Write(./src:*)");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.warning).toBeUndefined();
    });

    test("Glob(./src:*) produces an error (not warning) because :* is invalid for file tools", () => {
      const result = validatePermissionRule("Glob(./src:*)");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.warning).toBeUndefined();
    });
  });

  describe("bare tool names (no path) do NOT produce warning", () => {
    test("Write alone is valid with no warning", () => {
      const result = validatePermissionRule("Write");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    test("Glob alone is valid with no warning", () => {
      const result = validatePermissionRule("Glob");
      expect(result.valid).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("warning text matches binary verbatim", () => {
    test("exact warning text for Write(./src/app.ts)", () => {
      const result = validatePermissionRule("Write(./src/app.ts)");
      expect(result.warning).toBe(
        "Write(./src/app.ts) is not matched by file permission checks \u2014 only Edit(path) rules are. Use Edit(./src/app.ts) instead (Edit rules cover all file-editing tools).",
      );
    });

    test("exact warning text for Glob(src/**)", () => {
      const result = validatePermissionRule("Glob(src/**)");
      expect(result.warning).toBe(
        "Glob(src/**) is not matched by file permission checks \u2014 only Read(path) rules are. Use Read(src/**) instead (Read rules cover all file-reading tools).",
      );
    });
  });
});
