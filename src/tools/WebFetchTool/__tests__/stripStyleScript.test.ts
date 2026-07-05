import { describe, expect, test } from "bun:test";
import { getTurndownService } from "../utils";

/**
 * claude-code 2.1.105: WebFetch strips <style>/<script>/<noscript>/<iframe>
 * contents so CSS-heavy pages don't exhaust the content budget before reaching
 * actual text. Verified against v105's `.remove(["style","script","noscript","iframe"])`.
 */
describe("2.1.105 WebFetch strips style/script/noscript/iframe", () => {
  test("style and script contents are removed, body text kept", async () => {
    const td = await getTurndownService();
    const html =
      '<html><head><style>body{color:red}.x{display:none}</style>' +
      '<script>console.log("secret")</script></head>' +
      '<body><h1>Title</h1><p>Hello world</p></body></html>';
    const md = td.turndown(html);
    expect(md).toContain("Title");
    expect(md).toContain("Hello world");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("secret");
    expect(md).not.toContain("console.log");
  });

  test("noscript and iframe contents are removed", async () => {
    const td = await getTurndownService();
    const html =
      '<body><p>visible</p><noscript>fallback content</noscript>' +
      '<iframe src="https://evil.example/x">iframe-fallback</iframe></body>';
    const md = td.turndown(html);
    expect(md).toContain("visible");
    expect(md).not.toContain("fallback content");
    expect(md).not.toContain("evil.example");
  });

  test("plain HTML without style/script is unaffected", async () => {
    const td = await getTurndownService();
    const md = td.turndown("<body><h1>Hi</h1><p>there</p></body>");
    expect(md).toContain("Hi");
    expect(md).toContain("there");
  });
});
