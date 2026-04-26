import { describe, test, expect } from "vitest";
import { toggleHiddenInArgs } from "./cells-edit.ts";

describe("toggleHiddenInArgs", () => {
  test("appends hidden: true when no attribute exists", () => {
    expect(toggleHiddenInArgs(`id: "x", lang: "python"`)).toBe(
      `id: "x", lang: "python", hidden: true`,
    );
  });

  test("appends hidden: true when args is empty", () => {
    expect(toggleHiddenInArgs(``)).toBe(`hidden: true`);
  });

  test("flips hidden: false to hidden: true", () => {
    expect(toggleHiddenInArgs(`id: "x", lang: "python", hidden: false`)).toBe(
      `id: "x", lang: "python", hidden: true`,
    );
  });

  test("removes hidden: true when toggled off (trailing position)", () => {
    expect(toggleHiddenInArgs(`id: "x", lang: "python", hidden: true`)).toBe(
      `id: "x", lang: "python"`,
    );
  });

  test("removes hidden: true when in middle of args", () => {
    expect(toggleHiddenInArgs(`id: "x", hidden: true, lang: "python"`)).toBe(
      `id: "x", lang: "python"`,
    );
  });

  test("toggle is a round-trip identity for unrelated args", () => {
    const original = `id: "primes", lang: "python"`;
    const once = toggleHiddenInArgs(original);
    const twice = toggleHiddenInArgs(once);
    expect(twice).toBe(original);
  });
});
