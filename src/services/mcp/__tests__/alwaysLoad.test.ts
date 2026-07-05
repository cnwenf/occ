import { describe, expect, test } from "bun:test";
import {
  McpStdioServerConfigSchema,
  McpSSEServerConfigSchema,
  McpHTTPServerConfigSchema,
  McpWebSocketServerConfigSchema,
} from "../types";

/**
 * claude-code 2.1.121: `alwaysLoad` option on MCP server config — when true,
 * all tools from that server skip tool-search deferral.
 */
describe("2.1.121 alwaysLoad MCP server config", () => {
  test("stdio accepts alwaysLoad", () => {
    expect(
      McpStdioServerConfigSchema().safeParse({
        command: "echo",
        args: [],
        alwaysLoad: true,
      }).success,
    ).toBe(true);
  });
  test("sse accepts alwaysLoad", () => {
    expect(
      McpSSEServerConfigSchema().safeParse({
        type: "sse",
        url: "https://example.com",
        alwaysLoad: true,
      }).success,
    ).toBe(true);
  });
  test("http accepts alwaysLoad", () => {
    expect(
      McpHTTPServerConfigSchema().safeParse({
        type: "http",
        url: "https://example.com",
        alwaysLoad: true,
      }).success,
    ).toBe(true);
  });
  test("ws accepts alwaysLoad", () => {
    expect(
      McpWebSocketServerConfigSchema().safeParse({
        type: "ws",
        url: "wss://example.com",
        alwaysLoad: true,
      }).success,
    ).toBe(true);
  });
  test("omitted alwaysLoad is valid", () => {
    expect(
      McpStdioServerConfigSchema().safeParse({
        command: "echo",
        args: [],
      }).success,
    ).toBe(true);
  });
});
