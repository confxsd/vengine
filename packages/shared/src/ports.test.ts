import { describe, it, expect } from "vitest";
import { arePortsCompatible } from "./ports.js";

describe("arePortsCompatible", () => {
  it("matches identical types", () => {
    expect(arePortsCompatible("image", "image")).toBe(true);
  });

  it("allows declared widenings", () => {
    expect(arePortsCompatible("image", "imageBatch")).toBe(true);
    expect(arePortsCompatible("image", "reference")).toBe(true);
    expect(arePortsCompatible("int", "number")).toBe(true);
    expect(arePortsCompatible("string", "prompt")).toBe(true);
  });

  it("rejects incompatible types", () => {
    expect(arePortsCompatible("image", "number")).toBe(false);
    expect(arePortsCompatible("mask", "image")).toBe(false);
  });
});
