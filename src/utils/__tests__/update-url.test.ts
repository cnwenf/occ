import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// 测试文件位于 src/utils/__tests__/，源文件在 src/utils/。
// 用 import.meta.dir 相对定位，避免硬编码绝对路径（CI 上仓库不在 /root/code/occ）。
const UTILS_DIR = join(import.meta.dir, "..");

/**
 * claude-code 2.1.116: update URL moved from storage.googleapis.com to
 * downloads.claude.ai/claude-code-releases.
 */
describe("2.1.116 update URL replacement", () => {
  test("autoUpdater uses downloads.claude.ai", async () => {
    const src = await Bun.file(join(UTILS_DIR, "autoUpdater.ts")).text();
    expect(src).toContain("https://downloads.claude.ai/claude-code-releases");
    expect(src).not.toContain("storage.googleapis.com/claude-code-dist");
  });

  test("nativeInstaller download uses downloads.claude.ai", async () => {
    const src = await Bun.file(
      join(UTILS_DIR, "nativeInstaller", "download.ts"),
    ).text();
    expect(src).toContain("https://downloads.claude.ai/claude-code-releases");
    expect(src).not.toContain("storage.googleapis.com/claude-code-dist");
  });
});
