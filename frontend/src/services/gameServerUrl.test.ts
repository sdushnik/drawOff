import { describe, expect, it } from "vitest";
import { resolveGameServerUrl } from "./gameServerUrl";

describe("resolveGameServerUrl", () => {
  it("prefers an explicitly configured server", () => {
    expect(resolveGameServerUrl({
      configuredUrl: "https://api.example.test",
      isProduction: true,
      browserOrigin: "https://draw.example.test",
    })).toBe("https://api.example.test");
  });

  it("uses the browser origin in an unconfigured production build", () => {
    expect(resolveGameServerUrl({
      isProduction: true,
      browserOrigin: "https://draw.example.test",
    })).toBe("https://draw.example.test");
  });

  it("keeps the browser mock default during unconfigured development", () => {
    expect(resolveGameServerUrl({ isProduction: false })).toBeUndefined();
  });
});
