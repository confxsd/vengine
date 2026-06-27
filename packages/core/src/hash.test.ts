import { describe, it, expect } from "vitest";
import { stableStringify, hashValue, sha256 } from "./hash.js";

describe("hash", () => {
  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("stableStringify drops undefined", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("hashValue is stable and discriminating", () => {
    expect(hashValue({ x: 1 })).toBe(hashValue({ x: 1 }));
    expect(hashValue({ x: 1 })).not.toBe(hashValue({ x: 2 }));
  });

  it("sha256 matches known vector", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
